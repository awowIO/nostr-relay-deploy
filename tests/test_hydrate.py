"""Witnesses for nostr-relay-deploy.

What is exercised for real, and how:
  - hydrate.py runs as the operator runs it: a subprocess on a copy of this repository,
    with real git for --check-clean (working tree, index, history) and a real HTTP server
    on loopback for --verify, behind a recording proxy that must see no traffic.
  - The Cloudflare Worker's own TypeScript runs under Node (tests/worker_harness.mjs)
    with real SQLite, real loopback HTTP and RFC 6455 frames, and is driven by a client
    here that signs with the BIP-340 reference algorithm, itself pinned to the published
    BIP-340 vectors. scripts/cf_ncli_shim.py runs as a subprocess against it with the exact
    argv nostr-mailbox's `--exec` sends.
  - The three edge filters (Caddyfile, Traefik IngressRoute, Worker) are held to one
    route table: the first two by evaluating their hydrated rules, the Worker by
    fetching through its real handler.
  - `kubectl kustomize` (offline) builds the hydrated Kubernetes trees, with and without
    the Web Console, when kubectl is installed.
  - When a Docker daemon answers, the pinned console image serves the hydrated console
    as console.yaml runs it (UID 101, read-only root, no capabilities), and is held to the
    Worker's page and headers.
  - Both pages' whole scripts run under Node against a stand-in DOM and fetch (a test
    double, named as one): what they send at boot, on a pasted invite, on the Pair form,
    and how they read each MayWe answer.
  - When a Docker daemon answers, the pinned ncli release itself: `ncli relay --check`
    on the hydrated relay.yaml, and a live ncli relay booted on it. The self-service
    scenarios (member-minted invites, NIP-29 groups, recipient-only kinds, what `/`
    answers) run against that relay and against the Worker, with the same assertions,
    so the Worker is held to what the relay the other two targets deploy actually does.

Not covered here, said plainly: `--apply` against a cluster (its real-contact path is an
operator's first apply, which runs a server-side dry run before it mutates anything);
the Workers runtime itself (WebSocketPair, hibernation, Durable Object routing, R2; the
harness stands in for those); Caddy and Traefik binaries; `docker compose config`; the
console, the OAuth consent page and the GitHub Pages page in a browser (their scripts are
syntax-checked by Node; the invite-link reader, the console's nm1_ token packer and its
connection URLs run under Node, and the packer's tokens are redeemed by a real MCP client
and nostr-mailbox's CLI; the consent form is posted as a browser posts it, and the CSP
hashes are checked; but no browser runs them, so the Mint button's DOM wiring, the NIP-07
signer, localStorage (a remembered token, the room keys, the theme) and a browser's
form-action check on a redirect are not exercised); and a real ChatGPT or Claude.ai client (the OAuth sign-in is
driven step by step as the MCP authorization spec has a client make it). Without Docker the ncli witnesses are SKIPPED, and
nothing else here proves agreement with ncli.
Set NOSTR_MAILBOX_SRC=<nostr-mailbox checkout>/skills/nostr-mailbox to also run
nostr-mailbox's own client, admin wrapper and Blossom client against the Worker, and its
CLI (`setup`, `invite`, `join '<join_url>'`, `relay check`) against both relays.
"""
from __future__ import annotations

import base64
import hashlib
import html.parser
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hydrate
from cf_ncli_shim import duration_seconds
from nostr_testkit import (
    Harness,
    Key,
    N,
    WsClient,
    event_is_signed,
    node_problem,
    pubkey_gen,
    schnorr_sign,
    schnorr_verify,
)

RELAY_HOST = "relay.example.com"
SHIM = REPO / "scripts" / "cf_ncli_shim.py"
ADMIN_TOKEN = hashlib.sha256(b"nostr-relay-deploy test admin token").hexdigest()
# The Worker's RELAY_SIGNING_KEY in these tests, and the public key NIP-11 must name.
RELAY_KEY = hashlib.sha256(b"nostr-relay-deploy test relay signing key").hexdigest()
RELAY_PUBKEY = pubkey_gen(bytes.fromhex(RELAY_KEY)).hex()
NCLI_CONFIG = "/app/ncli/relay.yaml"          # what nostr-mailbox appends after `--config`
NIP19_NPUB = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg"
NIP19_HEX = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e"
# A fictional operator environment. None of it may reach anything Git would publish.
PRIVATE = {
    "relay_host": "relay.intranet-zeta.test",
    "storage_class": "zeta-retain-ssd",
    "priority_class": "zeta-platform-critical",
    "forbidden": "zeta-corp",
}


# ============================================================================ helpers
def example_dict() -> dict:
    return tomllib.loads((REPO / "relay.toml.example").read_text())


def dump_toml(data: dict) -> str:
    def value(v) -> str:
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return repr(v)
        if isinstance(v, str):
            return json.dumps(v)
        if isinstance(v, list):
            return "[" + ", ".join(value(x) for x in v) + "]"
        if isinstance(v, dict):
            return "{ " + ", ".join(f"{json.dumps(k)} = {value(x)}" for k, x in v.items()) + " }"
        raise TypeError(v)

    lines = [f"{k} = {value(v)}" for k, v in data.items() if not isinstance(v, dict)]
    for section, table in data.items():
        if isinstance(table, dict):
            lines += ["", f"[{section}]", *(f"{k} = {value(v)}" for k, v in table.items())]
    return "\n".join(lines) + "\n"


def private_config(**sections) -> dict:
    data = example_dict()
    data["relay_host"] = PRIVATE["relay_host"]
    data["kubernetes"].update(storage_class=PRIVATE["storage_class"], priority_class=PRIVATE["priority_class"],
                              traefik_egress_network_policy=True)
    data["hygiene"]["forbidden_tokens"] = [PRIVATE["forbidden"]]
    for name, values in sections.items():
        if name in data and isinstance(data[name], dict):
            data[name].update(values)
        else:
            data[name] = values
    return data


def copy_repo(dest: Path) -> Path:
    """The publishable parts of this repository, copied to a scratch directory."""
    ignore = shutil.ignore_patterns("__pycache__", ".build", "*.local.toml")
    for name in ("scripts", "templates"):
        shutil.copytree(REPO / name, dest / name, ignore=ignore)
    for name in ("relay.toml.example", ".gitignore", "pyproject.toml", "LICENSE", "README.md"):
        if (REPO / name).exists():
            shutil.copy2(REPO / name, dest / name)
    return dest


def run_cli(ws: Path, *args: str, env: dict | None = None, expect: int | None = 0) -> subprocess.CompletedProcess:
    done = subprocess.run([sys.executable, str(ws / "scripts" / "hydrate.py"), *args], cwd=ws,
                          capture_output=True, text=True, env=env, check=False)
    if expect is not None and done.returncode != expect:
        pytest.fail(f"hydrate.py {' '.join(args)} exited {done.returncode}, wanted {expect}\n"
                    f"stdout:\n{done.stdout}\nstderr:\n{done.stderr}")
    return done


GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
           "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
           "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "test@example.invalid"}


def git(ws: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=ws, env=GIT_ENV, capture_output=True, text=True,
                          check=True).stdout


def git_workspace(dest: Path) -> Path:
    ws = copy_repo(dest)
    git(ws, "init", "-q", "-b", "main")
    git(ws, "add", "-A")
    git(ws, "commit", "-q", "-m", "initial")
    (ws / "relay.local.toml").write_text(dump_toml(private_config()))
    return ws


def run_shim(harness: Harness, *ncli_args: str, token: str | None = ADMIN_TOKEN,
             expect: int | None = 0) -> subprocess.CompletedProcess:
    """The shim exactly as nostr-mailbox runs it: shlex.split(--exec) + `ncli relay ...`."""
    prefix = shlex.split(f"{shlex.quote(sys.executable)} {shlex.quote(str(SHIM))} --url {harness.origin}")
    env = {k: v for k, v in os.environ.items() if k != "ADMIN_TOKEN"}
    if token is not None:
        env["ADMIN_TOKEN"] = token
    done = subprocess.run([*prefix, "ncli", "relay", *ncli_args, "--config", NCLI_CONFIG],
                          capture_output=True, text=True, env=env, check=False)
    if expect is not None and done.returncode != expect:
        pytest.fail(f"cf_ncli_shim {' '.join(ncli_args)} exited {done.returncode}\n{done.stdout}\n{done.stderr}")
    return done


def assert_ncli_invite(invite: dict) -> None:
    """The checks nostr-mailbox's RelayAdmin.create_invite applies before handing an invite out."""
    assert isinstance(invite.get("code"), str) and invite["code"]
    assert invite.get("max_uses") == 1 and invite.get("uses", 0) == 0
    assert type(invite.get("created_at")) is int and type(invite.get("expires_at")) is int
    assert invite["expires_at"] > invite["created_at"]


def _flow_value(text: str):
    if text.startswith("[") and text.endswith("]"):
        return [_flow_value(item.strip()) for item in text[1:-1].split(",") if item.strip()]
    if text in ("true", "false"):
        return text == "true"
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if text.startswith('"'):
        return json.loads(text)
    return text


def relay_settings(text: str) -> dict:
    """The settings of a hydrated relay.yaml by dotted path ("groups.roles.admin"): enough
    YAML for this file's block mappings, scalars and flow lists, with comments dropped."""
    settings: dict = {}
    parents: list[tuple[int, str]] = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        line = re.sub(r"\s+#.*$", "", raw)
        indent = len(line) - len(line.lstrip())
        key, _, value = line.strip().partition(":")
        while parents and parents[-1][0] >= indent:
            parents.pop()
        path = ".".join([*(name for _, name in parents), key])
        if value.strip():
            settings[path] = _flow_value(value.strip())
        else:
            parents.append((indent, key))
    return settings


_key_counter = iter(range(1000, 10**6))


def fresh_key() -> Key:
    return Key.numbered(next(_key_counter))


def authenticate(ws, key: Key, *, created_at: int | None = None) -> None:
    verb, challenge = ws.recv()
    assert verb == "AUTH"
    proof = key.event(22242, [["relay", f"wss://{RELAY_HOST}"], ["challenge", challenge]], created_at=created_at)
    ws.send(["AUTH", proof])
    assert ws.recv() == ["OK", proof["id"], True, ""]


def publish(ws, event: dict) -> list:
    ws.send(["EVENT", event])
    return ws.recv()


def stored(ws, *filters: dict) -> list[dict]:
    """A REQ read to EOSE, then closed."""
    sub = os.urandom(6).hex()
    ws.send(["REQ", sub, *filters])
    events = []
    while True:
        frame = ws.recv()
        if frame == ["EOSE", sub]:
            ws.send(["CLOSE", sub])
            return events
        assert frame[0] == "EVENT" and frame[1] == sub, frame
        events.append(frame[2])


def nothing_pending(ws) -> None:
    """Prove no frame is queued: the relay answers in order, so the next frame after a
    fresh REQ must be that REQ's EOSE."""
    sub = os.urandom(6).hex()
    ws.send(["REQ", sub, {"ids": ["0" * 64]}])
    assert ws.recv() == ["EOSE", sub]
    ws.send(["CLOSE", sub])


def member(harness: Harness) -> tuple[Key, object]:
    """A fresh key, enrolled through the shim, with an authenticated socket."""
    key = fresh_key()
    run_shim(harness, "members", "add", key.pubkey)
    ws = harness.connect()
    authenticate(ws, key)
    return key, ws


# =========================================================================== fixtures
@pytest.fixture(scope="session")
def example_ws(tmp_path_factory) -> Path:
    ws = copy_repo(tmp_path_factory.mktemp("example"))
    run_cli(ws, "--example", "--target", "all")
    return ws


@pytest.fixture(scope="session")
def build(example_ws) -> Path:
    return example_ws / ".build"


@pytest.fixture(scope="session")
def private_ws(tmp_path_factory) -> Path:
    ws = copy_repo(tmp_path_factory.mktemp("private"))
    (ws / "relay.local.toml").write_text(dump_toml(private_config()))
    run_cli(ws, "--target", "all")
    return ws


def _start_harness(build: Path, **overrides: str | None) -> Harness:
    """The hydrated Worker with wrangler.toml's [vars], the secrets wrangler would add, and
    `overrides` (None removes a variable)."""
    problem = node_problem()
    if problem is not None:
        pytest.skip(problem)
    variables = tomllib.loads((build / "cloudflare" / "wrangler.toml").read_text())["vars"]
    merged = {**variables, "RELAY_SIGNING_KEY": RELAY_KEY, **overrides}
    return Harness(build / "cloudflare" / "src" / "worker.ts", {k: v for k, v in merged.items() if v is not None})


@pytest.fixture(scope="session")
def worker(build):
    harness = _start_harness(build, ADMIN_TOKEN=ADMIN_TOKEN)
    yield harness
    harness.stop()


@pytest.fixture
def tight_worker(build):
    """A Worker with small limits and no ADMIN_TOKEN: rate limits, blob size, hidden admin."""
    harness = _start_harness(build, EVENTS_PER_MINUTE="3", MAX_BLOB_BYTES="16")
    yield harness
    harness.stop()


@pytest.fixture
def limited_worker(build):
    """A Worker with an admin token and three events a minute per key."""
    harness = _start_harness(build, ADMIN_TOKEN=ADMIN_TOKEN, EVENTS_PER_MINUTE="3")
    yield harness
    harness.stop()


@pytest.fixture
def clock(worker):
    """Shift the Worker's clock; always put it back."""
    def shift(seconds: int) -> None:
        worker.control("clock", {"offset_s": seconds})
    yield shift
    shift(0)


# ===================================================================== configuration
def test_the_example_is_a_complete_valid_configuration():
    cfg = hydrate.load_config(REPO / "relay.toml.example")
    assert set(cfg.values) == set(hydrate.SCHEMA)
    for section, fields in hydrate.SCHEMA.items():
        assert set(cfg[section]) == set(fields)
    assert cfg["relay"]["relay_host"] == RELAY_HOST


BAD_VALUES = [
    ("relay", "relay_host", "https://relay.example.com"),
    ("relay", "relay_host", "Relay.Example.com"),
    ("relay", "relay_host", "relay.example.com:443"),
    ("relay", "relay_host", "localhost"),
    ("relay", "relay_host", "-relay.example.com"),
    ("relay", "relay_host", "a" * 64 + ".example.com"),
    ("relay", "relay_host", "relay_1.example.com"),
    ("relay", "relay_name", "two\nlines"),
    ("relay", "events_per_minute", 0),
    ("relay", "events_per_minute", -5),
    ("relay", "events_per_minute", True),
    ("relay", "events_per_minute", "60"),
    ("relay", "max_blob_bytes", 1.5),
    ("relay", "max_uploads_per_signer", 0),
    ("kubernetes", "namespace", "Nostr_Relay"),
    ("kubernetes", "storage_size", "128GB"),
    ("kubernetes", "storage_size", "0"),
    ("kubernetes", "storage_size", 128),
    ("kubernetes", "cpu_request", "-1"),
    ("kubernetes", "memory_limit", "4 Gi"),
    ("kubernetes", "storage_class", "Fast_SSD"),
    ("kubernetes", "priority_class", "high priority"),
    ("kubernetes", "cert_resolver", "le: injected"),
    ("kubernetes", "ingress_priority", 0),
    ("kubernetes", "avoid_control_plane", "yes"),
    ("kubernetes", "traefik_pod_selector", "=traefik"),
    ("kubernetes", "traefik_pod_selector", "app.kubernetes.io/name"),
    ("kubernetes", "traefik_namespace", "traefik system"),
    ("compose", "cpus", "two"),
    ("compose", "cpus", "0"),
    ("compose", "memory_limit", "4 GB"),
    ("cloudflare", "worker_name", "Nostr Relay"),
    ("cloudflare", "r2_bucket", "ab"),
    ("cloudflare", "compatibility_date", "2999-01-01"),
    ("cloudflare", "compatibility_date", "20251101"),
    ("github_pages", "campaign", "My Campaign"),
    ("github_pages", "domain", "https://pages.example.com"),
    ("github_pages", "nip05", {"Alice": NIP19_HEX}),
    ("github_pages", "nip05", {"alice": NIP19_NPUB[:-1] + "h"}),
    ("github_pages", "nip05", {"alice": NIP19_HEX.upper()}),
    ("github_pages", "nip05", {"alice": "nsec1" + NIP19_NPUB[5:]}),
    ("hygiene", "forbidden_tokens", [""]),
    ("hygiene", "forbidden_tokens", "zeta"),
]


@pytest.mark.parametrize("section, key, bad", BAD_VALUES, ids=[f"{s}.{k}={b!r}" for s, k, b in BAD_VALUES])
def test_an_invalid_value_is_refused_by_name(tmp_path, section, key, bad):
    data = example_dict()
    (data if section == "relay" else data[section])[key] = bad
    path = tmp_path / "relay.local.toml"
    path.write_text(dump_toml(data))
    with pytest.raises(hydrate.ConfigError) as caught:
        hydrate.load_config(path)
    assert (key if section == "relay" else f"{section}.{key}") in str(caught.value)


def test_unknown_missing_and_inconsistent_keys_are_refused(tmp_path):
    data = example_dict()
    data["relay_hots"] = RELAY_HOST
    del data["kubernetes"]["namespace"]
    data["kubernetes"]["memory_request"] = "8Gi"
    path = tmp_path / "relay.local.toml"
    path.write_text(dump_toml(data))
    with pytest.raises(hydrate.ConfigError) as caught:
        hydrate.load_config(path)
    message = str(caught.value)
    assert "unknown key 'relay_hots'" in message
    assert "missing key kubernetes.namespace" in message
    data = example_dict()
    data["kubernetes"]["memory_request"] = "8Gi"
    data["kubernets"] = {"namespace": "x"}
    path.write_text(dump_toml(data))
    with pytest.raises(hydrate.ConfigError, match=r"unknown section \[kubernets\]"):
        hydrate.load_config(path)
    del data["kubernets"]
    path.write_text(dump_toml(data))
    with pytest.raises(hydrate.ConfigError, match="memory_request .* larger than"):
        hydrate.load_config(path)


def test_npub_and_hex_public_keys_normalise_to_hex():
    assert hydrate.pubkey_hex(NIP19_NPUB) == NIP19_HEX          # the NIP-19 specification's example
    assert hydrate.pubkey_hex(NIP19_HEX) == NIP19_HEX
    with pytest.raises(ValueError, match="checksum"):
        hydrate.pubkey_hex(NIP19_NPUB[:-1] + "h")


def test_quantities_compare_by_value():
    assert hydrate.quantity_value("4Gi") == 4 * 2**30
    assert hydrate.quantity_value("500m") * 4 == 2
    assert hydrate.quantity_value("1e3") == hydrate.quantity_value("1k")


def test_the_cli_writes_nothing_from_an_invalid_configuration(tmp_path):
    ws = copy_repo(tmp_path)
    data = example_dict()
    data["relay_host"] = "not a host"
    (ws / "relay.local.toml").write_text(dump_toml(data))
    done = run_cli(ws, "--target", "all", expect=2)
    assert "relay_host" in done.stderr
    assert not (ws / ".build").exists()
    done = run_cli(ws, "--config", str(ws / "missing.toml"), "--target", "all", expect=2)
    assert "cp relay.toml.example relay.local.toml" in done.stderr


# ======================================================================= kubernetes
def test_kubernetes_hydrates_the_hardened_statefulset(build):
    k8s = build / "kubernetes"
    expected = {"namespace.yaml", "statefulset.yaml", "service.yaml", "ingressroute.yaml",
                "networkpolicy.yaml", "kustomization.yaml", "relay.yaml", ".hydrated"}
    assert {p.name for p in k8s.iterdir()} == expected
    sts = (k8s / "statefulset.yaml").read_text()
    assert f"image: {hydrate.NCLI_IMAGE}" in sts
    assert "@sha256:fc131ffc2de36b54e2e7598f2ee0cddec1e64a113d85491632c51e3dc988516a" in hydrate.NCLI_IMAGE
    for line in ("runAsNonRoot: true", "runAsUser: 65532", "runAsGroup: 65532", "fsGroup: 65532",
                 "readOnlyRootFilesystem: true", "allowPrivilegeEscalation: false", "capabilities: { drop: [ALL] }",
                 "seccompProfile: { type: RuntimeDefault }", "updateStrategy: { type: OnDelete }", "replicas: 1",
                 "automountServiceAccountToken: false", f'value: "wss://{RELAY_HOST}"',
                 "secretKeyRef: { name: nostr-relay-signing, key: RELAY_SIGNING_KEY }",
                 'requests: { cpu: "2", memory: 4Gi }', "limits: { memory: 4Gi }", "storage: 128Gi",
                 "- key: node-role.kubernetes.io/control-plane"):
        assert line in sts, line
    assert "storageClassName" not in sts and "priorityClassName" not in sts
    route = (k8s / "ingressroute.yaml").read_text()
    assert route.count(f"Host(`{RELAY_HOST}`)") == 3
    assert route.count("priority: 1500") == 3
    assert "tls: { certResolver: le }" in route
    kustomization = (k8s / "kustomization.yaml").read_text()
    resources = re.findall(r"^  - (\S+\.yaml)$", kustomization, re.MULTILINE)
    assert resources == ["namespace.yaml", "statefulset.yaml", "service.yaml", "ingressroute.yaml", "networkpolicy.yaml"]
    assert "      - relay.yaml" in kustomization
    for path in k8s.iterdir():
        assert "{{" not in path.read_text(), path


def test_kubernetes_private_settings_and_the_traefik_egress_policy(private_ws):
    k8s = private_ws / ".build" / "kubernetes"
    sts = (k8s / "statefulset.yaml").read_text()
    assert f"      priorityClassName: {PRIVATE['priority_class']}\n" in sts
    assert f"        accessModes: [ReadWriteOnce]\n        storageClassName: {PRIVATE['storage_class']}\n" in sts
    backend = (k8s / "traefik-networkpolicy.yaml").read_text()
    assert "metadata: { name: nostr-relay-backend, namespace: traefik }" in backend
    assert 'podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } }' in backend
    assert "kubernetes.io/metadata.name: nostr-relay" in backend
    assert "  - traefik-networkpolicy.yaml" in (k8s / "kustomization.yaml").read_text()


def test_rehydrating_removes_only_what_hydration_wrote(tmp_path):
    ws = copy_repo(tmp_path)
    (ws / "relay.local.toml").write_text(dump_toml(private_config()))
    run_cli(ws, "--target", "all")
    operator_files = [ws / ".build" / "compose" / ".env", ws / ".build" / "compose" / "data" / "db" / "relay.db",
                      ws / ".build" / "kubernetes" / "notes.txt"]
    for path in operator_files:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("the operator's own")
    data = private_config()
    data["kubernetes"]["traefik_egress_network_policy"] = False
    data["kubernetes"]["traefik_pod_selector"] = ""
    data["kubernetes"]["traefik_namespace"] = "edge"
    (ws / "relay.local.toml").write_text(dump_toml(data))
    run_cli(ws, "--target", "all")
    k8s = ws / ".build" / "kubernetes"
    assert not (k8s / "traefik-networkpolicy.yaml").exists()
    assert "traefik-networkpolicy" not in (k8s / "kustomization.yaml").read_text()
    policy = (k8s / "networkpolicy.yaml").read_text()
    assert "kubernetes.io/metadata.name: edge" in policy and "podSelector: { matchLabels: { \"app" not in policy
    for path in operator_files:
        assert path.read_text() == "the operator's own", path


def test_profiles_render_separate_configs_and_preserve_other_builds(tmp_path):
    ws = copy_repo(tmp_path)
    run_cli(ws, "--example", "--target", "all")
    build = ws / ".build"

    def snapshot(directory):
        return {p.relative_to(directory): p.read_bytes() for p in directory.rglob("*") if p.is_file()}

    default = {target: snapshot(build / target) for target in hydrate.TARGETS}
    for profile in ("internal", "external"):
        host = f"{profile}.example.test"
        config = f"relay.{profile}.local.toml"
        (ws / config).write_text(dump_toml(private_config(relay_host=host)))
        done = run_cli(ws, "--config", config, "--target", "all", "--profile", profile)
        assert f"--config {config} --profile {profile}" in done.stdout
        for target, output in (("compose", ".env.example"), ("cloudflare", "wrangler.toml"),
                               ("kubernetes", "ingressroute.yaml"), ("github-pages", "index.html")):
            assert host in (build / profile / target / output).read_text()
            assert f".build/{profile}/{target}" in done.stdout

    external = snapshot(build / "external")
    run_cli(ws, "--example", "--target", "all", "--profile", "internal")
    assert not (build / "internal/kubernetes/traefik-networkpolicy.yaml").exists()
    assert snapshot(build / "external") == external
    assert {target: snapshot(build / target) for target in hydrate.TARGETS} == default


@pytest.mark.parametrize("profile", ["", ".", "..", "../external", "/tmp", "two/levels", "compose", "CLOUDFLARE"])
def test_invalid_profiles_are_refused_before_writing(tmp_path, profile):
    ws = copy_repo(tmp_path)
    done = run_cli(ws, "--example", "--target", "all", "--profile", profile, expect=2)
    assert "--profile" in done.stderr
    assert not (ws / ".build").exists()


def test_apply_uses_the_selected_profiles_kustomization_and_context(tmp_path, monkeypatch):
    config = tmp_path / "relay.internal.local.toml"
    config.write_text(dump_toml(private_config(kubernetes={"namespace": "fleet-test", "context": "fleet-test"})))
    monkeypatch.setattr(hydrate, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(hydrate, "BUILD_DIR", tmp_path / ".build")
    calls = []

    def kubectl(argv):
        calls.append(argv)
        return "secret/nostr-relay-signing" if "get" in argv else ""

    monkeypatch.setattr(hydrate, "run_kubectl", kubectl)
    assert hydrate.main(["--config", str(config), "--profile", "internal", "--target", "kubernetes", "--apply"]) == 0
    rendered = tmp_path / ".build/internal/kubernetes"
    assert "namespace: fleet-test" in (rendered / "statefulset.yaml").read_text()
    k = ["kubectl", "--context", "fleet-test"]
    assert calls == [
        [*k, "apply", "-f", str(rendered / "namespace.yaml")],
        [*k, "-n", "fleet-test", "get", "secret", hydrate.SIGNING_SECRET, "--ignore-not-found", "-o", "name"],
        [*k, "apply", "-k", str(rendered), "--dry-run=server"],
        [*k, "apply", "-k", str(rendered)],
    ]


@pytest.mark.skipif(shutil.which("kubectl") is None, reason="kubectl is not installed")
def test_kustomize_builds_the_hydrated_tree(private_ws):
    out = subprocess.run(["kubectl", "kustomize", str(private_ws / ".build" / "kubernetes")],
                         capture_output=True, text=True, check=True).stdout
    names = set(re.findall(r"name: (nostr-relay-config-[a-z0-9]+)", out))
    assert len(names) == 1, "the StatefulSet must mount the ConfigMap kustomize generated"
    assert out.count(names.pop()) == 2
    docs = out.split("\n---\n")
    kinds = [re.search(r"^kind: (\S+)", d, re.MULTILINE).group(1) for d in docs]
    assert sorted(kinds) == sorted(["ConfigMap", "Namespace", "Service", "StatefulSet", "IngressRoute",
                                    "NetworkPolicy", "NetworkPolicy", "NetworkPolicy"])
    deny = next(d for d in docs if "name: nostr-relay-default-deny" in d)
    assert "podSelector: {}" in deny and "- Ingress" in deny and "- Egress" in deny
    assert "ingress:" not in deny and "egress:" not in deny, "denies all, allows nothing"
    backend = next(d for d in docs if "name: nostr-relay-backend" in d)
    assert "namespace: traefik" in backend
    assert "auth_required: true" in next(d for d in docs if d.startswith("apiVersion: v1\ndata:"))


# The Web Console on Kubernetes: one fictional operator's relay rendered twice, once with
# the console beside it and once without, from configurations that differ in nothing else.
CONSOLE_NAMESPACE = "relay-two"


@pytest.fixture(scope="session")
def console_ws(tmp_path_factory) -> Path:
    ws = copy_repo(tmp_path_factory.mktemp("console"))
    for profile, console in (("with-console", True), ("without-console", False)):
        config = f"relay.{profile}.local.toml"
        data = private_config(kubernetes={"namespace": CONSOLE_NAMESPACE, "web_console": console})
        (ws / config).write_text(dump_toml(data))
        run_cli(ws, "--config", config, "--profile", profile, "--target", "all")
    return ws


def console_build(console_ws: Path) -> Path:
    return console_ws / ".build" / "with-console" / "kubernetes"


def test_kubernetes_serves_the_web_console_beside_an_untouched_relay(console_ws, worker):
    k8s, bare = console_build(console_ws), console_ws / ".build" / "without-console" / "kubernetes"
    files = {str(p.relative_to(k8s)) for p in k8s.rglob("*") if p.is_file()}
    assert files == {str(p.relative_to(bare)) for p in bare.rglob("*") if p.is_file()} | {
        "console.yaml", "console/index.html", "console/nginx.conf"}
    # The relay's own objects are byte for byte those of the same relay without a console:
    # turning the console on rolls nothing of the relay and drops no member's socket.
    for name in ("statefulset.yaml", "service.yaml", "networkpolicy.yaml", "namespace.yaml", "relay.yaml"):
        assert (k8s / name).read_text() == (bare / name).read_text(), name
    kustomization = (k8s / "kustomization.yaml").read_text()
    assert re.findall(r"^  - (\S+\.yaml)$", kustomization, re.MULTILINE) == [
        "namespace.yaml", "statefulset.yaml", "service.yaml", "ingressroute.yaml", "networkpolicy.yaml",
        "console.yaml", "traefik-networkpolicy.yaml"]
    assert (f"  - name: {hydrate.CONSOLE_NAME}\n    namespace: {CONSOLE_NAMESPACE}\n    files:\n"
            "      - index.html=console/index.html\n      - nginx.conf=console/nginx.conf\n") in kustomization

    console = (k8s / "console.yaml").read_text()
    deployment, service, policy = console.split("\n---\n")
    assert f"image: {hydrate.CONSOLE_IMAGE}" in deployment and "@sha256:" in hydrate.CONSOLE_IMAGE
    for line in ("kind: Deployment", "replicas: 1", "maxUnavailable: 0", "automountServiceAccountToken: false",
                 "enableServiceLinks: false", "runAsNonRoot: true", "runAsUser: 101", "runAsGroup: 101",
                 "seccompProfile: { type: RuntimeDefault }", "allowPrivilegeEscalation: false",
                 "readOnlyRootFilesystem: true", "capabilities: { drop: [ALL] }",
                 'command: ["nginx", "-c", "/etc/console/nginx.conf", "-g", "daemon off;"]',
                 "requests: { cpu: 1m, memory: 5Mi }", f"      priorityClassName: {PRIVATE['priority_class']}\n",
                 "- key: node-role.kubernetes.io/control-plane"):
        assert line in deployment, line
    manifest = "\n".join(line.split("#", 1)[0] for line in deployment.splitlines())
    for absent in ("secretKeyRef", "persistentVolumeClaim", "volumeClaimTemplates", "limits:", "hostNetwork"):
        assert absent not in manifest, f"the console holds no key, no relay volume and no cap: {absent}"
    assert f"ports: [{{ name: http, port: {hydrate.CONSOLE_PORT}, targetPort: http }}]" in service
    assert f"podSelector: {{ matchLabels: {{ app: {hydrate.CONSOLE_NAME} }} }}" in policy
    assert f"ports: [{{ protocol: TCP, port: {hydrate.CONSOLE_PORT} }}]" in policy and "egress: []" in policy
    assert 'podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } }' in policy

    # Traefik's own egress door, named after the relay's namespace, opens to both pods.
    backend = (k8s / "traefik-networkpolicy.yaml").read_text()
    assert f"metadata: {{ name: {CONSOLE_NAMESPACE}-backend, namespace: traefik }}" in backend
    peers = re.findall(r"- namespaceSelector: \{ matchLabels: \{ kubernetes\.io/metadata\.name: (\S+) \} \}\n"
                       r"\s+podSelector: \{ matchLabels: \{ app: (\S+) \} \}\n\s+ports: \[\{ protocol: TCP, port: (\d+) \}\]",
                       backend)
    assert peers == [(CONSOLE_NAMESPACE, "nostr-relay", "5500"), (CONSOLE_NAMESPACE, hydrate.CONSOLE_NAME, "8080")]
    assert f"name: {CONSOLE_NAMESPACE}-backend" in (k8s / "traefik-networkpolicy.yaml").read_text()

    # The page is the Worker's console, with what only the Worker serves (its MCP server and
    # OAuth sign-in) hidden, and its policy admits the same script and style by hash.
    served = worker.http("GET", "/")[2].decode()
    page = (k8s / "console" / "index.html").read_text()
    markup, script = served.split("<script>", 1)
    assert page == markup.replace('data-edge="worker"', 'data-edge="worker" hidden') + "<script>" + script
    assert page.count('data-edge="worker" hidden') == 3
    hidden = {a.get("id") for t, a in _parsed(page).tags if "hidden" in a and "data-edge" in a}
    assert {"pair-card", "stat-mcp"} <= hidden
    nginx = (k8s / "console" / "nginx.conf").read_text()
    policy_header = re.search(r'add_header Content-Security-Policy "([^"]+)" always;', nginx).group(1)
    worker_policy = csp(worker.http("GET", "/")[1])
    ours = dict(part.strip().split(" ", 1) for part in policy_header.split(";"))
    assert {k: v for k, v in ours.items() if k != "connect-src"} == {
        k: v for k, v in worker_policy.items() if k != "connect-src"}
    assert ours["connect-src"] == f"'self' wss://{PRIVATE['relay_host']} https://newsletter.awow.io"
    assert ours["script-src"] == sha256_source(re.search(r"<script>(.*?)</script>", page, re.DOTALL).group(1))
    for path in ("/", "/join", "/join/", "/docs", "/docs/"):
        assert f"location = {path} {{ try_files /index.html =404; }}" in nginx
    assert "location / { return 404; }" in nginx
    assert not re.search(r"^\s*include\b", nginx, re.MULTILINE), "nothing the image ships decides what is served"
    for path in k8s.rglob("*"):
        assert path.is_dir() or "{{" not in path.read_text(), path


def _parsed(page: str) -> _Collect:
    parsed = _Collect()
    parsed.feed(page)
    return parsed


def test_each_relay_keeps_its_own_traefik_door(tmp_path):
    """Two relays on one cluster live in two namespaces; each one's Traefik egress policy is
    named after its namespace, so applying one never rewrites the other's. The default
    namespace keeps the name a live relay already has."""
    ws = copy_repo(tmp_path)
    for namespace in ("nostr-relay", "relay-two"):
        config = f"relay.{namespace}.local.toml"
        (ws / config).write_text(dump_toml(private_config(kubernetes={"namespace": namespace})))
        run_cli(ws, "--config", config, "--profile", namespace, "--target", "kubernetes")
        backend = (ws / ".build" / namespace / "kubernetes" / "traefik-networkpolicy.yaml").read_text()
        assert f"metadata: {{ name: {namespace}-backend, namespace: traefik }}" in backend
        assert f"kubernetes.io/metadata.name: {namespace} }}" in backend
        assert backend.count("- to:") == 1, "without a console, one door: the relay's"


@pytest.mark.skipif(shutil.which("kubectl") is None, reason="kubectl is not installed")
def test_kustomize_builds_the_console_tree(console_ws):
    out = subprocess.run(["kubectl", "kustomize", str(console_build(console_ws))],
                         capture_output=True, text=True, check=True).stdout
    docs = out.split("\n---\n")
    kinds = sorted(re.search(r"^kind: (\S+)", d, re.MULTILINE).group(1) for d in docs)
    assert kinds == sorted(["ConfigMap", "ConfigMap", "Namespace", "Service", "Service", "StatefulSet", "Deployment",
                            "IngressRoute", "NetworkPolicy", "NetworkPolicy", "NetworkPolicy", "NetworkPolicy"])
    page_map = next(d for d in docs if d.startswith("apiVersion: v1\ndata:") and "index.html: " in d)
    generated = re.search(r"^  name: (\S+)$", page_map, re.MULTILINE).group(1)
    assert generated.startswith(f"{hydrate.CONSOLE_NAME}-") and "nginx.conf: " in page_map
    deployment = next(d for d in docs if d.startswith("apiVersion: apps/v1\nkind: Deployment"))
    assert deployment.count(f"name: {generated}") == 2, "both of the console's volumes mount the generated ConfigMap"
    assert f"namespace: {CONSOLE_NAMESPACE}" in deployment


# ========================================================================== compose
def test_compose_hydrates_one_host_with_the_same_relay_config(build):
    compose = build / "compose"
    assert {p.name for p in compose.iterdir()} == {"compose.yaml", "Caddyfile", "relay.yaml", ".env.example", ".hydrated"}
    stack = (compose / "compose.yaml").read_text()
    for line in (f"image: {hydrate.NCLI_IMAGE}", 'user: "65532:65532"', "read_only: true", "cap_drop: [ALL]",
                 'security_opt: ["no-new-privileges:true"]', 'cpus: "2"', "memory: 4G",
                 "NCLI_NIP11_URL: wss://${RELAY_HOST:?Set RELAY_HOST}", 'ports: ["80:80", "443:443"]'):
        assert line in stack, line
    relay_service = stack.split("  relay:\n", 1)[1].split("\nvolumes:", 1)[0]
    assert "ports:" not in relay_service.replace("# No `ports:`", "")
    env = (compose / ".env.example").read_text()
    assert f"RELAY_HOST={RELAY_HOST}\n" in env and "RELAY_SIGNING_KEY=\n" in env
    shared = (compose / "relay.yaml").read_text()
    assert shared == (build / "kubernetes" / "relay.yaml").read_text()
    for line in ('name: "Private campaign relay"', "auth_required: true", "membership_required: true",
                 "inviteMaxUses: 1", "memberClaims: true", "create: [members]", "pendingJoins: true",
                 "moderationLog: true", "recipientOnlyKinds: [1059, 4410, 4411]", "homepage: true",
                 "perPubkey: {events: 60, per: 1m, burst: 60}", "maxBlobBytes: 104857600",
                 "maxUploadsPerSigner: 2", "membersOnly: {upload: true, download: true}"):
        assert line in shared, line


def test_relay_yaml_turns_on_self_service_invites_groups_and_recipient_only_kinds(build):
    settings = relay_settings((build / "compose" / "relay.yaml").read_text())
    assert settings["membership.memberClaims"] is True, "members mint invites over REQ kind 28935"
    assert settings["membership.inviteMaxUses"] == 1 and settings["membership.inviteTTL"] == "168h"
    assert settings["groups.create"] == ["members"]
    assert settings["groups.pendingJoins"] is True and settings["groups.moderationLog"] is True
    assert settings["groups.roles.admin"] == [9000, 9001, 9002, 9005, 9008, 9009, 9010]
    assert settings["recipientOnlyKinds"] == [1059, 4410, 4411]
    assert settings["homepage"] is True, "the edges route GET / to the relay for a browser"
    assert settings["nip11.limitation.auth_required"] is True
    assert settings["nip11.limitation.membership_required"] is True


# ============================================================ the pinned ncli release
def docker_problem() -> str | None:
    """Why the pinned ncli image cannot run here, or None when a Docker daemon answers."""
    if shutil.which("docker") is None:
        return "docker is not installed: the pinned ncli release runs in its container image"
    done = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True,
                          check=False)
    if done.returncode != 0 or not done.stdout.strip():
        return f"no Docker daemon answers (docker info: {(done.stderr or done.stdout).strip()[:300]}); set DOCKER_HOST"
    return None


# The image's own shell writes the hydrated file inside the container, so no host path has
# to be shared with the Docker VM. The relay runs as it does in compose.yaml: UID 65532, a
# read-only root, and a writable data directory.
_NCLI_ENTRY = 'printf "%s" "$RELAY_YAML" > /tmp/relay.yaml && exec ncli relay --config /tmp/relay.yaml "$@"'
NCLI_CONFIG_IN_CONTAINER = "/tmp/relay.yaml"


def ncli_argv(*docker_args: str, ncli_args: tuple[str, ...] = ()) -> list[str]:
    return ["docker", "run", "--user", "65532:65532", "--read-only", "--tmpfs", "/tmp",
            "--tmpfs", "/app/ncli/data:uid=65532,gid=65532", "-e", "RELAY_YAML", "-e", "NCLI_NIP11_PRIVKEY",
            "-e", f"NCLI_NIP11_URL=wss://{RELAY_HOST}", "-e", "HOME=/app/ncli/data", *docker_args,
            "--entrypoint", "/bin/sh", hydrate.NCLI_IMAGE, "-c", _NCLI_ENTRY, "ncli", *ncli_args]


def ncli_env(relay_yaml: str) -> dict[str, str]:
    """The relay.yaml and a throwaway relay key, handed to docker through its environment."""
    return {**os.environ, "RELAY_YAML": relay_yaml, "NCLI_NIP11_PRIVKEY": os.urandom(32).hex()}


def ncli_check(relay_yaml: str) -> subprocess.CompletedProcess:
    return subprocess.run(ncli_argv("--rm", ncli_args=("--check", "--json")), env=ncli_env(relay_yaml),
                          capture_output=True, text=True, check=False)


def test_the_pinned_ncli_accepts_the_hydrated_relay_yaml(build, private_ws):
    problem = docker_problem()
    if problem is not None:
        pytest.skip(problem)
    for config in (build / "compose" / "relay.yaml", private_ws / ".build" / "kubernetes" / "relay.yaml"):
        done = ncli_check(config.read_text())
        assert done.returncode == 0, f"ncli --check refuses {config}:\n{done.stdout}\n{done.stderr}"
        report = json.loads(done.stdout[done.stdout.index("{\n"):])
        assert report["ok"] is True and report["warnings"] == [], report
    # The control: the same check refuses a key the release does not know, so its OK means something.
    typo = (build / "compose" / "relay.yaml").read_text().replace("  memberClaims: true", "  memberClaim: true")
    refused = ncli_check(typo)
    assert refused.returncode != 0 and "memberClaim" in refused.stdout + refused.stderr


@pytest.fixture(scope="session")
def console_server(console_ws):
    """The pinned console image serving the hydrated console as console.yaml runs it: its
    own command, UID 101, a read-only root with /tmp the only writable path, no
    capabilities, and the two files mounted read-only where the ConfigMap puts them."""
    problem = docker_problem()
    if problem is not None:
        pytest.skip(problem)
    k8s = console_build(console_ws)
    command = json.loads(re.search(r"command: (\[.*\])", (k8s / "console.yaml").read_text()).group(1))
    tag = os.urandom(4).hex()
    name, mounts = f"nostr-relay-deploy-console-{tag}", {"/etc/console": "nginx.conf", "/srv/console": "index.html"}
    volumes = {mount: f"nostr-relay-deploy-console-{tag}{mount.replace('/', '-')}" for mount in mounts}
    try:
        for mount, volume in volumes.items():
            subprocess.run(["docker", "volume", "create", volume], capture_output=True, check=True)
            subprocess.run(["docker", "run", "-i", "--rm", "--user", "0", "-v", f"{volume}:/dst", "--entrypoint", "sh",
                            hydrate.CONSOLE_IMAGE, "-c", f"cat > /dst/{mounts[mount]}"],
                           input=(k8s / "console" / mounts[mount]).read_bytes(), capture_output=True, check=True)
        started = subprocess.run(
            ["docker", "run", "-d", "--name", name, "--read-only", "--tmpfs", "/tmp:uid=101,gid=101",
             "--user", "101:101", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
             *(arg for mount, volume in volumes.items() for arg in ("-v", f"{volume}:{mount}:ro")),
             "-p", f"127.0.0.1::{hydrate.CONSOLE_PORT}", hydrate.CONSOLE_IMAGE, *command],
            capture_output=True, text=True, check=False)
        if started.returncode != 0:
            pytest.fail(f"docker run of the pinned console image failed:\n{started.stderr}")
        mapped = subprocess.run(["docker", "port", name, f"{hydrate.CONSOLE_PORT}/tcp"], capture_output=True,
                                text=True, check=True).stdout.splitlines()[0]
        origin = f"http://127.0.0.1:{mapped.rsplit(':', 1)[1]}"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while True:
            running = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", name], capture_output=True,
                                     text=True, check=False).stdout.strip()
            if running != "true":
                logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True, check=False)
                pytest.fail(f"the console stopped before it served:\n{logs.stdout[-3000:]}{logs.stderr[-3000:]}")
            try:
                opener.open(origin + "/").close()
                break
            except (ConnectionError, urllib.error.URLError):
                time.sleep(0.1)                 # not listening yet; the container is still running
        yield name, origin
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
        subprocess.run(["docker", "volume", "rm", *volumes.values()], capture_output=True, check=False)


def _get(origin: str, method: str, path: str, headers: dict[str, str] | None = None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(origin + path, method=method, headers=headers or {})
    try:
        with opener.open(request) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read()


def test_the_pinned_console_image_serves_the_page_as_the_worker_does(console_server, console_ws, worker):
    name, origin = console_server
    k8s = console_build(console_ws)
    page = (k8s / "console" / "index.html").read_bytes()
    policy = re.search(r'add_header Content-Security-Policy "([^"]+)" always;',
                       (k8s / "console" / "nginx.conf").read_text()).group(1)
    _, worker_headers, _ = worker.http("GET", "/", headers={"Accept": "text/html"})
    for method in ("GET", "HEAD"):
        for path in ("/", "/join", "/join/", "/docs", "/docs/"):
            status, headers, body = _get(origin, method, path, {"Accept": "text/html"})
            assert (status, body) == (200, page if method == "GET" else b""), (method, path)
            assert headers["Content-Security-Policy"] == policy
            for header in ("Content-Type", "Cache-Control", "Referrer-Policy", "X-Content-Type-Options",
                           "X-Frame-Options"):
                assert headers[header] == worker_headers[header], (method, path, header)
    for path in ("/index.html", "/nginx.conf", "/joined", "/JOIN/", "/join/index.html", "/mcp", "/openapi.json",
                 f"/{SHA}", "/.well-known/nostr.json"):
        assert _get(origin, "GET", path)[0] == 404, path
    hydrate.verify_console(hydrate.load_config(console_ws / "relay.with-console.local.toml"), origin)
    logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True, check=False)
    assert "[emerg]" not in logs.stderr and "Read-only file system" not in logs.stderr, logs.stderr[-2000:]


def test_verify_finds_the_web_console_or_says_what_answers_instead(worker, console_ws):
    cfg = hydrate.load_config(console_ws / "relay.with-console.local.toml")
    hydrate.verify_console(cfg, worker.origin)              # the Worker serves the same page
    page = worker.http("GET", "/")[2]

    def serve(body: bytes, policy: str):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Security-Policy", policy)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    for body, policy, said in ((b"<!doctype html><title>relay</title>", "default-src 'none'", "is not the Web Console"),
                               (page, "default-src 'none'", "does not admit the page's own script")):
        server = serve(body, policy)
        try:
            with pytest.raises(hydrate.VerifyError, match=said):
                hydrate.verify_console(cfg, f"http://127.0.0.1:{server.server_address[1]}")
        finally:
            server.shutdown()


def test_verify_reads_the_console_deployment_rollout(tmp_path, monkeypatch, capsys):
    """--verify on a relay with the Web Console also reads its Deployment, through kubectl
    (stood in for here: the real-contact path is an operator's --verify after an apply)."""
    config = tmp_path / "relay.local.toml"
    config.write_text(dump_toml(private_config(kubernetes={"web_console": True})))
    cfg = hydrate.load_config(config)
    sts = {"status": {"readyReplicas": 1, "updateRevision": "r1"}}
    pod = {"metadata": {"labels": {"controller-revision-hash": "r1"}}}

    def run(deployment):
        def kubectl(argv):
            kind = argv[argv.index("get") + 1]
            return json.dumps({"statefulset": sts, "pod": pod, "deployment": deployment}[kind])
        monkeypatch.setattr(hydrate, "run_kubectl", kubectl)
        hydrate.verify_rollout(cfg)
        return capsys.readouterr().out

    rolled = {"metadata": {"generation": 2}, "spec": {"replicas": 1},
              "status": {"observedGeneration": 2, "updatedReplicas": 1, "availableReplicas": 1}}
    assert f"console: deployment/{hydrate.CONSOLE_NAME} serves the applied revision (1/1 available)" in run(rolled)
    rolling = {**rolled, "status": {**rolled["status"], "observedGeneration": 1}}
    assert "console rollout IN PROGRESS" in run(rolling)
    with pytest.raises(hydrate.VerifyError, match="has no available replica"):
        run({**rolled, "status": {"availableReplicas": 0}})


# ======================================================================= cloudflare
def test_cloudflare_hydrates_wrangler_and_copies_the_worker(build):
    cf = build / "cloudflare"
    wrangler = tomllib.loads((cf / "wrangler.toml").read_text())
    assert wrangler["name"] == "nostr-campaign-relay"
    assert wrangler["main"] == "src/worker.ts"
    assert wrangler["workers_dev"] is False and wrangler["preview_urls"] is False
    assert wrangler["routes"] == [{"pattern": RELAY_HOST, "custom_domain": True}]
    assert wrangler["vars"] == {"RELAY_HOST": RELAY_HOST, "RELAY_NAME": "Private campaign relay",
                                "EVENTS_PER_MINUTE": "60", "MAX_BLOB_BYTES": "104857600",
                                "MAX_UPLOADS_PER_SIGNER": "2"}
    assert wrangler["durable_objects"]["bindings"] == [{"name": "RELAY", "class_name": "RelayDurableObject"}]
    assert wrangler["migrations"] == [{"tag": "v1", "new_sqlite_classes": ["RelayDurableObject"]}]
    assert wrangler["r2_buckets"] == [{"binding": "BLOSSOM_BUCKET", "bucket_name": "nostr-campaign-blobs"}]
    assert "ADMIN_TOKEN" not in wrangler["vars"], "the admin token is a secret, never a var"
    modules = {"worker.ts", "nostr.ts", "console.ts", "console-docs.ts", "nip44.ts", "mailbox.ts", "mcp.ts", "oauth.ts"}
    assert {p.name for p in (cf / "src").iterdir()} == modules
    for name in modules:
        assert (cf / "src" / name).read_bytes() == (REPO / "templates" / "cloudflare" / "src" / name).read_bytes()
    assert "secret put RELAY_SIGNING_KEY" in (cf / "wrangler.toml").read_text()
    assert "RELAY_SIGNING_KEY" not in wrangler["vars"], "the relay's key is a secret, never a var"


# ===================================================================== github pages
class _Collect(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags: list[tuple[str, dict]] = []
        self.style = ""
        self._in_style = False

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))
        self._in_style = tag == "style"

    def handle_endtag(self, tag):
        self._in_style = False if tag == "style" else self._in_style

    def handle_data(self, data):
        if self._in_style:
            self.style += data


# What both pages link to, and where their invite-request form posts: the source on GitHub, and
# MayWe, which runs the waitlist (with a second publishable key for pages served from docs.awow.io).
SOURCE_URL = "https://github.com/awowIO/crosswire"
MAYWE_URL = "https://maywe.email"
SUBSCRIBE_URL = "https://newsletter.awow.io/v1/subscribe"
DOCS_ORIGIN = "https://docs.awow.io"
MAYWE_KEY, DOCS_MAYWE_KEY = "pk_G-LEI15eUfTnYhGyV2hMHvRsxMsJwkM4r-wgj3jS2jI", "pk_6ZNZP0jBeKTpu22jfUQfQ6Dhcu6faq7iSzeEJsMMy78"


def _assert_links_and_invite_form(parsed: _Collect, page: str, q: str) -> None:
    """No script, stylesheet or image from anywhere; links to the source on GitHub (header and
    footer) and to MayWe only; and the MayWe invite-request form. `q` is the script's quote."""
    assert not [(t, a) for t, a in parsed.tags if "src" in a or t == "link"]
    console_page = any(a.get("id") == "workspace" for _, a in parsed.tags)
    links = [(t, a) for t, a in parsed.tags if "href" in a and not a["href"].startswith("#")]
    expected = {("a", SOURCE_URL), ("a", MAYWE_URL)}
    if console_page:
        expected.add(("a", "https://github.com/awowIO/nostr-relay-deploy"))
    assert {(t, a["href"]) for t, a in links} == expected
    anchors = [a["href"] for _, a in parsed.tags if a.get("href", "").startswith("#")]
    assert anchors == (["#switchboard", "#docs", "#acls", "#architecture",
                        "#docs", "#acls", "#architecture"] if console_page else [])
    assert all(a.get("target") == "_blank" and a.get("rel") == "noopener noreferrer" for _, a in links)
    header = re.search(r"<header .*?</header>", page, re.DOTALL).group(0)
    link = re.search(rf'<a class="hdr-link" href="{re.escape(SOURCE_URL)}"[^>]*>(.*?)</a>', header, re.DOTALL)
    assert link and re.sub(r"<[^>]+>", "", link.group(1)) == "GitHub · awowIO/crosswire ↗"
    assert '<span class="hdr-repo"> · awowIO/crosswire</span>' in link.group(1), "what a narrow header drops"
    assert f'<a href="{SOURCE_URL}"' in re.search(r"<footer>.*?</footer>", page, re.DOTALL).group(0)
    # No style attribute anywhere: the console's hash-only style-src refuses inline styles, so
    # a hidden field styled that way would show. The honeypot is hidden by a rule instead.
    assert not [(t, a) for t, a in parsed.tags if "style" in a]
    assert re.search(r"#maywe-website \{ position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; "
                     r"pointer-events: none; \}", parsed.style)
    choices = [a for t, a in parsed.tags if t == "button" and "data-install" in a]
    assert [a["data-install"] for a in choices] == [
        "claude", "codex", "antigravity", "cursor", "claude-desktop", "chatgpt", "cli"]
    assert [a["data-install"] for a in choices if a["aria-pressed"] == "true"] == ["claude"]
    ids = [a["id"] for _, a in parsed.tags if "id" in a]
    assert len(ids) == len(set(ids))
    order = [ids.index(name) for name in ("install-clients", "open-token", "install-prompt", "install-command", "maywe-card")]
    assert order == sorted(order), "choose an agent, prepare an invite, copy a setup path, or request access"
    for button in ("install-copy", "install-prompt-copy"):
        assert any(t == "button" and a.get("id") == button and a["type"] == "button" for t, a in parsed.tags)
    if console_page:
        admission = page[page.index('id="admission"'):page.index('id="workspace"')]
        assert admission.index('id="maywe-card"') < admission.index('<details id="invited-card">')
        drawer = re.search(r'<details class="returning" id="returning">(.*?)</details>', admission, re.DOTALL)
        assert drawer and all(f'id="{field}"' in drawer[1] for field in
                              ("key-form", "nsec", "signin", "reconnect", "extension-choice", "use-extension"))
    opener = next(a for t, a in parsed.tags if t == "form" and a.get("id") == "open-form")
    assert "action" not in opener
    pasted = next(a for t, a in parsed.tags if t == "input" and a.get("id") == "open-token")
    assert "required" in pasted and pasted["autocomplete"] == "off"
    form = next(a for t, a in parsed.tags if t == "form" and a.get("id") == "maywe-form")
    assert "action" not in form, "the script posts it, and form-action 'none' stops a plain submit"
    fields = {a["id"]: a for t, a in parsed.tags if t == "input" and a.get("id", "").startswith("maywe-")}
    assert set(fields) == {"maywe-email", "maywe-note", "maywe-website"}
    assert fields["maywe-email"]["type"] == "email" and "required" in fields["maywe-email"]
    trap = fields["maywe-website"]
    assert (trap["name"], trap["tabindex"], trap["aria-hidden"]) == ("website", "-1", "true"), "the honeypot"
    for needle in (f"fetch({q}{SUBSCRIBE_URL}{q}, {{\n", f"method: {q}POST{q}",
                   f"source: {q}crosswire:invite-request{q}",
                   f"if (note) params.set({q}details{q}, JSON.stringify({{ use_case: note }}));"):
        assert needle in page, needle
    assert re.search(rf"location\.origin === {q}{DOCS_ORIGIN}{q}\)\s*\?\s*{q}{DOCS_MAYWE_KEY}{q}\s*:\s*{q}{MAYWE_KEY}{q}",
                     page), "docs.awow.io posts with its own key, every other origin with the relay's"
    assert re.search(r"new URLSearchParams\(\{[^}]*\bemail\b[^}]*\bwebsite\b[^}]*\}\)", page)


def test_github_pages_is_a_full_width_self_contained_status_page(build):
    pages = build / "github-pages"
    page = (pages / "index.html").read_text()
    assert page.startswith("<!doctype html>\n<html lang=\"en\">")
    parsed = _Collect()
    parsed.feed(page)
    tags = [t for t, _ in parsed.tags]
    for tag in ("html", "head", "meta", "title", "style", "body", "main", "script"):
        assert tag in tags, tag
    metas = [a for t, a in parsed.tags if t == "meta"]
    assert {"charset": "utf-8"} in metas
    assert any(a.get("name") == "viewport" and "width=device-width" in a.get("content", "") for a in metas)
    csp = next(a["content"] for a in metas if a.get("http-equiv") == "Content-Security-Policy")
    assert "default-src 'none'" in csp and f"connect-src https://{RELAY_HOST} https://newsletter.awow.io;" in csp
    assert "form-action 'none'" in csp
    # Self-contained: no stylesheet, script or image from anywhere, and links to GitHub and MayWe only.
    _assert_links_and_invite_form(parsed, page, '"')
    style = re.sub(r"/\*.*?\*/", "", parsed.style, flags=re.DOTALL)
    page_rule = re.search(r"\.page\s*\{([^}]*)\}", style).group(1)
    assert re.search(r"(^|;)\s*width:\s*100%", page_rule)
    assert re.search(r"max-width:\s*none", page_rule)
    assert "padding-inline: clamp(20px, 3vw, 48px)" in page_rule
    assert re.findall(r"max-width\s*:\s*([^;}]+)", style) == ["none"], "no boxed max-width container anywhere"
    assert "@media (max-width" not in style
    assert "@media (prefers-color-scheme: dark)" in style and "color-scheme: light dark" in style
    assert f'const RELAY_HOST = "{RELAY_HOST}";' in page
    assert 'fetch(url, { headers: { Accept: "application/nostr+json" }' in page
    assert "awowIO/nostr-mailbox" not in page, "the repository is awowIO/crosswire now"
    for command in ("nostr-mailbox relay check", f"nostr-mailbox setup --relay wss://{RELAY_HOST} "
                    "--campaign my-campaign --kubectl", "nostr-mailbox invite --kubectl"):
        assert command in page, command
    # An invite link opens this page at / or /join/ (GitHub Pages sends /join there): the
    # page reads the token from the fragment, then takes the fragment off the address bar.
    assert (pages / "join" / "index.html").read_text() == page
    invite = next(a for t, a in parsed.tags if a.get("id") == "invite")
    assert "hidden" in invite, "nothing about an invite shows without one"
    assert re.search(r"^  showInvite\(\);\n  checkRelay\(\);\n</script>", page, re.MULTILINE)
    assert 'history.replaceState(null, "", location.pathname + location.search);' in page
    assert (pages / ".nojekyll").exists()
    assert json.loads((pages / ".well-known" / "nostr.json").read_text()) == {"names": {}, "relays": {}}
    assert not (pages / "CNAME").exists() and "{{" not in page


def test_github_pages_publishes_nip05_names_and_a_custom_domain(tmp_path):
    ws = copy_repo(tmp_path)
    data = example_dict()
    data["github_pages"].update(nip05={"alice": NIP19_NPUB, "_": NIP19_HEX}, domain="pages.example.com",
                                title='Relay <&> "Directory"')
    (ws / "relay.local.toml").write_text(dump_toml(data))
    run_cli(ws, "--target", "github-pages")
    pages = ws / ".build" / "github-pages"
    assert json.loads((pages / ".well-known" / "nostr.json").read_text()) == {
        "names": {"_": NIP19_HEX, "alice": NIP19_HEX}, "relays": {NIP19_HEX: [f"wss://{RELAY_HOST}"]}}
    assert (pages / "CNAME").read_text() == "pages.example.com\n"
    page = (pages / "index.html").read_text()
    assert "<title>Relay &lt;&amp;&gt; &quot;Directory&quot;</title>" in page
    assert f"<tr><td><code>alice</code></td><td><code>{NIP19_HEX}</code></td></tr>" in page


# ================================================================ edge-route parity
SHA = "ab" * 32
OTHER_HOST = "evil.example.org"
# `GET` and `HEAD /` are one route on every edge, whatever the headers: the relay behind it
# tells a WebSocket, a NIP-11 client and a browser apart. Every other path stays shut, but
# two kinds are WORKER_ONLY. `/join` and `/join/`, where nostr-mailbox's invite links point:
# the Worker is its own relay and serves its console there; the pinned ncli has no page
# there (test_only_the_worker_has_a_page_where_invite_links_point holds that against the
# image), so the Caddyfile and the IngressRoute keep it shut rather than forward to a 404.
# And the remote MCP server (/mcp, /openapi.json, /tools/<tool>, and the same under a
# magic URL /mcp/s/<token>) with the OAuth 2.1 server that signs its clients in
# (/.well-known/oauth-*, /.well-known/openid-configuration, /oauth/*), which the Worker
# runs beside its relay and the pinned ncli has no counterpart of. Probed here without a
# usable token, they answer as WORKER_ONLY_STATUS says, never the page and never the wire.
WORKER_ONLY = "worker only"
CONSOLE_PATHS = ("/join", "/join/", "/docs", "/docs/")
# A token-shaped path segment whose token is no JSON, so the magic routes answer 401.
MAGIC = "/mcp/s/nm1_bm90IGpzb24"
OAUTH_FORM = {"Content-Type": "application/x-www-form-urlencoded"}
PROBES = [
    ("websocket upgrade", "GET", "/", {"Upgrade": "websocket", "Connection": "Upgrade"}, None, True),
    ("NIP-11", "GET", "/", {"Accept": "application/nostr+json"}, None, True),
    ("plain GET /", "GET", "/", {}, None, True),
    ("browser GET /", "GET", "/", {"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}, None, True),
    ("browser HEAD /", "HEAD", "/", {"Accept": "text/html"}, None, True),
    ("NIP-11 inside a list Accept", "GET", "/", {"Accept": "application/nostr+json, */*"}, None, True),
    ("upgrade spelt WebSocket", "GET", "/", {"Upgrade": "WebSocket", "Connection": "Upgrade"}, None, True),
    ("POST / with upgrade", "POST", "/", {"Upgrade": "websocket"}, None, False),
    ("PUT /", "PUT", "/", {}, None, False),
    ("HEAD / NIP-11", "HEAD", "/", {"Accept": "application/nostr+json"}, None, True),
    ("CORS preflight", "OPTIONS", "/", {"Access-Control-Request-Method": "GET"}, None, False),
    ("the page under another name", "GET", "/index.html", {"Accept": "text/html"}, None, False),
    ("the ncli page's assets", "GET", "/_home/assets/home.js", {}, None, False),
    ("upload", "PUT", "/upload", {}, None, True),
    ("media upload", "PUT", "/media/upload", {}, None, True),
    ("POST upload", "POST", "/upload", {}, None, False),
    ("GET upload", "GET", "/upload", {}, None, False),
    ("upload subpath", "PUT", "/upload/x", {}, None, False),
    ("blob GET", "GET", f"/{SHA}", {}, None, True),
    ("blob HEAD", "HEAD", f"/{SHA}", {}, None, True),
    ("media blob with extension", "GET", f"/media/{SHA}.pdf", {}, None, True),
    ("media blob HEAD", "HEAD", f"/media/{SHA}", {}, None, True),
    ("blob DELETE", "DELETE", f"/{SHA}", {}, None, False),
    ("blob PUT", "PUT", f"/{SHA}", {}, None, False),
    ("uppercase hash", "GET", f"/{SHA.upper()}", {}, None, False),
    ("short hash", "GET", f"/{SHA[:-1]}", {}, None, False),
    ("nine-letter extension", "GET", f"/{SHA}.abcdefghi", {}, None, False),
    ("uppercase extension", "GET", f"/{SHA}.PDF", {}, None, False),
    ("blob subpath", "GET", f"/media/{SHA}/x", {}, None, False),
    ("other prefix", "GET", f"/files/{SHA}", {}, None, False),
    ("admin listener", "GET", "/admin", {}, None, False),
    ("metrics", "GET", "/metrics", {}, None, False),
    ("Worker admin API without a token", "GET", "/_admin/members", {}, None, False),
    ("upgrade on another host", "GET", "/", {"Upgrade": "websocket"}, OTHER_HOST, False),
    ("NIP-11 on another host", "GET", "/", {"Accept": "application/nostr+json"}, OTHER_HOST, False),
    ("the page on another host", "GET", "/", {"Accept": "text/html"}, OTHER_HOST, False),
    ("blob on another host", "GET", f"/{SHA}", {}, OTHER_HOST, False),
    ("documentation", "GET", "/docs", {"Accept": "text/html"}, None, WORKER_ONLY),
    ("documentation trailing slash", "HEAD", "/docs/", {}, None, WORKER_ONLY),
    ("under documentation", "GET", "/docs/no", {}, None, False),
    ("similar documentation path", "GET", "/docs-extra", {}, None, False),
    ("documentation POST", "POST", "/docs/", {}, None, False),
    ("invite link page", "GET", "/join", {"Accept": "text/html"}, None, WORKER_ONLY),
    ("invite link page with a slash", "GET", "/join/", {"Accept": "text/html"}, None, WORKER_ONLY),
    ("invite link page HEAD", "HEAD", "/join/", {}, None, WORKER_ONLY),
    ("invite link page asked for NIP-11", "GET", "/join", {"Accept": "application/nostr+json"}, None, WORKER_ONLY),
    ("upgrade at the invite link page", "GET", "/join/", {"Upgrade": "websocket", "Connection": "Upgrade"}, None,
     WORKER_ONLY),
    ("POST to the invite link page", "POST", "/join/", {}, None, False),
    ("under the invite link page", "GET", "/join/index.html", {}, None, False),
    ("a path that starts like join", "GET", "/joined", {}, None, False),
    ("the invite link page in capitals", "GET", "/JOIN/", {}, None, False),
    ("the invite link page on another host", "GET", "/join/", {"Accept": "text/html"}, OTHER_HOST, False),
    ("MCP Streamable HTTP", "POST", "/mcp", {"Content-Type": "application/json"}, None, WORKER_ONLY),
    ("MCP stream", "GET", "/mcp", {"Accept": "text/event-stream"}, None, WORKER_ONLY),
    ("MCP session end", "DELETE", "/mcp", {}, None, WORKER_ONLY),
    ("OpenAPI document", "GET", "/openapi.json", {}, None, WORKER_ONLY),
    ("OpenAPI action", "POST", "/tools/mailbox_post", {"Content-Type": "application/json"}, None, WORKER_ONLY),
    ("an upgrade at the MCP endpoint", "GET", "/mcp", {"Upgrade": "websocket", "Connection": "Upgrade"}, None,
     WORKER_ONLY),
    ("PUT to the MCP endpoint", "PUT", "/mcp", {}, None, False),
    ("under the MCP endpoint", "POST", "/mcp/", {}, None, False),
    ("HEAD the OpenAPI document", "HEAD", "/openapi.json", {}, None, False),
    ("GET an OpenAPI action", "GET", "/tools/mailbox_post", {}, None, False),
    ("an OpenAPI action in capitals", "POST", "/tools/Mailbox_post", {}, None, False),
    ("under an OpenAPI action", "POST", "/tools/mailbox_post/x", {}, None, False),
    ("the MCP endpoint on another host", "POST", "/mcp", {}, OTHER_HOST, False),
    ("magic MCP URL", "POST", MAGIC, {"Content-Type": "application/json"}, None, WORKER_ONLY),
    ("magic MCP stream", "GET", MAGIC, {"Accept": "text/event-stream"}, None, WORKER_ONLY),
    ("magic MCP session end", "DELETE", MAGIC, {}, None, WORKER_ONLY),
    ("magic OpenAPI document", "GET", f"{MAGIC}/openapi.json", {}, None, WORKER_ONLY),
    ("magic OpenAPI action", "POST", f"{MAGIC}/tools/mailbox_post", {"Content-Type": "application/json"}, None,
     WORKER_ONLY),
    ("an upgrade at a magic URL", "GET", MAGIC, {"Upgrade": "websocket", "Connection": "Upgrade"}, None, WORKER_ONLY),
    ("a magic URL without a token", "POST", "/mcp/s/", {}, None, False),
    ("a magic URL whose token is no nm1_", "POST", "/mcp/s/abc", {}, None, False),
    ("a magic URL with a slash", "POST", f"{MAGIC}/", {}, None, False),
    ("under a magic URL", "POST", f"{MAGIC}/x", {}, None, False),
    ("PUT to a magic URL", "PUT", MAGIC, {}, None, False),
    ("POST a magic OpenAPI document", "POST", f"{MAGIC}/openapi.json", {}, None, False),
    ("GET a magic OpenAPI action", "GET", f"{MAGIC}/tools/mailbox_post", {}, None, False),
    ("a magic URL on another host", "POST", MAGIC, {}, OTHER_HOST, False),
    ("protected resource metadata", "GET", "/.well-known/oauth-protected-resource", {}, None, WORKER_ONLY),
    ("protected resource metadata of /mcp", "GET", "/.well-known/oauth-protected-resource/mcp", {}, None,
     WORKER_ONLY),
    ("authorization server metadata", "GET", "/.well-known/oauth-authorization-server", {}, None, WORKER_ONLY),
    ("OpenID discovery", "GET", "/.well-known/openid-configuration", {}, None, WORKER_ONLY),
    ("dynamic client registration", "POST", "/oauth/register", {"Content-Type": "application/json"}, None,
     WORKER_ONLY),
    ("the consent page", "GET", "/oauth/authorize", {"Accept": "text/html"}, None, WORKER_ONLY),
    ("the consent page's answer", "POST", "/oauth/authorize", OAUTH_FORM, None, WORKER_ONLY),
    ("the token endpoint", "POST", "/oauth/token", OAUTH_FORM, None, WORKER_ONLY),
    ("POST the resource metadata", "POST", "/.well-known/oauth-protected-resource", {}, None, False),
    ("HEAD the authorization server metadata", "HEAD", "/.well-known/oauth-authorization-server", {}, None, False),
    ("resource metadata of another path", "GET", "/.well-known/oauth-protected-resource/tools", {}, None, False),
    ("another well-known document", "GET", "/.well-known/nostr.json", {}, None, False),
    ("GET the registration endpoint", "GET", "/oauth/register", {}, None, False),
    ("GET the token endpoint", "GET", "/oauth/token", {}, None, False),
    ("under the OAuth endpoints", "GET", "/oauth/", {}, None, False),
    ("the OAuth endpoints in capitals", "GET", "/OAUTH/AUTHORIZE", {}, None, False),
    ("the OAuth metadata on another host", "GET", "/.well-known/oauth-authorization-server", {}, OTHER_HOST, False),
]
# What each Worker-only MCP or OAuth route answers a probe without a usable token. Every
# other one of them answers 401. A magic URL's token is its credential: 403, not 401.
WORKER_ONLY_STATUS = {
    ("GET", "/mcp"): 405, ("GET", MAGIC): 405,
    ("POST", MAGIC): 403, ("DELETE", MAGIC): 403, ("GET", f"{MAGIC}/openapi.json"): 403,
    ("POST", f"{MAGIC}/tools/mailbox_post"): 403,
    ("GET", "/.well-known/oauth-protected-resource"): 200, ("GET", "/.well-known/oauth-protected-resource/mcp"): 200,
    ("GET", "/.well-known/oauth-authorization-server"): 200, ("GET", "/.well-known/openid-configuration"): 200,
    ("POST", "/oauth/register"): 400, ("GET", "/oauth/authorize"): 400, ("POST", "/oauth/authorize"): 400,
    ("POST", "/oauth/token"): 400,
}


def _header(headers: dict[str, str], name: str) -> str | None:
    return next((v for k, v in headers.items() if k.lower() == name.lower()), None)


def caddy_admits(caddyfile: str, host: str, method: str, path: str, headers: dict[str, str]) -> bool:
    """Evaluate the hydrated Caddyfile: named matchers, then `handle` blocks in order."""
    lines = [ln.strip() for ln in caddyfile.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    assert lines[0] == "{$RELAY_HOST} {", "one site block, for RELAY_HOST only"
    matchers: dict[str, list[list[str]]] = {}
    handles: list[list] = []
    state = None
    for line in lines[1:]:
        if line == "}":
            state = None
        elif line.startswith("@") and line.endswith("{"):
            state = ("matcher", line[1:-1].strip())
            matchers[state[1]] = []
        elif line.startswith("handle") and line.endswith("{"):
            name = line[len("handle"):-1].strip()
            handles.append([name[1:] if name else None, None])
            state = ("handle",)
        elif state and state[0] == "matcher":
            matchers[state[1]].append(line.split())
        elif state and state[0] == "handle":
            handles[-1][1] = line
    if host != RELAY_HOST:
        return False

    def match(conditions: list[list[str]]) -> bool:
        for kind, *args in conditions:
            if kind == "path":
                assert not any("*" in a for a in args)
                ok = path in args
            elif kind == "method":
                ok = method in args
            elif kind == "header":
                assert len(args) == 2 and "*" not in args[1]
                ok = _header(headers, args[0]) == args[1]
            elif kind == "path_regexp":
                ok = re.search(args[0], path) is not None
            else:
                raise AssertionError(f"this evaluator does not know the Caddy matcher {kind!r}")
            if not ok:
                return False
        return True

    for name, action in handles:
        if name is None or match(matchers[name]):
            return action.startswith("reverse_proxy relay:5500")
    return False


_TRAEFIK_CALL = re.compile(r"([A-Za-z]+)\(((?:\s*`[^`]*`\s*,?)*)\)")


def traefik_admits(ingressroute: str, host: str, method: str, path: str, headers: dict[str, str]) -> bool:
    """Whether the relay-only IngressRoute (three rules) routes the request at all."""
    assert len(re.findall(r"- match: '(.*)'", ingressroute)) == 3
    return traefik_service(ingressroute, host, method, path, headers) is not None


_TRAEFIK_ROUTE = re.compile(r"- match: '(.*)'\n\s+kind: Rule\n\s+priority: (\d+)\n"
                            r"\s+services: \[\{ name: (\S+), port: (\d+) \}\]")


def traefik_service(ingressroute: str, host: str, method: str, path: str, headers: dict[str, str]) -> str | None:
    """Evaluate the hydrated IngressRoute's match rules (Traefik v3 rule syntax): the
    `name:port` of the service the request reaches, or None. Every route has the same
    priority, so no two rules may match one request: the order Traefik would pick is
    never what decides."""
    routes = _TRAEFIK_ROUTE.findall(ingressroute)
    assert len(routes) == len(re.findall(r"- match: ", ingressroute)) and len({r[1] for r in routes}) == 1

    def evaluate(rule: str) -> bool:
        tokens, at = [], 0
        while at < len(rule):
            if rule[at].isspace():
                at += 1
            elif rule.startswith(("&&", "||"), at):
                tokens.append(rule[at:at + 2])
                at += 2
            elif rule[at] in "()!":
                tokens.append(rule[at])
                at += 1
            else:
                m = _TRAEFIK_CALL.match(rule, at)
                assert m, f"cannot parse the Traefik rule at {rule[at:]!r}"
                tokens.append((m.group(1), re.findall(r"`([^`]*)`", m.group(2))))
                at = m.end()

        def call(name: str, args: list[str]) -> bool:
            if name == "Host":
                return host.lower() == args[0].lower()
            if name == "Path":
                return path == args[0]
            if name == "Method":
                return method == args[0]
            if name == "Header":
                return _header(headers, args[0]) == args[1]
            if name == "HeaderRegexp":                      # Go's RE2; (?i) and \+ mean the same in Python
                value = _header(headers, args[0])
                return value is not None and re.search(args[1], value) is not None
            if name == "PathRegexp":
                return re.search(args[0], path) is not None
            raise AssertionError(f"this evaluator does not know the Traefik matcher {name!r}")

        def either(i):
            value, i = both(i)
            while i < len(tokens) and tokens[i] == "||":
                other, i = both(i + 1)
                value = value or other
            return value, i

        def both(i):
            value, i = negation(i)
            while i < len(tokens) and tokens[i] == "&&":
                other, i = negation(i + 1)
                value = value and other
            return value, i

        def negation(i):
            if tokens[i] == "!":
                value, i = negation(i + 1)
                return not value, i
            if tokens[i] == "(":
                value, i = either(i + 1)
                assert tokens[i] == ")"
                return value, i + 1
            return call(*tokens[i]), i + 1

        value, end = either(0)
        assert end == len(tokens)
        return value

    matched = [f"{name}:{port}" for rule, _, name, port in routes if evaluate(rule)]
    assert len(matched) <= 1, f"two routes match {method} {path} {headers}: {matched}"
    return matched[0] if matched else None


@pytest.mark.parametrize("name, method, path, headers, host, admitted", PROBES, ids=[p[0] for p in PROBES])
def test_caddy_traefik_and_the_worker_admit_the_same_routes(build, worker, name, method, path, headers,
                                                            host, admitted):
    host = host or RELAY_HOST
    caddy = caddy_admits((build / "compose" / "Caddyfile").read_text(), host, method, path, headers)
    traefik = traefik_admits((build / "kubernetes" / "ingressroute.yaml").read_text(), host, method, path, headers)
    answer = worker.probe(method, path, headers, host)
    expected = (False, False, True) if admitted == WORKER_ONLY else (admitted, admitted, admitted)
    assert (caddy, traefik, answer["status"] != 404) == expected, answer
    if admitted and path == "/" and "Upgrade" in headers:
        assert answer["upgrade"] is True
    if admitted == WORKER_ONLY and path in CONSOLE_PATHS:
        assert (answer["status"], answer["upgrade"]) == (200, False), "/join is the page, never the wire"
    elif admitted == WORKER_ONLY:
        assert answer["upgrade"] is False, "the MCP and OAuth routes are never the wire"
        assert answer["status"] == WORKER_ONLY_STATUS.get((method, path), 401), answer


def console_backend(method: str, path: str, headers: dict[str, str], admitted) -> str | None:
    """Where the IngressRoute of a relay with the Web Console sends a probe of PROBES: the
    split edgeRoute() in nostr.ts makes. The Worker's "page" is the console; the wire, NIP-11
    (and its 400 for a list of types), uploads and blobs are the relay; the Worker's MCP and
    OAuth routes reach nothing."""
    if admitted is False:
        return None
    if admitted == WORKER_ONLY:
        return f"{hydrate.CONSOLE_NAME}:{hydrate.CONSOLE_PORT}" if path in CONSOLE_PATHS else None
    upgrade = method == "GET" and (_header(headers, "Upgrade") or "").lower() == "websocket"
    nip11 = "application/nostr+json" in (_header(headers, "Accept") or "").lower()
    if path == "/" and not upgrade and not nip11:
        return f"{hydrate.CONSOLE_NAME}:{hydrate.CONSOLE_PORT}"
    return "nostr-relay:5500"


@pytest.mark.parametrize("name, method, path, headers, host, admitted", PROBES, ids=[p[0] for p in PROBES])
def test_with_the_console_traefik_routes_a_browser_to_it_and_the_rest_as_before(console_ws, worker, name, method,
                                                                                 path, headers, host, admitted):
    host = host or RELAY_HOST
    ingressroute = (console_build(console_ws) / "ingressroute.yaml").read_text().replace(PRIVATE["relay_host"], RELAY_HOST)
    expected = console_backend(method, path, headers, admitted)
    assert traefik_service(ingressroute, host, method, path, headers) == expected
    if expected and expected.startswith(hydrate.CONSOLE_NAME):
        # The Worker answers the same request with its console page: the two edges agree.
        status, response_headers, _ = worker.http(method, path, headers=headers)
        assert (status, response_headers["Content-Type"]) == (200, "text/html; charset=utf-8")


def test_the_worker_admin_api_is_the_only_other_route_and_needs_the_token(worker):
    assert worker.probe("GET", "/_admin/members", {"Authorization": f"Bearer {ADMIN_TOKEN}"})["status"] == 200
    assert worker.probe("GET", "/_admin/members", {"Authorization": f"Bearer {ADMIN_TOKEN[:-1]}0"})["status"] == 404
    assert worker.probe("GET", "/_admin/members", {"Authorization": ADMIN_TOKEN})["status"] == 404


# ====================================================================== BIP-340 / NIP-01
# Test vectors 0-3 of the BIP-340 specification: secret, public key, aux, message, signature.
BIP340 = [
    ("0000000000000000000000000000000000000000000000000000000000000003",
     "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9",
     "0000000000000000000000000000000000000000000000000000000000000000",
     "0000000000000000000000000000000000000000000000000000000000000000",
     ("E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA8215"
     "25F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0")),
    ("B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF",
     "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
     "0000000000000000000000000000000000000000000000000000000000000001",
     "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
     ("6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE3341"
     "8906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A")),
    ("C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9",
     "DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8",
     "C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906",
     "7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C",
     ("5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1B"
     "AB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7")),
    ("0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710",
     "25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517",
     "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
     "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
     ("7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC"
     "97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3")),
]
P_FIELD = 2**256 - 2**32 - 977


@pytest.mark.parametrize("secret, pubkey, aux, msg, sig", BIP340)
def test_the_test_signer_reproduces_the_bip340_vectors(secret, pubkey, aux, msg, sig):
    assert pubkey_gen(bytes.fromhex(secret)).hex() == pubkey.lower()
    assert schnorr_sign(bytes.fromhex(msg), bytes.fromhex(secret), bytes.fromhex(aux)).hex() == sig.lower()
    assert schnorr_verify(bytes.fromhex(msg), bytes.fromhex(pubkey), bytes.fromhex(sig))
    flipped = sig[:-1] + format(int(sig[-1], 16) ^ 1, "X")
    assert not schnorr_verify(bytes.fromhex(msg), bytes.fromhex(pubkey), bytes.fromhex(flipped))


def test_the_worker_signs_as_bip340_specifies(worker):
    """The key that signs the relay's invites and group state: vectors 0-3, byte for byte."""
    for secret, pubkey, aux, msg, sig in BIP340:
        made = worker.control("sign", {"secret": secret.lower(), "msg": msg.lower(), "aux": aux.lower()})
        assert made == {"pubkey": pubkey.lower(), "sig": sig.lower()}


def test_the_worker_verifies_bip340_and_rejects_every_way_a_signature_can_be_wrong(worker):
    def valid(pubkey: str, msg: str, sig: str) -> bool:
        return worker.control("verify", {"pubkey": pubkey.lower(), "msg": msg.lower(), "sig": sig.lower()})["valid"]

    for _, pubkey, _, msg, sig in BIP340:
        assert valid(pubkey, msg, sig)
    _, pubkey, _, msg, sig = BIP340[1]
    r, s = sig[:64], int(sig[64:], 16)
    flip = lambda h, i: h[:i] + format(int(h[i], 16) ^ 1, "x") + h[i + 1:]
    for what, args in {
        "one bit of the message": (pubkey, flip(msg, 0), sig),
        "one bit of the signature": (pubkey, msg, flip(sig, 127)),
        "another key": (BIP340[2][1], msg, sig),
        "negated s": (pubkey, msg, r + format(N - s, "064x")),
        "s equal to the group order": (pubkey, msg, r + format(N, "064x")),
        "r equal to the field prime": (pubkey, msg, format(P_FIELD, "064x") + sig[64:]),
        "a truncated signature": (pubkey, msg, sig[:126]),
    }.items():
        assert not valid(*args), what
    # vector 4: a valid signature whose r starts with zero bytes
    assert valid("D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9",
                 "4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703",
                 "00000000000000000000003B78CE563F89A0ED9414F5AA28AD0D96D6795F9C63"
                 "76AFB1548AF603B3EB45C9F8207DEE1060CB71C04E80F593060B07D28308D7F4")
    # vector 5: a public key that is not on the curve
    assert not valid("EEFDEA4CDB677750A420FEE807EACF21EB9898AE79B9768766E4FAA04A2D4A34", msg, sig)


# ============================================================ the Worker as a relay
def test_nip11_advertises_both_gates(worker):
    status, headers, body = worker.http("GET", "/", headers={"Accept": "application/nostr+json"})
    assert status == 200
    assert headers["Content-Type"] == "application/nostr+json"
    assert headers["Access-Control-Allow-Origin"] == "*", "the GitHub Pages status page reads it from a browser"
    info = json.loads(body)
    assert info["name"] == "Private campaign relay"
    assert info["limitation"]["auth_required"] is True and info["limitation"]["membership_required"] is True
    assert info["limitation"]["max_limit"] >= 1024, "nostr-mailbox pages stored reads 1,024 events at a time"
    assert {1, 11, 29, 42, 43}.issubset(info["supported_nips"])
    assert info["self"] == info["pubkey"] == RELAY_PUBKEY, "the key that signs invites and group state"
    status, headers, body = worker.http("HEAD", "/", headers={"Accept": "application/nostr+json"})
    assert (status, headers["Content-Type"], body) == (200, "application/nostr+json", b"")


def test_the_worker_does_not_start_without_its_signing_key(build):
    harness = _start_harness(build, RELAY_SIGNING_KEY=None)
    try:
        for accept in ("application/nostr+json", "text/html"):
            status, _, body = harness.http("GET", "/", headers={"Accept": accept})
            assert status == 500 and b"RELAY_SIGNING_KEY is not set" in body, (accept, status, body[:200])
    finally:
        harness.stop()
    harness = _start_harness(build, RELAY_SIGNING_KEY="f" * 64)            # not below the group order
    try:
        status, _, body = harness.http("GET", "/", headers={"Accept": "application/nostr+json"})
        assert status == 500 and b"RELAY_SIGNING_KEY is not a secp256k1 secret key" in body
    finally:
        harness.stop()


def test_the_worker_serves_the_visual_web_console_at_root(worker, tmp_path):
    status, headers, body = worker.http("GET", "/", headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"})
    assert status == 200 and headers["Content-Type"] == "text/html; charset=utf-8"
    assert worker.http("GET", "/")[0] == 200, "no Accept at all is a browser too"
    page = body.decode()
    assert page.startswith("<!doctype html>\n<html lang=\"en\">")
    parsed = _Collect()
    parsed.feed(page)
    tags = [t for t, _ in parsed.tags]
    for tag in ("html", "head", "meta", "title", "style", "body", "main", "script"):
        assert tag in tags, tag
    metas = [a for t, a in parsed.tags if t == "meta"]
    assert {"charset": "utf-8"} in metas
    assert any(a.get("name") == "viewport" and "width=device-width" in a.get("content", "") for a in metas)
    # Self-contained: no stylesheet, script or image from anywhere, links to GitHub and MayWe only,
    # and no other site named.
    _assert_links_and_invite_form(parsed, page, "'")
    assert "http://" not in page.replace('xmlns="http://www.w3.org/2000/svg"', "")
    script_urls = re.findall(r"https://[^\s'\"<>]+", re.search(r"<script>(.*?)</script>", page, re.DOTALL)[1])
    assert set(script_urls) == {SOURCE_URL, SUBSCRIBE_URL, DOCS_ORIGIN}
    # The CSP admits this script and this style, by hash, and connects to this relay and MayWe only.
    script = re.search(r"<script>(.*?)</script>", page, re.DOTALL).group(1)
    style = re.search(r"<style>(.*?)</style>", page, re.DOTALL).group(1)
    policy = dict(part.strip().split(" ", 1) for part in headers["Content-Security-Policy"].split(";"))
    digest = lambda text: "'sha256-" + base64.b64encode(hashlib.sha256(text.encode()).digest()).decode() + "'"
    assert policy["default-src"] == "'none'" and policy["frame-ancestors"] == "'none'"
    assert policy["script-src"] == digest(script) and policy["style-src"] == digest(style)
    assert policy["img-src"] == "'self' data:"
    assert policy["connect-src"] == f"'self' wss://{RELAY_HOST} https://newsletter.awow.io"
    assert policy["form-action"] == "'none'"
    assert headers["X-Content-Type-Options"] == "nosniff" and headers["Referrer-Policy"] == "no-referrer"
    # The script parses: the same engine family as the browsers that run it.
    (tmp_path / "console.js").write_text(script)
    checked = subprocess.run(["node", "--check", str(tmp_path / "console.js")], capture_output=True, text=True,
                             check=False)
    assert checked.returncode == 0, checked.stderr
    for needle in ("['AUTH', proof]", "kinds: [28935], limit: 1", "28934, [['-'], ['claim', code]]",
                   "publish(9007, [['h', id]]", "kinds: [9021], '#h': [id]", "kinds: [1059, 4410, 4411], '#p'",
                   "'wss://' + location.host", "window.nostr",
                   "history.replaceState(null, '', location.pathname + location.search);",
                   "$('maywe-form').addEventListener('submit', action(requestMayweInvite));"):
        assert needle in script, needle
    assert "innerHTML" not in script, "what the relay sends is text, never markup"
    # Full width, light and dark, like the GitHub Pages page.
    css = re.sub(r"/\*.*?\*/", "", style, flags=re.DOTALL)
    page_rule = re.search(r"\.page\s*\{([^}]*)\}", css).group(1)
    assert re.search(r"(^|;)\s*width:\s*100%", page_rule) and re.search(r"max-width:\s*none", page_rule)
    assert "padding-inline: clamp(20px, 3vw, 48px)" in page_rule
    assert re.findall(r"max-width\s*:\s*([^;}]+)", css) == ["none"], "no boxed max-width container anywhere"
    assert "@media (prefers-color-scheme: dark)" in css and "color-scheme: light dark" in css
    # The header names this relay and the key signed in, and the Mint button is in the controls bar.
    for needle in ('id="relay-url"', 'id="persona-npub"', 'id="theme"', 'id="room"', 'id="mint"', 'id="open-token"'):
        assert needle in page, needle
    assert page.index('id="maywe-card"') < page.index('id="pair-card"'), "the ways in before pairing"
    assert page.index('id="open-token"') < page.index('id="maywe-card"'), "redeeming is part of 01"
    assert "$('relay-url').textContent = RELAY_URL;" in script
    status, headers, body = worker.http("HEAD", "/", headers={"Accept": "text/html"})
    assert (status, headers["Content-Type"], body) == (200, "text/html; charset=utf-8", b"")
    status, _, body = worker.http("GET", "/", headers={"Accept": "application/nostr+json, */*"})
    assert status == 400 and b"application/nostr+json" in body


def test_the_worker_serves_the_same_console_where_invite_links_point(worker):
    """nostr-mailbox's `invite` and `topic invite` print a join_url of
    https://<relay host>/join/#nm1_…: /join and /join/ answer the console, as / does."""
    _, root_headers, root_page = worker.http("GET", "/", headers={"Accept": "text/html"})
    for path in CONSOLE_PATHS:
        status, headers, body = worker.http("GET", path, headers={"Accept": "text/html"})
        assert (status, body) == (200, root_page), path
        for name in ("Content-Type", "Content-Security-Policy", "Referrer-Policy", "X-Frame-Options"):
            assert headers[name] == root_headers[name], (path, name)
        assert worker.http("HEAD", path)[::2] == (200, b""), path


# The invite-link reader both pages carry, between these two lines, byte for byte.
READER = re.compile(r"^  // BEGIN invite-link reader\n.*?^  // END invite-link reader\n", re.DOTALL | re.MULTILINE)


def invite_token(**bundle) -> str:
    """An nm1_ token as nostr-mailbox's cli._encode_invite_token writes one: base64url,
    unpadded, of the bundle's JSON with sorted keys."""
    return nm1(json.dumps(bundle, sort_keys=True, separators=(",", ":")).encode())


def nm1(raw: bytes) -> str:
    return "nm1_" + base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def read_links(tmp_path: Path, reader: str, fragments: list[str]) -> list:
    """The pages' own reader, run under Node on each fragment: what it returned, or
    {"error": <message>} where it threw."""
    program = tmp_path / "read_links.cjs"
    program.write_text(reader + """
const fragments = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify(fragments.map((f) => {
  try { return readInviteLink(f); } catch (err) { return { error: err.message }; }
})));
""")
    cases = tmp_path / "fragments.json"
    cases.write_text(json.dumps(fragments))
    done = subprocess.run(["node", str(program), str(cases)], capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def test_both_pages_read_nostr_mailbox_invite_links_alike(worker, build, tmp_path):
    served = READER.search(worker.http("GET", "/join/")[2].decode())
    pages_page = (build / "github-pages" / "index.html").read_text()
    pages = READER.search(pages_page)
    assert served and pages and served.group(0) == pages.group(0), "one reader on both pages"
    # The GitHub Pages page's whole script parses, as the console's does.
    (tmp_path / "pages.js").write_text(re.search(r"<script>(.*?)</script>", pages_page, re.DOTALL).group(1))
    checked = subprocess.run(["node", "--check", str(tmp_path / "pages.js")], capture_output=True, text=True,
                             check=False)
    assert checked.returncode == 0, checked.stderr
    trust = {"schema": "cf.transport/1", "relay": f"wss://{RELAY_HOST}", "campaign": "my-campaign",
             "operator_pubkeys": [NIP19_NPUB]}
    code = hashlib.sha256(b"a relay invite code").hexdigest()
    relay_invite = invite_token(**trust, code=code, member="roland")
    dialled = invite_token(**{**trust, "relay": "ws://127.0.0.1:7777"}, relay_auth_url=f"wss://{RELAY_HOST}",
                           code=code)
    topic_invite = invite_token(**trust, code=code, topic="wave-7", group_code="g" * 43, redeem="ab" * 32,
                                epochs={"1": "cd" * 32}, current=1, owner=NIP19_HEX)
    elsewhere = invite_token(**{**trust, "relay": "wss://relay.other.example"}, code=code)
    got = read_links(tmp_path, served.group(0), [
        f"#{relay_invite}",
        f"#{relay_invite}&topic=wave-7&role=read-only&ticket=t1",
        f"#join={relay_invite}&topic=wave-7",
        f"#{dialled}",
        f"#{topic_invite}",
        f"#{elsewhere}",
        f"#invite={code}",
        "", "#", "#drop=npub1x/inbox",
        "#nm1_not!base64",
        "#" + nm1(b"not json"),
        "#" + nm1(b"[1, 2]"),
        "#" + nm1(json.dumps(trust).encode()),
        "#" + nm1(json.dumps({**trust, "schema": "cf.transport/2", "code": code}).encode()),
        "#" + nm1(json.dumps({**trust, "relay": "https://relay.example.com", "code": code}).encode()),
    ])
    relay_link = {"token": relay_invite, "code": code, "relay": f"wss://{RELAY_HOST}", "host": RELAY_HOST,
                  "campaign": "my-campaign", "member": "roland", "topic": None, "role": None, "channel": False}
    assert got[0] == relay_link
    assert got[1] == {**relay_link, "topic": "wave-7", "role": "read-only"}
    assert got[2] == {**relay_link, "topic": "wave-7"}
    assert got[3] == {**relay_link, "token": dialled, "member": None}, "the public name, not the loopback dial"
    assert got[4] == {**relay_link, "token": topic_invite, "member": None, "topic": "wave-7", "channel": True}
    assert (got[5]["host"], got[5]["relay"]) == ("relay.other.example", "wss://relay.other.example")
    assert got[6] == {"token": None, "code": code, "topic": None, "role": None}
    assert got[7:10] == [None, None, None]
    assert [g["error"] for g in got[10:]] == [
        "the link carries no readable nm1_ token", "the nm1_ token is not base64url JSON",
        "the nm1_ token holds no invite", "the nm1_ token carries no invite code",
        "the nm1_ token is not a cf.transport/1 invite", "the nm1_ token names no ws:// or wss:// relay"]


# The palettes a page declares: its light :root, the dark theme its toggle sets, and the
# dark theme the system asks for when no toggle chose one.
PALETTES = {
    "light": re.compile(r"^\s*:root\s*\{([^}]*)\}", re.MULTILINE),
    "dark": re.compile(r"^\s*:root\[data-theme=dark\]\s*\{([^}]*)\}", re.MULTILINE),
    "system dark": re.compile(r"@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme=light\]\)\s*\{([^}]*)\}"),
}


def palettes(style: str) -> dict[str, dict[str, str]]:
    css = re.sub(r"/\*.*?\*/", "", style, flags=re.DOTALL)
    return {name: dict(re.findall(r"(--[a-z-]+)\s*:\s*([^;]+?)\s*;", rule.search(css).group(1)))
            for name, rule in PALETTES.items()}


def test_both_pages_share_one_design_system(worker, build):
    """The console and the GitHub Pages page wear one design: the same light and dark
    palettes, the same type, the same header with its theme toggle under one storage key,
    and the same full-width gutters on the header and the page."""
    console = worker.http("GET", "/")[2].decode()
    pages = (build / "github-pages" / "index.html").read_text()
    styles = [re.search(r"<style>(.*?)</style>", p, re.DOTALL).group(1) for p in (console, pages)]
    scripts = [re.search(r"<script>(.*?)</script>", p, re.DOTALL).group(1) for p in (console, pages)]
    found = [palettes(s) for s in styles]
    assert found[0] == found[1], "one palette on both pages"
    colours = {"--bg", "--panel", "--ink", "--muted", "--line", "--soft", "--accent", "--green", "--red", "--amber",
               "--head", "--hover", "--paper", "--stone", "--quiet", "--rule", "--rule-strong", "--teal",
               "--terracotta", "--terracotta-ink", "--sage"}
    for theme in ("light", "dark"):
        assert colours <= set(found[0][theme]), theme
    assert found[0]["dark"] == found[0]["system dark"], "the toggle's dark is the system's dark"
    assert (found[0]["light"]["--paper"], found[0]["dark"]["--paper"]) == ("#faf9f6", "#14171c")
    for style, script, page in zip(styles, scripts, (console, pages), strict=True):
        assert "font: 16px/1.55 var(--sans)" in style
        assert "--serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif" in style
        assert "--mono: 'SFMono-Regular', ui-monospace, Menlo, Consolas, monospace" in style
        assert "font-variant-numeric: tabular-nums" in style
        top = re.search(r"\.top\s*\{([^}]*)\}", style).group(1)
        assert "height: 61px" in top and "padding-inline: clamp(20px, 3vw, 48px)" in top
        assert "position: sticky; top: 0; z-index: 10;" in top, "the header stays while the page scrolls"
        # A narrow screen never scrolls sideways: the right side keeps its width, the wordmark
        # gives way, and below 760px the repository's name and the long fields drop out.
        assert "flex: 0 0 auto;" in re.search(r"\.header-right\s*\{([^}]*)\}", style).group(1)
        assert re.search(r"\.wordmark\s*\{[^}]*flex: 1 1 auto;[^}]*min-width: 0;[^}]*text-overflow: ellipsis",
                         style)
        narrow = style[style.index("@media (width <= 760px)"):]
        assert re.search(r"[^{}]*\.hdr-repo[^{}]*\{ display: none; \}", narrow)
        assert '<button id="theme" type="button" aria-label="Switch color theme">◐</button>' in page
        assert '<span class="mark" aria-hidden="true">⨉</span>' in page
        assert re.search(r"""THEME_KEY = ['"]nostr-relay-deploy/theme['"];""", script)
        assert '<meta name="color-scheme" content="light dark">' in page


def test_nothing_before_auth_and_only_this_connections_proof_counts(worker):
    key = fresh_key()
    ws = worker.connect()
    verb, challenge = ws.recv()
    assert verb == "AUTH" and re.fullmatch(r"[0-9a-f]{64}", challenge)
    ws.send(["REQ", "early", {"kinds": [1]}])
    assert ws.recv() == ["CLOSED", "early", "auth-required: answer the AUTH challenge first"]
    early = key.event(1, [], "too early")
    assert publish(ws, early) == ["OK", early["id"], False, "auth-required: answer the AUTH challenge first"]
    now = int(time.time())
    wrong = {
        "another challenge": key.event(22242, [["relay", f"wss://{RELAY_HOST}"], ["challenge", "0" * 64]]),
        "another relay": key.event(22242, [["relay", "wss://other.example.com"], ["challenge", challenge]]),
        "a stale proof": key.event(22242, [["relay", f"wss://{RELAY_HOST}"], ["challenge", challenge]],
                                   created_at=now - 3600),
        "the wrong kind": key.event(1, [["relay", f"wss://{RELAY_HOST}"], ["challenge", challenge]]),
    }
    for what, proof in wrong.items():
        ws.send(["AUTH", proof])
        frame = ws.recv()
        assert frame[:3] == ["OK", proof["id"], False] and frame[3].startswith("invalid:"), what
    forged = dict(key.event(22242, [["relay", f"wss://{RELAY_HOST}/"], ["challenge", challenge]]))
    forged["content"] = "changed after signing"
    ws.send(["AUTH", forged])
    assert ws.recv() == ["OK", forged["id"], False, "invalid: id is not the hash of the event"]
    proof = key.event(22242, [["relay", f"wss://{RELAY_HOST}/"], ["challenge", challenge]])
    ws.send(["AUTH", proof])
    assert ws.recv() == ["OK", proof["id"], True, ""]
    ws.close()


def test_strangers_get_nothing_until_they_redeem_a_single_use_invite(worker):
    stranger, second = fresh_key(), fresh_key()
    ws = worker.connect()
    authenticate(ws, stranger)
    ws.send(["REQ", "s", {"kinds": [8891]}])
    assert ws.recv() == ["CLOSED", "s", "restricted: this key is not a member of the relay"]
    note = stranger.event(8891, [["t", "bus"]], "hello")
    assert publish(ws, note) == ["OK", note["id"], False, "restricted: this key is not a member of the relay"]

    invite = json.loads(run_shim(worker, "invites", "create", "--ttl", "168h", "--max-uses", "1", "--json").stdout)
    assert_ncli_invite(invite)
    assert invite["expires_at"] - invite["created_at"] == 168 * 3600

    borrowed = second.event(28934, [["-"], ["claim", invite["code"]]])
    reply = publish(ws, borrowed)
    assert reply[:3] == ["OK", borrowed["id"], False] and reply[3].startswith("restricted:")
    unknown = stranger.event(28934, [["-"], ["claim", "f" * 64]])
    assert publish(ws, unknown) == ["OK", unknown["id"], False, "restricted: the invite is unknown, spent or expired"]

    claim = stranger.event(28934, [["-"], ["claim", invite["code"]]])
    assert publish(ws, claim) == ["OK", claim["id"], True, ""]
    assert stored(ws, {"kinds": [8891]}) == []
    assert publish(ws, note) == ["OK", note["id"], True, ""]
    again = stranger.event(28934, [["-"], ["claim", invite["code"]]])
    assert publish(ws, again) == ["OK", again["id"], True, "duplicate: already a member"]

    late = worker.connect()
    authenticate(late, second)
    spent = second.event(28934, [["-"], ["claim", invite["code"]]])
    assert publish(late, spent) == ["OK", spent["id"], False, "restricted: the invite is unknown, spent or expired"]
    listed = json.loads(run_shim(worker, "invites", "list", "--json").stdout)["invites"]
    assert next(i for i in listed if i["code"] == invite["code"])["uses"] == 1
    ws.close()
    late.close()


def test_an_invite_expires_and_a_revoked_invite_is_dead(worker, clock):
    hour = json.loads(run_shim(worker, "invites", "create", "--ttl", "1h", "--json").stdout)
    assert hour["expires_at"] - hour["created_at"] == 3600
    revoked = json.loads(run_shim(worker, "invites", "create", "--ttl", "1h30m", "--json").stdout)
    assert revoked["expires_at"] - revoked["created_at"] == 5400
    assert run_shim(worker, "invites", "revoke", revoked["code"]).stdout.strip() == f"revoked {revoked['code']}"
    key = fresh_key()
    ws = worker.connect()
    authenticate(ws, key)
    dead = key.event(28934, [["-"], ["claim", revoked["code"]]])
    assert publish(ws, dead)[2] is False
    clock(2 * 3600)
    expired = key.event(28934, [["-"], ["claim", hour["code"]]])
    assert publish(ws, expired) == ["OK", expired["id"], False, "restricted: the invite is unknown, spent or expired"]
    ws.close()


def test_members_publish_query_and_receive_live_events(worker):
    alice, a = member(worker)
    bob, b = member(worker)
    b.send(["REQ", "live", {"kinds": [8891], "#t": ["bus"], "authors": [alice.pubkey]}])
    assert b.recv() == ["EOSE", "live"]

    note = alice.event(8891, [["t", "bus"], ["p", bob.pubkey]], 'line one\nline "two" ✓ \x01 \\ /')
    assert publish(a, note) == ["OK", note["id"], True, ""]
    assert b.recv() == ["EVENT", "live", note]
    other = alice.event(8891, [["t", "elsewhere"]], "not for bus")
    assert publish(a, other)[2] is True
    nothing_pending(b)

    assert publish(a, note) == ["OK", note["id"], True, "duplicate: already have this event"]
    base = int(time.time()) - 100
    older = [alice.event(8891, [["t", "page"]], f"#{i}", created_at=base + i) for i in range(4)]
    for event in older:
        assert publish(a, event)[2] is True
    page = stored(b, {"authors": [alice.pubkey], "#t": ["page"]})
    assert [e["content"] for e in page] == ["#3", "#2", "#1", "#0"], "newest first"
    assert stored(b, {"authors": [alice.pubkey], "#t": ["page"], "limit": 2}) == page[:2]
    assert stored(b, {"#t": ["page"], "since": base + 1, "until": base + 2}) == page[1:3]
    assert stored(b, {"ids": [older[0]["id"]]}, {"ids": [older[3]["id"], older[0]["id"]]}) == [older[3], older[0]]
    assert stored(b, {"#p": [bob.pubkey]}) == [note]
    assert stored(b, {"kinds": [8891], "#t": ["bus"], "authors": [bob.pubkey]}) == []

    forged = dict(alice.event(8891, [["t", "bus"]], "original"))
    forged["content"] = "forged"
    assert publish(a, forged) == ["OK", forged["id"], False, "invalid: id is not the hash of the event"]
    resigned = alice.event(8891, [["t", "bus"]], "x")
    resigned["sig"] = bob.event(8891, [["t", "bus"]], "x", created_at=resigned["created_at"])["sig"]
    assert publish(a, resigned) == ["OK", resigned["id"], False, "invalid: signature does not verify"]
    b.send(["REQ", "bad", {"search": "anything"}])
    assert b.recv() == ["CLOSED", "bad", 'invalid: unsupported filter key "search"']

    b.send(["CLOSE", "live"])
    after = alice.event(8891, [["t", "bus"]], "after close")
    assert publish(a, after)[2] is True
    nothing_pending(b)
    a.close()
    b.close()


def test_replaceable_addressable_ephemeral_and_expiring_events(worker, clock):
    alice, a = member(worker)
    _bob, b = member(worker)
    now = int(time.time())
    first = alice.event(0, [], '{"name":"one"}', created_at=now - 10)
    second = alice.event(0, [], '{"name":"two"}', created_at=now - 5)
    assert publish(a, first)[2] is True and publish(a, second)[2] is True
    stale = alice.event(0, [], '{"name":"stale"}', created_at=now - 20)
    assert publish(a, stale) == ["OK", stale["id"], True, "duplicate: a newer version is stored"]
    assert stored(b, {"kinds": [0], "authors": [alice.pubkey]}) == [second]

    head1 = alice.event(38881, [["d", "ac-3"]], "rev 1", created_at=now - 10)
    head2 = alice.event(38881, [["d", "ac-3"]], "rev 2", created_at=now - 5)
    other = alice.event(38881, [["d", "ac-4"]], "other address", created_at=now - 10)
    for event in (head1, head2, other):
        assert publish(a, event)[2] is True
    assert stored(b, {"kinds": [38881], "authors": [alice.pubkey], "#d": ["ac-3"]}) == [head2]
    assert {e["id"] for e in stored(b, {"kinds": [38881], "authors": [alice.pubkey]})} == {head2["id"], other["id"]}

    b.send(["REQ", "beat", {"kinds": [28880], "authors": [alice.pubkey]}])
    assert b.recv() == ["EOSE", "beat"]
    beat = alice.event(28880, [["t", "heartbeat"]], "alive")
    assert publish(a, beat) == ["OK", beat["id"], True, ""]
    assert b.recv() == ["EVENT", "beat", beat]
    assert stored(b, {"kinds": [28880], "authors": [alice.pubkey]}) == [], "ephemeral events are not stored"

    gone = alice.event(8891, [["expiration", str(now - 1)]], "already expired")
    assert publish(a, gone) == ["OK", gone["id"], False, "invalid: the event has already expired"]
    soon = alice.event(8891, [["expiration", str(now + 60)], ["t", "expiring"]], "expires in a minute")
    assert publish(a, soon)[2] is True
    assert stored(b, {"#t": ["expiring"]}) == [soon]
    clock(120)
    assert stored(b, {"#t": ["expiring"]}) == []
    a.close()
    b.close()


def test_protected_events_and_authors_who_are_not_members(worker):
    alice, a = member(worker)
    bob, _b = member(worker)
    stranger = fresh_key()
    relayed = bob.event(8891, [["t", "bus"]], "bob wrote, alice relays")
    assert publish(a, relayed) == ["OK", relayed["id"], True, ""]
    protected = bob.event(8891, [["-"], ["t", "bus"]], "only bob may publish this")
    assert publish(a, protected) == ["OK", protected["id"], False,
                                     "restricted: a protected event is accepted only from its author"]
    foreign = stranger.event(8891, [["t", "bus"]], "a stranger's words")
    assert publish(a, foreign) == ["OK", foreign["id"], False, "restricted: the event's author is not a member of the relay"]
    proof = alice.event(22242, [["relay", f"wss://{RELAY_HOST}"], ["challenge", "0" * 64]])
    assert publish(a, proof) == ["OK", proof["id"], False, "invalid: AUTH events go in an AUTH message"]
    a.send_raw(b"not json")
    assert a.recv()[0] == "NOTICE"
    a.close()


def test_revoking_a_member_closes_its_subscriptions_at_once(worker):
    alice, a = member(worker)
    carol, c = member(worker)
    c.send(["REQ", "watch", {"kinds": [8891]}])
    while c.recv() != ["EOSE", "watch"]:
        pass
    said = run_shim(worker, "members", "remove", carol.pubkey).stdout.strip()
    assert said == f"removed {carol.pubkey}"
    assert c.recv() == ["CLOSED", "watch", "restricted: membership revoked"]
    after = alice.event(8891, [["t", "bus"]], "carol must not see this")
    assert publish(a, after)[2] is True
    c.send(["REQ", "again", {"kinds": [8891]}])
    assert c.recv() == ["CLOSED", "again", "restricted: this key is not a member of the relay"]
    assert run_shim(worker, "members", "remove", carol.pubkey).stdout.strip() == f"was not a member {carol.pubkey}"
    a.close()
    c.close()


def test_rate_limit_caps_one_key_and_refills(tight_worker):
    key = fresh_key()
    ws = tight_worker.connect()
    authenticate(ws, key)
    for i in range(3):
        note = key.event(28934, [["-"], ["claim", f"{i:064x}"]])
        assert publish(ws, note)[3] == "restricted: the invite is unknown, spent or expired"
    burst = key.event(28934, [["-"], ["claim", "0" * 64]])
    assert publish(ws, burst) == ["OK", burst["id"], False, "rate-limited: at most 3 events a minute per key"]
    tight_worker.control("clock", {"offset_s": 20})        # a third of a minute: one token back
    ok = key.event(28934, [["-"], ["claim", "1" * 64]], created_at=int(time.time()) + 20)
    assert publish(ws, ok)[3].startswith("restricted:")
    ws.close()


# ========================================================================== Blossom
def test_blossom_members_upload_and_download_by_hash(worker):
    alice, a = member(worker)
    stranger = fresh_key()
    data = b"fixture bytes for a reproducer\n"
    sha = hashlib.sha256(data).hexdigest()

    def put(auth: str, body: bytes = data, path: str = "/upload"):
        return worker.http("PUT", path, body=body, headers={"Authorization": auth, "Content-Type": "text/plain"})

    def get(auth: str | None, path: str = f"/{sha}", method: str = "GET"):
        return worker.http(method, path, headers={"Authorization": auth} if auth else {})

    status, _, body = put(alice.blossom_auth("upload", sha, RELAY_HOST))
    assert status == 200
    assert json.loads(body) | {"uploaded": 0} == {"url": f"https://{RELAY_HOST}/media/{sha}", "sha256": sha,
                                                  "size": len(data), "type": "text/plain", "uploaded": 0}
    status, headers, body = get(alice.blossom_auth("get", sha, RELAY_HOST))
    assert (status, body, headers["Content-Type"]) == (200, data, "text/plain")
    assert headers["Cache-Control"] == "private, no-store"
    status, headers, body = get(alice.blossom_auth("get", sha, RELAY_HOST), f"/media/{sha}.txt", "HEAD")
    assert (status, headers["Content-Length"], body) == (200, str(len(data)), b"")
    status, _, _ = put(alice.blossom_auth("upload", sha, RELAY_HOST), path="/media/upload")
    assert status == 200, "uploading a blob the relay holds answers with its descriptor"

    refusals = {
        "no authorization": (get(None), 401),
        "a stranger": (get(stranger.blossom_auth("get", sha, RELAY_HOST)), 403),
        "another server": (get(alice.blossom_auth("get", sha, "other.example.com")), 401),
        "an expired token": (get(alice.blossom_auth("get", sha, RELAY_HOST, expires_in=-1)), 401),
        "a token for other blobs": (get(alice.blossom_auth("get", "cd" * 32, RELAY_HOST)), 403),
        "an upload token to download": (get(alice.blossom_auth("upload", sha, RELAY_HOST)), 401),
        "a download token to upload": (put(alice.blossom_auth("get", sha, RELAY_HOST)), 401),
        "bytes that are not the x tag": (put(alice.blossom_auth("upload", "cd" * 32, RELAY_HOST)), 400),
        "a stranger uploading": (put(stranger.blossom_auth("upload", sha, RELAY_HOST)), 403),
        "garbage": (get("Nostr not-base64-json"), 401),
        "a missing blob": (get(alice.blossom_auth("get", "ef" * 32, RELAY_HOST), f"/{'ef' * 32}"), 404),
    }
    for what, ((status, headers, _), wanted) in refusals.items():
        assert status == wanted, (what, status, headers.get("X-Reason"))
        assert headers.get("X-Reason"), what
    a.close()


def test_blossom_refuses_a_blob_over_the_size_limit(tight_worker):
    data = b"x" * 17                                    # MAX_BLOB_BYTES is 16 here
    status, headers, _ = tight_worker.http("PUT", "/upload", body=data, headers={
        "Authorization": fresh_key().blossom_auth("upload", hashlib.sha256(data).hexdigest(), RELAY_HOST)})
    assert status == 413 and "at most 16" in headers["X-Reason"]


# ============================================================ cf_ncli_shim contract
def test_the_shim_speaks_the_ncli_argv_nostr_mailbox_sends(worker):
    run_shim(worker, "members", "add", NIP19_NPUB)
    assert run_shim(worker, "members", "add", NIP19_HEX).stdout.strip() == f"already a member {NIP19_HEX}"
    listed = json.loads(run_shim(worker, "members", "list", "--json").stdout)["members"]
    assert NIP19_HEX in {m["pubkey"] for m in listed}
    assert NIP19_HEX in run_shim(worker, "members", "list").stdout.split()
    default = json.loads(run_shim(worker, "invites", "create", "--json").stdout)
    assert_ncli_invite(default)
    assert default["expires_at"] - default["created_at"] == 168 * 3600, "relay.yaml's inviteTTL is the default"
    plain = run_shim(worker, "invites", "create").stdout.strip()
    assert re.fullmatch(r"[0-9a-f]{64}", plain)
    assert run_shim(worker, "members", "remove", NIP19_NPUB).stdout.strip() == f"removed {NIP19_HEX}"


def test_the_shim_fails_loudly(worker, tight_worker, tmp_path):
    wrong = run_shim(worker, "members", "list", token="wrong", expect=1)
    assert "answered 404" in wrong.stderr and "ADMIN_TOKEN" in wrong.stderr
    hidden = run_shim(tight_worker, "members", "list", expect=1)
    assert "answered 404" in hidden.stderr
    missing = run_shim(worker, "members", "list", token=None, expect=2)
    assert "set ADMIN_TOKEN" in missing.stderr
    bad_ttl = run_shim(worker, "invites", "create", "--ttl", "7d", "--json", expect=1)
    assert "not a duration" in bad_ttl.stderr
    bad_key = run_shim(worker, "members", "add", "npub1notakey", expect=1)
    assert "npub" in bad_key.stderr
    token_file = tmp_path / "admin.token"
    token_file.write_text(ADMIN_TOKEN + "\n")
    done = subprocess.run([sys.executable, str(SHIM), "--url", worker.origin, "--token-file", str(token_file),
                           "ncli", "relay", "members", "list", "--json"],
                          capture_output=True, text=True, check=False,
                          env={k: v for k, v in os.environ.items() if k != "ADMIN_TOKEN"})
    assert done.returncode == 0 and "members" in json.loads(done.stdout)
    unreachable = subprocess.run([sys.executable, str(SHIM), "--url", "http://127.0.0.1:9", "ncli", "relay",
                                  "members", "list"], capture_output=True, text=True, check=False,
                                 env={**os.environ, "ADMIN_TOKEN": ADMIN_TOKEN})
    assert unreachable.returncode == 1 and "cannot reach" in unreachable.stderr


@pytest.mark.skipif(not os.environ.get("NOSTR_MAILBOX_SRC"),
                    reason="set NOSTR_MAILBOX_SRC=<nostr-mailbox checkout>/skills/nostr-mailbox to run "
                           "nostr-mailbox's own clients against the Worker")
def test_nostr_mailbox_itself_against_the_worker(worker, monkeypatch):
    sys.path.insert(0, os.environ["NOSTR_MAILBOX_SRC"])
    from nostr_mailbox import blossom, event, identity, relay  # type: ignore[import-not-found]

    monkeypatch.setenv("ADMIN_TOKEN", ADMIN_TOKEN)
    admin = relay.RelayAdmin(shlex.split(f"{shlex.quote(sys.executable)} {SHIM} --url {worker.origin}"),
                             timeout_s=event.DEFAULT_WAIT_S)
    invite = admin.create_invite()
    friend = identity.LocalSigner(Key.numbered(999_999).secret)
    url = f"ws://127.0.0.1:{worker.port}"
    with relay.RelayClient(url, friend, auth_url=f"wss://{RELAY_HOST}") as client:
        client.join(invite["code"])
        note = client.sign(8891, [["t", "bus"]], "from nostr-mailbox")
        client.publish(note)
        assert [e.id for e in client.query({"kinds": [8891], "#t": ["bus"], "authors": [friend.pubkey]})] == [note.id]
        blobs = blossom.BlossomClient(worker.origin, friend, server=RELAY_HOST)
        blob = blobs.upload(b"a fixture")
        assert blobs.download(blob.sha256) == b"a fixture"
    admin.remove_member(friend.pubkey)
    with relay.RelayClient(url, friend, auth_url=f"wss://{RELAY_HOST}") as client:
        with pytest.raises(relay.RelayRejected) as refused:
            client.query({"kinds": [8891]})
        assert refused.value.prefix == "restricted"


# ============================================== self-service: the Worker and ncli alike
class Refused(Exception):
    """The relay closed a REQ; the message is its reason."""


class Wire:
    """One socket, read the same way on the Worker and on the ncli relay. ncli repeats a
    refusal as a NOTICE before its CLOSED and answers a CLOSE with CLOSED "closed"; both are
    skipped here, so a scenario asserts only what the two relays both say."""

    def __init__(self, ws: WsClient):
        self.ws = ws
        self.closed: set[str] = set()

    def frame(self) -> list:
        while True:
            f = self.ws.recv()
            if f[0] == "NOTICE" or (f[0] == "CLOSED" and f[1] in self.closed):
                continue
            return f

    def auth(self, key: Key) -> None:
        verb, challenge = self.ws.recv()
        assert verb == "AUTH"
        proof = key.event(22242, [["relay", f"wss://{RELAY_HOST}"], ["challenge", challenge]])
        self.ws.send(["AUTH", proof])
        answer = self.frame()
        assert answer[:3] == ["OK", proof["id"], True], answer

    def publish(self, event: dict) -> tuple[bool, str]:
        self.ws.send(["EVENT", event])
        answer = self.frame()
        assert answer[:2] == ["OK", event["id"]], answer
        return answer[2], answer[3]

    def req(self, *filters: dict) -> tuple[str, list[dict]]:
        """Open a subscription and read it to EOSE. Refused when the relay closes it."""
        sub = os.urandom(6).hex()
        self.ws.send(["REQ", sub, *filters])
        events = []
        while True:
            f = self.frame()
            if f[:2] == ["EOSE", sub]:
                return sub, events
            if f[:2] == ["CLOSED", sub]:
                raise Refused(f[2])
            assert f[:2] == ["EVENT", sub], f
            events.append(f[2])

    def close(self, sub: str) -> None:
        self.closed.add(sub)
        self.ws.send(["CLOSE", sub])

    def read(self, *filters: dict) -> list[dict]:
        sub, events = self.req(*filters)
        self.close(sub)
        return events

    def refusal(self, *filters: dict) -> str:
        with pytest.raises(Refused) as caught:
            self.read(*filters)
        return str(caught.value)

    def live(self, sub: str) -> dict:
        f = self.frame()
        assert f[:2] == ["EVENT", sub], f
        return f[2]

    def quiet(self) -> None:
        """Nothing is queued for this socket: the next frame after a fresh REQ is its EOSE."""
        assert self.read({"ids": ["0" * 64]}) == []

    def invite(self) -> dict:
        """NIP-43: REQ kind 28935 answers one relay-signed invite, EOSE, and closes itself."""
        sub = os.urandom(6).hex()
        self.ws.send(["REQ", sub, {"kinds": [28935], "limit": 1}])
        f = self.frame()
        if f[:2] == ["CLOSED", sub]:
            raise Refused(f[2])
        assert f[:2] == ["EVENT", sub], f
        assert self.frame() == ["EOSE", sub]
        assert self.frame() == ["CLOSED", sub, "one-shot invite request completed"]
        self.closed.add(sub)
        return f[2]


class WorkerRelay:
    name = "worker"

    def __init__(self, harness: Harness):
        self.harness = harness
        self.port = harness.port

    def connect(self) -> Wire:
        return Wire(self.harness.connect())

    def admin(self, *args: str) -> str:
        return run_shim(self.harness, *args).stdout

    def http(self, method: str, headers: dict[str, str], path: str = "/"):
        return self.harness.http(method, path, headers=headers)


class NcliRelay:
    """The pinned ncli release, running on the hydrated relay.yaml in its own image."""
    name = "ncli"

    def __init__(self, container: str, port: int):
        self.container, self.port = container, port
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def connect(self) -> Wire:
        return Wire(WsClient(self.port))

    def admin(self, *args: str) -> str:
        """`ncli relay ...` inside the container, as nostr-mailbox's `--compose` runs it."""
        argv = ["docker", "exec", self.container, "ncli", "relay", *args, "--config", NCLI_CONFIG_IN_CONTAINER]
        done = subprocess.run(argv, capture_output=True, text=True, check=False)
        if done.returncode != 0:
            pytest.fail(f"{shlex.join(argv)} exited {done.returncode}\n{done.stdout}\n{done.stderr}")
        return done.stdout

    def http(self, method: str, headers: dict[str, str], path: str = "/"):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method, headers=headers)
        try:
            with self.opener.open(request) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read()

    def running(self) -> bool:
        done = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", self.container],
                              capture_output=True, text=True, check=False)
        return done.stdout.strip() == "true"

    def wait_until_serving(self) -> None:
        while True:
            if not self.running():
                logs = subprocess.run(["docker", "logs", self.container], capture_output=True, text=True, check=False)
                pytest.fail(f"the ncli relay stopped before it served:\n{logs.stdout[-3000:]}{logs.stderr[-3000:]}")
            try:
                if self.http("GET", {"Accept": "application/nostr+json"})[0] == 200:
                    return
            except (ConnectionError, urllib.error.URLError):
                pass                            # not listening yet; the container is still running
            time.sleep(0.1)


def booted_ncli(relay_yaml: str):
    """The pinned ncli relay on `relay_yaml`, serving on a loopback port, removed afterwards."""
    problem = docker_problem()
    if problem is not None:
        pytest.skip(problem)
    name = f"nostr-relay-deploy-test-{os.urandom(4).hex()}"
    started = subprocess.run(ncli_argv("-d", "--name", name, "-p", "127.0.0.1::5500"), env=ncli_env(relay_yaml),
                             capture_output=True, text=True, check=False)
    if started.returncode != 0:
        pytest.fail(f"docker run of the pinned ncli image failed:\n{started.stderr}")
    try:
        mapped = subprocess.run(["docker", "port", name, "5500/tcp"], capture_output=True, text=True,
                                check=True).stdout.splitlines()[0]
        relay = NcliRelay(name, int(mapped.rsplit(":", 1)[1]))
        relay.wait_until_serving()
        yield relay
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)


@pytest.fixture(scope="session")
def ncli_relay(build):
    yield from booted_ncli((build / "compose" / "relay.yaml").read_text())


@pytest.fixture
def limited_ncli_relay(tmp_path):
    """The pinned ncli relay hydrated with events_per_minute = 3."""
    data = example_dict()
    data["events_per_minute"] = 3
    (tmp_path / "relay.local.toml").write_text(dump_toml(data))
    yield from booted_ncli(hydrate.compose_files(hydrate.load_config(tmp_path / "relay.local.toml"))["relay.yaml"])


@pytest.fixture(params=["worker", "ncli"])
def relay(request):
    if request.param == "worker":
        return WorkerRelay(request.getfixturevalue("worker"))
    return request.getfixturevalue("ncli_relay")


def enrolled(relay, count: int) -> list[tuple[Key, Wire]]:
    """`count` fresh keys, enrolled by the operator's admin path, each with a signed-in socket."""
    out = []
    for _ in range(count):
        key = fresh_key()
        relay.admin("members", "add", key.pubkey)
        wire = relay.connect()
        wire.auth(key)
        out.append((key, wire))
    return out


def relay_pubkey(relay) -> str:
    status, _, body = relay.http("GET", {"Accept": "application/nostr+json"})
    assert status == 200
    return json.loads(body)["pubkey"]


def d_of(event: dict) -> str:
    return next((t[1] for t in event["tags"] if t[0] == "d" and len(t) > 1), "")


def test_a_member_mints_a_single_use_invite_over_the_websocket(relay, build):
    settings = relay_settings((build / "compose" / "relay.yaml").read_text())
    [(_alice, a)] = enrolled(relay, 1)
    invite = a.invite()
    assert invite["kind"] == 28935 and invite["content"] == ""
    assert invite["pubkey"] == relay_pubkey(relay) and event_is_signed(invite), "signed by the relay's own key"
    assert invite["tags"][0] == ["-"]
    code = next(t[1] for t in invite["tags"] if t[0] == "claim")
    listed = next(i for i in json.loads(relay.admin("invites", "list", "--json"))["invites"] if i["code"] == code)
    assert listed["max_uses"] == settings["membership.inviteMaxUses"] == 1 and listed["uses"] == 0
    assert listed["expires_at"] - listed["created_at"] == duration_seconds(settings["membership.inviteTTL"])

    newcomer, second = fresh_key(), fresh_key()
    n = relay.connect()
    n.auth(newcomer)
    assert n.refusal({"ids": ["0" * 64]}).startswith("restricted:")
    assert n.refusal({"kinds": [28935], "limit": 1}).startswith("restricted:"), "a stranger mints nothing"
    assert n.publish(newcomer.event(28934, [["-"], ["claim", code]]))[0] is True
    assert n.read({"ids": ["0" * 64]}) == [], "the code enrolled the newcomer"
    s = relay.connect()
    s.auth(second)
    assert s.publish(second.event(28934, [["-"], ["claim", code]]))[0] is False, "and only the newcomer"
    assert s.refusal({"ids": ["0" * 64]}).startswith("restricted:")
    anonymous = relay.connect()
    assert anonymous.ws.recv()[0] == "AUTH"
    with pytest.raises(Refused, match="^auth-required:"):
        anonymous.invite()


def test_members_run_private_nip29_groups_themselves(relay):
    (alice, a), (bob, b), (carol, c) = enrolled(relay, 3)
    g = f"standup-{os.urandom(4).hex()}"
    need = f"restricted: valid membership in group {g} is required"
    assert a.publish(alice.event(9007, [["h", g]])) == (True, f"info: group {g} created.")
    state = {e["kind"]: e for e in a.read({"kinds": [39000, 39001, 39002], "#d": [g]})}
    assert set(state) == {39000, 39001, 39002}
    assert all(e["pubkey"] == relay_pubkey(relay) and event_is_signed(e) for e in state.values())
    assert {"private", "closed"} <= {t[0] for t in state[39000]["tags"] if len(t) == 1}
    assert ["p", alice.pubkey, "admin"] in state[39001]["tags"]
    assert [t for t in state[39002]["tags"] if t[0] == "p"] == [["p", alice.pubkey]]

    # Bob is a member of the relay, not of the group: none of it is his to read or write.
    assert b.refusal({"#h": [g]}) == need
    assert b.refusal({"kinds": [39000], "#d": [g]}) == need
    assert g not in {d_of(e) for e in b.read({"kinds": [39000]})}
    assert b.publish(bob.event(9, [["h", g]], "may I post?")) == (False, f"restricted: only members may post in group {g}")
    assert b.publish(bob.event(9007, [["h", g]])) == (False, "duplicate: a group with that id already exists.")

    # pendingJoins: his join request waits for the group's admin.
    ask = bob.event(9021, [["h", g]], "the standup notes, please")
    assert b.publish(ask) == (True, "info: your join request is pending admin approval.")
    assert [e["id"] for e in a.read({"kinds": [9021], "#h": [g]})] == [ask["id"]]
    assert b.publish(bob.event(9000, [["h", g], ["p", bob.pubkey]])) == (
        False, "restricted: you may not add members to this group.")
    assert a.publish(alice.event(9000, [["h", g], ["p", bob.pubkey]])) == (True, "info: member added.")
    assert a.read({"kinds": [9021], "#h": [g]}) == [], "an accepted request is no longer pending"
    seats = a.read({"kinds": [39002], "#d": [g]})[0]
    assert {t[1] for t in seats["tags"] if t[0] == "p"} == {alice.pubkey, bob.pubkey}

    # In, bob posts and reads; carol, outside, sees none of it, not even the group's existence.
    note = bob.event(9, [["h", g]], "hello group")
    assert b.publish(note) == (True, "")
    assert b.read({"kinds": [9], "#h": [g]}) == [note]
    assert note["id"] not in {e["id"] for e in c.read({"kinds": [9]})}
    assert c.refusal({"#h": [g]}) == need
    assert g not in {d_of(e) for e in c.read({"kinds": [39002], "#p": [alice.pubkey]})}
    # moderationLog: the group reads the moderation it accepted.
    assert {e["kind"] for e in b.read({"kinds": [9000, 9007], "#h": [g]})} == {9000, 9007}

    # Only an admin edits the metadata, and an edit replaces it whole.
    assert b.publish(bob.event(9002, [["h", g], ["name", "mine now"]])) == (
        False, "restricted: only a group admin may edit this group's metadata.")
    edit = alice.event(9002, [["h", g], ["name", "Standup"], ["private"], ["closed"]])
    assert a.publish(edit) == (True, "info: group metadata updated.")
    meta = a.read({"kinds": [39000], "#d": [g]})[0]
    assert sorted(t for t in meta["tags"] if t[0] != "d") == [["closed"], ["name", "Standup"], ["private"]]

    # Removed, bob is outside again.
    assert a.publish(alice.event(9001, [["h", g], ["p", bob.pubkey]])) == (True, "info: member removed.")
    assert b.refusal({"#h": [g]}) == need
    assert b.publish(bob.event(9, [["h", g]], "still here?")) == (False, f"restricted: only members may post in group {g}")
    assert c.publish(carol.event(9021, [["h", f"no-such-{g}"]])) == (False, "restricted: no such group.")


def test_a_group_invite_code_admits_one_key_at_once(relay):
    """NIP-29 9009: an admin registers a code, and a join request carrying it is admitted at
    once, one key, once. The code is for the group's admins to read, and the request that
    spent it is not kept. nostr-mailbox's `topic invite` and `join` run on exactly this."""
    (alice, a), (bob, b), (carol, c) = enrolled(relay, 3)
    g = f"invites-{os.urandom(4).hex()}"
    code = os.urandom(16).hex()
    assert a.publish(alice.event(9007, [["h", g]])) == (True, f"info: group {g} created.")
    assert b.publish(bob.event(9009, [["h", g], ["code", code]])) == (
        False, "restricted: only a group admin may create invites.")
    assert a.publish(alice.event(9009, [["h", g]])) == (False, "invalid: nip29: missing code tag (invite code)")
    invite = alice.event(9009, [["h", g], ["code", code]])
    assert a.publish(invite) == (True, "info: invite created.")
    assert [e["id"] for e in a.read({"kinds": [9009], "#h": [g]})] == [invite["id"]]

    assert b.publish(bob.event(9021, [["h", g], ["code", code]], "with the code")) == (
        True, "info: welcome to the group!")
    seats = a.read({"kinds": [39002], "#d": [g]})[0]
    assert {t[1] for t in seats["tags"] if t[0] == "p"} == {alice.pubkey, bob.pubkey}
    assert [e["kind"] for e in b.read({"kinds": [9007], "#h": [g]})] == [9007], "in, bob reads the group"
    assert b.read({"kinds": [9009], "#h": [g]}) == [], "a code is for the group's admins"
    assert a.read({"kinds": [9021], "#h": [g]}) == [], "the request that spent the code is not kept"
    assert b.publish(bob.event(9021, [["h", g], ["code", code]], "again")) == (
        True, "duplicate: you are already a member of this group.")

    # One key, once: the spent code, and one never registered, admit nobody else.
    for tried in (code, os.urandom(16).hex()):
        assert c.publish(carol.event(9021, [["h", g], ["code", tried]])) == (
            False, "restricted: that is an invalid invite code.")
    assert c.refusal({"#h": [g]}) == f"restricted: valid membership in group {g} is required"


def test_recipient_only_kinds_reach_only_the_key_they_name(relay, build):
    kinds = relay_settings((build / "compose" / "relay.yaml").read_text())["recipientOnlyKinds"]
    (alice, a), (bob, b), (_carol, c) = enrolled(relay, 3)
    to_bob, _ = b.req({"kinds": kinds, "authors": [alice.pubkey]})
    _to_carol, _ = c.req({"kinds": kinds, "authors": [alice.pubkey]})
    base = int(time.time())
    public = alice.event(1, [["p", bob.pubkey]], "anyone may read this", created_at=base - 60)
    assert a.publish(public) == (True, "")
    sealed = []
    for i, kind in enumerate(kinds):
        event = alice.event(kind, [["p", bob.pubkey]], f"sealed for bob, kind {kind}", created_at=base - i)
        assert a.publish(event) == (True, ""), kind
        assert b.live(to_bob) == event, "the recipient gets it live"
        sealed.append(event)
    c.quiet()                                   # and no one else does
    assert sorted(e["id"] for e in b.read({"kinds": kinds})) == sorted(e["id"] for e in sealed)
    assert c.read({"kinds": kinds}) == []
    assert c.read({"ids": [e["id"] for e in sealed]}) == [], "not even by id"
    assert a.read({"kinds": kinds, "authors": [alice.pubkey]}) == [], "not even to their author"
    newest = c.read({"authors": [alice.pubkey], "limit": 1})
    if relay.name == "worker":
        assert newest == [public], "what a reader may not see uses up none of its limit"
    else:
        # The one difference: the pinned ncli applies `limit` before it drops what the reader
        # may not see, so a hidden newer event leaves this answer empty. README says so.
        assert newest == [], "ncli changed how limit meets recipientOnlyKinds: update this and the README"


def test_a_gift_wrap_under_a_one_time_key_is_refused_like_any_stranger(relay):
    """A members-only relay takes events only by enrolled authors, so a NIP-59 gift wrap
    signed by a one-time key is refused on both relays, whoever sends it."""
    (_alice, a), (bob, _b) = enrolled(relay, 2)
    wrap = fresh_key().event(1059, [["p", bob.pubkey]], "sealed under a one-time key")
    assert a.publish(wrap)[0] is False


def test_root_answers_a_browser_and_a_nip11_client_on_both_relays(relay):
    for method in ("GET", "HEAD"):
        status, headers, body = relay.http(method, {"Accept": "text/html"})
        assert status == 200 and headers["Content-Type"].startswith("text/html"), (method, status)
        assert (body == b"") == (method == "HEAD")
        status, headers, _ = relay.http(method, {"Accept": "application/nostr+json"})
        assert status == 200 and headers["Content-Type"] == "application/nostr+json", (method, status)
    assert relay.http("GET", {"Accept": "application/nostr+json, */*"})[0] == 400, "neither relay guesses"


def test_only_the_worker_has_a_page_where_invite_links_point(relay):
    """The Worker serves its console at /join and /join/; the pinned ncli answers 404 there,
    which is why the Caddyfile and the IngressRoute keep them shut (WORKER_ONLY in the edge
    table). Should a later ncli serve a page there, this fails: open /join on those edges."""
    for path in CONSOLE_PATHS:
        status, headers, _ = relay.http("GET", {"Accept": "text/html"}, path=path)
        if relay.name == "worker":
            assert status == 200 and headers["Content-Type"].startswith("text/html"), path
        else:
            assert status == 404, (path, status)


def nostr_mailbox_cli(home: Path, *args: str) -> dict:
    """nostr-mailbox's own CLI, in a home of its own. `--home` also keeps `join` from
    installing plugins and tools on this machine, which it does for a default home."""
    script = Path(os.environ["NOSTR_MAILBOX_SRC"]) / "scripts" / "nostr_mailbox.py"
    done = subprocess.run([sys.executable, str(script), "--home", str(home), *args], capture_output=True,
                          text=True, check=False)
    if done.returncode != 0:
        pytest.fail(f"nostr-mailbox {shlex.join(args)} exited {done.returncode}\n{done.stdout}\n{done.stderr}")
    return json.loads(done.stdout)


@pytest.mark.skipif(not os.environ.get("NOSTR_MAILBOX_SRC"),
                    reason="set NOSTR_MAILBOX_SRC=<nostr-mailbox checkout>/skills/nostr-mailbox to run "
                           "nostr-mailbox's own CLI against both relays")
def test_a_nostr_mailbox_join_url_admits_a_newcomer(relay, tmp_path):
    """The operator's `setup` and `invite`, then a newcomer's `join '<join_url>'` and
    `relay check`: nostr-mailbox's own CLI, start to finish, on both relays. On the Worker
    the join_url's page reads the very code the CLI then redeems."""
    sys.path.insert(0, os.environ["NOSTR_MAILBOX_SRC"])
    from nostr_mailbox import bech32  # type: ignore[import-not-found]

    url = f"ws://127.0.0.1:{relay.port}"
    setup = nostr_mailbox_cli(tmp_path / "operator", "setup", "--relay", url, "--campaign", "demo")
    trust = Path(setup["trust_file"])
    # The operator dials the relay on loopback; NIP-42 proofs and the join_url name the
    # relay's public host, as for a seat that reaches the relay through a port-forward.
    trust.write_text(trust.read_text() + f'relay_auth_url = "wss://{RELAY_HOST}"\n')
    relay.admin("members", "add", bech32.pubkey_hex(setup["npub"]))
    invite = nostr_mailbox_cli(tmp_path / "operator", "invite")
    assert invite["via"] == "websocket (NIP-43 kind 28935)", "a member mints it: memberClaims is on"
    token = invite["token"]
    assert invite["join_url"] == f"https://{RELAY_HOST}/join/#{token}"
    if relay.name == "worker":
        page = relay.http("GET", {"Accept": "text/html"}, path="/join/")[2].decode()
        [read] = read_links(tmp_path, READER.search(page).group(0), ["#" + invite["join_url"].split("#", 1)[1]])
        assert (read["code"], read["host"], read["campaign"], read["channel"]) == (invite["code"], RELAY_HOST,
                                                                                  "demo", False)
    joined = nostr_mailbox_cli(tmp_path / "newcomer", "join", invite["join_url"])
    assert (joined["joined"], joined["campaign"]) == (url, "demo")
    check = nostr_mailbox_cli(tmp_path / "newcomer", "relay", "check")
    assert (check["ok"], check["authenticated"], check["relay_access"]) == (True, True, True)


# ======================================================= self-service: the Worker only
def test_the_worker_keeps_group_state_its_own(worker):
    (alice, a), (bob, b) = enrolled(WorkerRelay(worker), 2)
    g = f"ops-{os.urandom(4).hex()}"
    assert a.publish(alice.event(9007, [["h", g]])) == (True, f"info: group {g} created.")
    meta = a.read({"kinds": [39000], "#d": [g]})[0]
    assert meta["tags"] == [["d", g], ["private"], ["restricted"], ["closed"]]
    roles = a.read({"kinds": [39003], "#d": [g]})[0]
    assert roles["tags"] == [["d", g], ["role", "admin", "may put-user, remove-user, edit-metadata, create-invite"]]
    assert event_is_signed(roles) and roles["pubkey"] == RELAY_PUBKEY
    for kind in (39000, 39002, 28935):
        forged = alice.event(kind, [["d", g], ["p", alice.pubkey]])
        assert a.publish(forged) == (False, f"restricted: kind {kind} is signed by the relay alone")
    assert a.publish(alice.event(9007, [["h", "Not An Id"]])) == (
        False, "invalid: a group id is made of a-z, 0-9, '-' and '_' (NIP-29)")
    assert a.publish(alice.event(9007, [])) == (False, "invalid: nip29: missing h tag (group id)")
    assert a.publish(alice.event(9005, [["h", g], ["e", "0" * 64]])) == (
        False, "invalid: kind 9005 is not a NIP-29 request this relay implements (9000, 9001, 9002, 9007, 9009, 9021, 9022)")
    # A group never loses its last admin.
    assert a.publish(alice.event(9001, [["h", g], ["p", alice.pubkey]])) == (
        False, "restricted: the group's last admin cannot be removed.")
    assert a.publish(alice.event(9000, [["h", g], ["p", alice.pubkey]])) == (
        False, "restricted: the group's last admin cannot be demoted.")
    assert a.publish(alice.event(9022, [["h", g]])) == (False, "restricted: the group's last admin cannot leave it.")
    # A group request counts only from its author, and a replay re-applies nothing.
    put = alice.event(9000, [["h", g], ["p", bob.pubkey]])
    assert b.publish(put) == (False, "restricted: a group request is accepted only from the key that authenticated")
    assert a.publish(put) == (True, "info: member added.")
    assert a.publish(alice.event(9001, [["h", g], ["p", bob.pubkey]])) == (True, "info: member removed.")
    assert a.publish(put) == (True, "duplicate: already have this event")
    seats = a.read({"kinds": [39002], "#d": [g]})[0]
    assert [t for t in seats["tags"] if t[0] == "p"] == [["p", alice.pubkey]]
    # Open, the group admits a join at once; closed, it would have waited.
    assert a.publish(alice.event(9002, [["h", g], ["name", "open house"]])) == (True, "info: group metadata updated.")
    assert b.publish(bob.event(9021, [["h", g]], "hi")) == (True, "info: you joined the group.")
    assert b.publish(bob.event(9021, [["h", g]], "hi again")) == (True, "duplicate: you are already a member of this group.")
    assert b.publish(bob.event(9022, [["h", g]])) == (True, "info: you have left the group.")
    assert b.publish(bob.event(9022, [["h", g]], "again")) == (True, "duplicate: you are not a member of this group.")
    later = [e["created_at"] for e in a.read({"kinds": [39002], "#d": [g]})]
    assert len(later) == 1 and later[0] > seats["created_at"], "each state replaces the one before it"


def test_a_private_group_stays_private_on_live_subscriptions(worker):
    (alice, a), (bob, b), (carol, c) = enrolled(WorkerRelay(worker), 3)
    g = f"live-{os.urandom(4).hex()}"
    assert a.publish(alice.event(9007, [["h", g]]))[0] is True
    assert a.publish(alice.event(9000, [["h", g], ["p", bob.pubkey]]))[0] is True
    group_feed, _ = a.req({"kinds": [9]})
    _outside_feed, _ = c.req({"kinds": [9]})
    note = bob.event(9, [["h", g]], "for the group only")
    assert b.publish(note) == (True, "")
    assert a.live(group_feed) == note
    c.quiet()
    admin_queue, _ = a.req({"kinds": [9021], "#h": [g]})
    _member_view, _ = b.req({"kinds": [9021], "#h": [g]})
    ask = carol.event(9021, [["h", g]], "me too")
    assert c.publish(ask) == (True, "info: your join request is pending admin approval.")
    assert a.live(admin_queue) == ask, "the admin sees a join request at once"
    b.quiet()                                   # a plain member does not
    assert c.refusal({"kinds": [9021], "#h": [g]}) == f"restricted: valid membership in group {g} is required"
    assert c.publish(carol.event(9022, [["h", g]])) == (True, "info: your join request is withdrawn.")
    assert a.read({"kinds": [9021], "#h": [g]}) == []


def test_minting_invites_spends_the_key_rate_limit(limited_worker):
    [(_alice, a)] = enrolled(WorkerRelay(limited_worker), 1)
    for _ in range(3):
        a.invite()
    assert a.refusal({"kinds": [28935], "limit": 1}) == "rate-limited: at most 3 events and invites a minute per key"


def test_minting_invites_spends_the_key_read_budget_on_ncli(limited_ncli_relay, build):
    """The pinned ncli answers a member's mint (REQ kind 28935) from limits.reads: with
    events_per_minute codes a minute per key, as the Worker caps it, and another key mints on."""
    [(_alice, a), (_bob, b)] = enrolled(limited_ncli_relay, 2)
    for _ in range(3):
        a.invite()
    refused = a.refusal({"kinds": [28935], "limit": 1})
    assert refused.startswith("rate-limited"), refused
    assert b.invite()["kind"] == 28935, "the budget is per key"
    settings = relay_settings((build / "compose" / "relay.yaml").read_text())
    assert settings["limits.reads.perPubkey"] == settings["limits.events.perPubkey"] == "{events: 60, per: 1m, burst: 60}"


# ============================================================= the remote MCP server
class Mcp:
    """A remote MCP client as ChatGPT and Claude.ai speak Streamable HTTP: JSON-RPC POSTs to
    /mcp carrying the token (as a bearer header, in the query, or in the path of a magic URL
    /mcp/s/<token> with no authentication at all), and the Mcp-Session-Id that initialize
    hands out. The bearer header also carries an OAuth access token."""

    def __init__(self, harness: Harness, token: str, *, in_url: bool = False, magic: bool = False):
        self.harness, self.token, self.in_url, self.magic = harness, token, in_url, magic
        self.session: str | None = None
        self.seq = 0

    def post(self, message, *, session: str | None = None):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if not (self.in_url or self.magic):
            headers["Authorization"] = f"Bearer {self.token}"
        if session or self.session:
            headers["Mcp-Session-Id"] = session or self.session
            headers["MCP-Protocol-Version"] = "2025-06-18"
        path = f"/mcp/s/{self.token}" if self.magic else f"/mcp?token={self.token}" if self.in_url else "/mcp"
        return self.harness.http("POST", path, headers=headers, body=json.dumps(message).encode())

    def rpc(self, method: str, params: dict | None = None) -> dict:
        self.seq += 1
        status, headers, body = self.post({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params or {}})
        assert status == 200, (status, body)
        reply = json.loads(body)
        assert reply["id"] == self.seq, reply
        if method == "initialize":
            self.session = headers["Mcp-Session-Id"]
        return reply

    def initialize(self) -> dict:
        init = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                       "clientInfo": {"name": "a remote MCP client", "version": "1"}})
        status, _, body = self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        assert (status, body) == (202, b"")
        return init["result"]

    def result(self, name: str, arguments: dict | None = None) -> dict:
        return self.rpc("tools/call", {"name": name, "arguments": arguments or {}})["result"]

    def call(self, name: str, arguments: dict | None = None) -> dict:
        result = self.result(name, arguments)
        assert result["isError"] is False, result["content"][0]["text"]
        assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
        return result["structuredContent"]

    def refusal(self, name: str, arguments: dict | None = None) -> str:
        result = self.result(name, arguments)
        assert result["isError"] is True, result
        return result["content"][0]["text"]


def action(harness: Harness, token: str, tool: str, arguments: dict, *, magic: bool = False) -> tuple[int, dict]:
    """One OpenAPI Action call, as a Custom GPT makes it: POST /tools/<tool> with the token,
    or POST /mcp/s/<token>/tools/<tool> under a magic URL with no authentication."""
    path, auth = (f"/mcp/s/{token}/tools/{tool}", {}) if magic else (f"/tools/{tool}", {"Authorization": f"Bearer {token}"})
    status, _, body = harness.http("POST", path, body=json.dumps(arguments).encode(),
                                   headers={**auth, "Content-Type": "application/json"})
    return status, json.loads(body)


def admin_invite_code(harness: Harness) -> str:
    status, _, body = harness.http("POST", "/_admin/invites", body=json.dumps({"ttl_seconds": 3600, "max_uses": 1}).encode(),
                                   headers={"Authorization": f"Bearer {ADMIN_TOKEN}", "Content-Type": "application/json"})
    assert status == 201, body
    return json.loads(body)["code"]


def org_token(harness: Harness, campaign: str, **declared) -> str:
    """An org-scope token as nostr-mailbox's `invite` mints one: the campaign's declaration,
    with its campaign_key (epoch 1 of its bus), and a relay invite code."""
    bundle = {"schema": "cf.transport/1", "relay": f"wss://{RELAY_HOST}", "campaign": campaign,
              "operator_pubkeys": [fresh_key().pubkey],
              "campaign_key": hashlib.sha256(f"campaign key of {campaign}".encode()).hexdigest(),
              "code": admin_invite_code(harness), **declared}
    return invite_token(**bundle)


def test_the_mcp_endpoints_take_only_a_token_for_this_relay(worker):
    """Every MCP route wants a token, from the bearer header or the URL, for this relay and
    still good here; a session is bound to its token; GET /mcp is no stream."""
    token = org_token(worker, f"edge-{os.urandom(3).hex()}")

    for method, path in (("POST", "/mcp"), ("DELETE", "/mcp"), ("GET", "/openapi.json"), ("POST", "/tools/mailbox_list")):
        status, headers, body = worker.http(method, path, body=b"{}" if method == "POST" else None)
        assert status == 401 and json.loads(body)["error"].startswith("an nm1_ invite token is required"), (path, body)
        assert headers["WWW-Authenticate"].startswith("Bearer")
    status, headers, _ = worker.http("GET", "/mcp", headers={"Authorization": f"Bearer {token}"})
    assert (status, headers["Allow"]) == (405, "POST, DELETE"), "this server sends nothing unasked: no stream"

    elsewhere = invite_token(**{**json.loads(base64.urlsafe_b64decode(token[4:] + "==")), "relay": "wss://relay.other.test"})
    refusals = {
        "elsewhere": (elsewhere, "this token is for wss://relay.other.test, not for wss://relay.example.com"),
        "unreadable": ("nm1_bm90IGpzb24", "the nm1_ token is not base64url JSON"),
        "no token": ("an-api-key", "give an nm1_ token, or a …/join/#nm1_… link"),
    }
    for presented, reason in refusals.values():
        status, _, body = worker.http("GET", "/openapi.json", headers={"Authorization": f"Bearer {presented}"})
        assert (status, json.loads(body)) == (401, {"error": reason})
    status, _, body = worker.http("GET", f"/openapi.json?token={token}", headers={"Authorization": f"Bearer {elsewhere}"})
    assert (status, json.loads(body)) == (400, {"error": "the Authorization header and ?token= carry two different tokens"})

    status, _, body = worker.http("GET", f"/openapi.json?token={token}")
    doc = json.loads(body)
    assert (status, doc["openapi"], doc["servers"]) == (200, "3.1.0", [{"url": f"https://{RELAY_HOST}"}])
    assert doc["components"]["securitySchemes"]["nm1"] == {
        "type": "http", "scheme": "bearer", "description": "An nm1_ invite token minted by nostr-mailbox (topic invite)."}
    tools = ["mailbox_list", "mailbox_invite", "mailbox_join", "mailbox_post", "mailbox_watch", "mailbox_board"]
    assert [p["post"]["operationId"] for p in doc["paths"].values()] == tools
    assert list(doc["paths"]) == [f"/tools/{t}" for t in tools]
    assert all(len(p["post"]["description"]) <= 300 for p in doc["paths"].values()), "GPT Actions cap descriptions"

    mcp = Mcp(worker, token)
    init = mcp.initialize()
    assert (init["protocolVersion"], init["capabilities"]) == ("2025-06-18", {"tools": {"listChanged": False}})
    assert [t["name"] for t in mcp.rpc("tools/list")["result"]["tools"]] == tools
    assert mcp.rpc("ping")["result"] == {}
    assert mcp.rpc("resources/list")["error"] == {"code": -32601, "message": "method not found: resources/list"}
    assert mcp.rpc("tools/call", {"name": "mailbox_nope"})["error"]["code"] == -32602
    assert mcp.rpc("tools/call", {"name": "mailbox_post", "arguments": {"channel": "bus", "body": "x", "files": ["a"]}})[
        "error"] == {"code": -32602, "message": "mailbox_post takes [\"body\",\"channel\",\"kind\",\"org\",\"persona\","
                                                "\"reply_to\",\"subject\"]; unknown: [\"files\"]"}
    status, _, body = mcp.post(b"not json".decode())
    assert status == 200 and json.loads(body)["error"]["code"] == -32600, "a JSON string is no JSON-RPC message"
    status, _, body = worker.http("POST", "/mcp", body=b"{", headers={"Authorization": f"Bearer {token}"})
    assert (status, json.loads(body)["error"]["code"]) == (400, -32700)

    # A session is its token's: another token cannot use it, and once ended it is gone.
    other = Mcp(worker, org_token(worker, f"edge-{os.urandom(3).hex()}"))
    status, _, body = other.post({"jsonrpc": "2.0", "id": 1, "method": "ping"}, session=mcp.session)
    assert (status, json.loads(body)["error"]["code"]) == (404, -32001)
    status, _, _ = worker.http("DELETE", "/mcp", headers={"Authorization": f"Bearer {token}", "Mcp-Session-Id": mcp.session})
    assert status == 204
    status, _, _ = mcp.post({"jsonrpc": "2.0", "id": 9, "method": "ping"})
    assert status == 404, "an ended session answers 404, and the client initializes again"

    # The plain-JSON twin: the same tool, the same refusals, by HTTP status.
    assert action(worker, token, "mailbox_nope", {})[0] == 404
    assert action(worker, token, "mailbox_post", {"channel": "bus"}) == (400, {"error": "mailbox_post needs [\"body\"]"})
    assert action(worker, token, "mailbox_post", {"channel": "elsewhere", "body": "hi"}) == (
        422, {"error": "channel \"elsewhere\" is neither 'bus' nor this token's campaign bus"})


def test_two_personas_of_one_token_talk_on_its_campaign_bus(worker):
    """An org token redeems itself on first use; a second persona of the same token is
    introduced by the first, through a member-minted invite; what one posts the other
    reads, decrypted, while the relay stores only NIP-44 ciphertext under epoch 1."""
    campaign = f"edge-{os.urandom(3).hex()}"
    token = org_token(worker, campaign)
    mcp = Mcp(worker, token)
    mcp.initialize()
    before = mcp.call("mailbox_list")
    persona = before["persona"]
    assert (before["relay_member"], before["campaign"], before["token"]["redeemed"]) == (False, campaign, False)

    body = "an edge note, sealed under the campaign key"
    status, posted = action(worker, token, "mailbox_post", {"channel": "bus", "body": body, "subject": "hello"})
    assert (status, posted["accepted"], posted["duplicate"], posted["topic"]) == (200, True, False, "bus"), posted
    assert 0 < posted["bytes_used"] < posted["bytes_cap"] == 16_384
    again = mcp.call("mailbox_post", {"channel": "bus", "body": body, "subject": "hello"})
    assert (again["id"], again["duplicate"]) == (posted["id"], True), "the same post twice is one message"
    assert mcp.call("mailbox_list")["relay_member"] is True

    [(_watcher, w)] = enrolled(WorkerRelay(worker), 1)
    [stored] = w.read({"ids": [posted["id"]]})
    assert stored["pubkey"] == persona["pubkey"] and event_is_signed(stored)
    assert ["epoch", "1"] in stored["tags"] and ["t", f"{campaign}:bus"] in stored["tags"]
    assert body not in stored["content"] and base64.b64decode(stored["content"])[0] == 2, "NIP-44 v2"

    reviewer = mcp.call("mailbox_join", {"token_or_url": f"https://{RELAY_HOST}/join/#{token}", "persona": "reviewer"})
    assert reviewer["persona"] == "reviewer" and reviewer["npub"] != persona["npub"]
    assert reviewer["relay_said"].endswith(f"(invited by persona default, {persona['npub']})")
    watched = mcp.call("mailbox_watch", {"channel": "bus", "persona": "reviewer"})
    assert [(m["id"], m["body"], m["author"]) for m in watched["messages"]] == [(posted["id"], body, persona["pubkey"])]
    assert watched["seat"] == "reviewer"
    settled = mcp.call("mailbox_watch", {"channel": "bus", "persona": "reviewer", "ack_id": posted["id"]})
    assert (settled["messages"], settled["acked"][0]["disposition"]) == ([], "handled")
    assert mcp.call("mailbox_watch", {"channel": "bus"})["messages"] == [], "a persona is not sent its own posts"
    assert mcp.call("mailbox_watch", {"channel": "bus", "history": True})["messages"][0]["body"] == body
    minted = mcp.call("mailbox_invite", {"target": campaign, "scope": "org", "recipient": "a colleague"})
    assert minted["join_url"] == f"https://{RELAY_HOST}/join/#{minted['token']}"
    assert json.loads(base64.urlsafe_b64decode(minted["token"][4:] + "=="))["member"] == "a colleague"
    assert "keeper" in mcp.refusal("mailbox_invite", {"target": "bus"}), "a channel invite is the keeper's"

    # The token is spent on its own persona: another token carrying the same code is not.
    reworded = invite_token(**{**json.loads(base64.urlsafe_b64decode(token[4:] + "==")), "member": "someone else"})
    status, _, refused = worker.http("GET", "/openapi.json", headers={"Authorization": f"Bearer {reworded}"})
    spent = "this token's relay invite is spent, expired or unknown, and its persona is not a member of this relay"
    assert (status, json.loads(refused)["error"]) == (401, spent)


@pytest.fixture
def keeper(worker, tmp_path):
    """nostr-mailbox's own CLI keeps a topic on the Worker: `setup`, `topic create` and
    `topic invite`, the token a person pastes into ChatGPT or Claude.ai."""
    if not os.environ.get("NOSTR_MAILBOX_SRC"):
        pytest.skip("set NOSTR_MAILBOX_SRC=<nostr-mailbox checkout>/skills/nostr-mailbox to run its CLI against the Worker")
    sys.path.insert(0, os.environ["NOSTR_MAILBOX_SRC"])
    from nostr_mailbox import bech32  # type: ignore[import-not-found]

    home = tmp_path / "keeper"
    campaign, topic = f"demo-{os.urandom(3).hex()}", f"agents-{os.urandom(3).hex()}"
    setup = nostr_mailbox_cli(home, "setup", "--relay", f"ws://127.0.0.1:{worker.port}", "--campaign", campaign)
    trust = Path(setup["trust_file"])
    trust.write_text(trust.read_text() + f'relay_auth_url = "wss://{RELAY_HOST}"\n')
    run_shim(worker, "members", "add", bech32.pubkey_hex(setup["npub"]))
    assert nostr_mailbox_cli(home, "topic", "create", topic)["created"] is True
    invite = nostr_mailbox_cli(home, "topic", "invite", topic, "--for", "chatgpt")
    assert (invite["topic"], invite["role"], invite["epochs_in_token"]) == (topic, "read-write", [1])

    def cli(*args: str) -> dict:
        return nostr_mailbox_cli(home, "--topic", topic, *args)

    return {"cli": cli, "topic": topic, "campaign": campaign, "token": invite["token"],
            "join_url": invite["join_url"], "pubkey": bech32.pubkey_hex(setup["npub"]), "npub": setup["npub"]}


def test_chatgpt_and_a_local_agent_talk_through_the_worker_mcp(worker, keeper):
    """The whole loop, with nothing faked on either end: nostr-mailbox's CLI mints a topic
    token; a remote MCP client posts with it over /mcp and over an OpenAPI Action; the CLI
    decrypts both and replies on the bus; the client reads the reply over /mcp, settles
    it, and is woken by the next one while it waits."""
    token, topic, cli = keeper["token"], keeper["topic"], keeper["cli"]
    chatgpt = Mcp(worker, token)
    chatgpt.initialize()
    listed = chatgpt.call("mailbox_list")
    persona = listed["persona"]
    assert (listed["campaign"], listed["bus"]["topic"], listed["relay_member"]) == (keeper["campaign"], topic, False)
    [channel] = listed["channels"]
    assert (channel["name"], channel["held_epochs"], channel["keeper_npub"], channel["standing"]) == (
        topic, [1], keeper["npub"], "outside")

    asked = chatgpt.call("mailbox_post", {"channel": "bus", "kind": "question", "subject": "ci",
                                          "body": "From ChatGPT: are the tests green on main?"})
    assert (asked["accepted"], asked["topic"], asked["channel"]) == (True, "bus", "bus")
    status, acted = action(worker, token, "mailbox_post", {"channel": topic, "body": "From a GPT Action: and the docs?"})
    assert status == 200 and acted["accepted"] is True
    listed = chatgpt.call("mailbox_list")
    assert (listed["relay_member"], listed["channels"][0]["standing"]) == (True, "member")

    seen = cli("watch", "bus", "--wait-seconds", "0")
    # One second can hold both posts, and the journal orders a tie by id: compare as a set.
    assert {(m["id"], m["author"], m["kind"], m["body"]) for m in seen["messages"]} == {
        (asked["id"], persona["pubkey"], "question", "From ChatGPT: are the tests green on main?"),
        (acted["id"], persona["pubkey"], "message", "From a GPT Action: and the docs?"),
    }
    assert "rejected" not in seen, seen["rejected"]
    reply = cli("post", "bus", "From the local agent: green, 206 passed", "--kind", "answer", "--reply-to", asked["id"])
    assert reply["accepted"] is True

    # Another connection, the token in its URL, as a client without custom headers uses it.
    claude = Mcp(worker, token, in_url=True)
    claude.initialize()
    watched = claude.call("mailbox_watch", {"channel": "bus"})
    assert [(m["id"], m["author"], m["kind"], m["reply_to"], m["body"]) for m in watched["messages"]] == [
        (reply["id"], keeper["pubkey"], "answer", asked["id"], "From the local agent: green, 206 passed")]
    settled = claude.call("mailbox_watch", {"channel": "bus", "ack_id": reply["id"], "result_ref": "PR 1"})
    assert (settled["messages"], settled["acked"][0]["disposition"], settled["acked"][0]["result_ref"]) == (
        [], "handled", "PR 1")

    # A watch that waits is woken by the next reply, not by its deadline.
    patience = 120
    woken: dict = {}
    waiting = threading.Thread(target=lambda: woken.update(
        chatgpt.call("mailbox_watch", {"channel": "bus", "wait_seconds": patience}), at=time.monotonic()))
    started = time.monotonic()
    waiting.start()
    later = cli("post", "bus", "From the local agent: docs too", "--kind", "answer")
    waiting.join(patience + 30)
    assert [m["id"] for m in woken["messages"]] == [later["id"]]
    assert woken["at"] - started < patience, "the wait ended when the reply arrived"

    history = cli("read", "bus")
    assert {m["id"] for m in history["messages"]} == {asked["id"], acted["id"], reply["id"], later["id"]}


def test_a_rotated_channel_key_reaches_the_mcp_persona_as_a_gift_wrap(worker, keeper):
    """The token carries epoch 1 alone. The keeper approves the persona, then rotates the
    topic: epoch 2 reaches the persona only as a NIP-59 gift wrap to its key, which the
    Worker opens on the next call, so the persona reads and writes under epoch 2."""
    token, cli, topic = keeper["token"], keeper["cli"], keeper["topic"]
    mcp = Mcp(worker, token)
    mcp.initialize()
    mcp.call("mailbox_post", {"channel": "bus", "body": "written under epoch 1"})
    persona = mcp.call("mailbox_list")["persona"]

    approved = cli("topic", "approve", topic, persona["npub"])
    assert approved["delivered"] == {persona["npub"]: [1]}, "the keeper wraps what the persona is owed"
    rotated = cli("topic", "invite", topic, "--history", "from-now", "--for", "a newcomer")
    assert (rotated["rotated_to"], rotated["delivered"]) == (2, {persona["npub"]: [2]})

    listed = mcp.call("mailbox_list")
    assert listed["channels"][0]["held_epochs"] == [1, 2] and "rejected" not in listed, listed
    asked = cli("post", "bus", "written under epoch 2", "--kind", "question")
    watched = mcp.call("mailbox_watch", {"channel": "bus"})
    assert [(m["id"], m["body"]) for m in watched["messages"]] == [(asked["id"], "written under epoch 2")]
    answered = mcp.call("mailbox_post", {"channel": "bus", "body": "read under epoch 2", "reply_to": asked["id"]})
    seen = cli("watch", "bus", "--wait-seconds", "0")
    assert {m["id"]: m["body"] for m in seen["messages"]}[answered["id"]] == "read under epoch 2"
    assert "rejected" not in seen, seen["rejected"]


def test_the_board_reads_and_writes_what_the_cli_does(worker, keeper):
    """mailbox_board against nostr-mailbox's CLI on one topic: handoffs, conditions, claims
    and decisions, checkpoints and the Route Board, each written on one side and read on
    the other, where only the keys the campaign names may write."""
    token, cli = keeper["token"], keeper["cli"]
    mcp = Mcp(worker, token)
    mcp.initialize()

    def board(action_name: str, **params) -> dict:
        return mcp.call("mailbox_board", {"action": action_name, "params": params})

    sent = board("handoff_send", original_goal="ship the MCP edge", open_condition="docs reviewed",
                 evidence="tests: 206 passed", next_action="review docs/cloudflare-workers.md")
    persona = mcp.call("mailbox_list")["persona"]
    [packet] = cli("handoff", "read", "--all-seats")["handoffs"]
    assert (packet["event_id"], packet["from"], packet["next_action"]) == (
        sent["event_id"], persona["npub"], "review docs/cloudflare-workers.md")

    opened = cli("condition", "open", "edge-mcp", "--goal", "remote agents on the bus", "--statement",
                 "ChatGPT reads what a local agent writes", "--next-action", "post and watch")
    [standing] = board("condition_list")["conditions"]
    assert (standing["event_id"], standing["rev"], standing["state"], standing["reviewer"]) == (
        opened["event_id"], 1, "open", keeper["npub"])
    digest = hashlib.sha256(b"the candidate").hexdigest()
    claimed = board("claim_put", condition="edge-mcp", condition_rev="1", effect="closes",
                    candidate_digest=digest, evidence_ref="tests/test_hydrate.py")
    [listed] = cli("claim", "list")["claims"]
    assert (listed["event_id"], listed["author"], listed["status"], listed["evidence_refs"]) == (
        claimed["event_id"], persona["npub"], "proposal", ["tests/test_hydrate.py"])
    cli("claim", "decide", claimed["event_id"], "--outcome", "accepted", "--reason", "witnessed end to end",
        "--next-action", "deploy")
    [moved] = board("condition_list")["conditions"]
    assert (moved["rev"], moved["state"], moved["evidence"]) == (2, "closed", ["tests/test_hydrate.py"])
    [decided] = board("claim_list")["claims"]
    assert (decided["status"], decided["decisions"][0]["outcome"]) == ("decided", "accepted")
    refused = mcp.refusal("mailbox_board", {"action": "claim_decide", "params": {
        "claim_id": claimed["event_id"], "outcome": "rejected", "reason": "no", "next_action": "x", "reopen_if": "y"}})
    assert "decided by a reviewer or operator key" in refused

    put = board("checkpoint_put", seq=1, sha256=digest, note="first")
    got = cli("checkpoint", "get", "--seat", "default", "--author", persona["npub"])
    assert (put["written"], got["checkpoint"]["seq"], got["checkpoint"]["note"]) == (True, 1, "first")
    assert board("checkpoint_put", seq=1, sha256=digest, note="first")["written"] is False, "an exact retry writes nothing"
    assert "behind the recorded" in mcp.refusal("mailbox_board", {"action": "checkpoint_put", "params": {
        "seq": 0, "sha256": digest}})

    cli("route", "put", "edge", "--state", "active", "--hypothesis", "remote MCP clients join at the edge",
        "--falsification-criterion", "a client cannot read a reply")
    assert [r["route"] for r in board("route_list")["routes"]] == ["edge"]
    assert "lead or operator key" in mcp.refusal("mailbox_board", {"action": "route_put", "params": {
        "route": "mine", "state": "active", "hypothesis": "h", "falsification_criterion": "f"}})


# ============================================================ OAuth 2.1 and magic URLs
# The two ways a hosted assistant connects with no token pasted into it. OAuth 2.1, as
# the MCP authorization spec has a client sign in: the 401's resource_metadata, RFC 9728
# and RFC 8414 discovery, RFC 7591 registration, the consent page in the user's browser,
# and the code traded with its PKCE verifier. And the magic URL /mcp/s/<token>, whose
# path is the credential, for a client set to "Authentication: None".
ORIGIN = f"https://{RELAY_HOST}"
RESOURCE = f"{ORIGIN}/mcp"
RESOURCE_METADATA = f"{ORIGIN}/.well-known/oauth-protected-resource"
CALLBACK = "https://assistant.example/api/mcp/auth_callback"
CODE_TTL_S = 600                      # RFC 6749 §4.1.2's recommended ceiling, as oauth.ts has it
ACCESS_TOKEN_TTL_S = 30 * 24 * 3600   # what the access token promises: expires_in
TOOLS = ["mailbox_list", "mailbox_invite", "mailbox_join", "mailbox_post", "mailbox_watch", "mailbox_board"]


def pkce() -> tuple[str, str]:
    """A PKCE code_verifier and its S256 code_challenge (RFC 7636 §4.1, §4.2)."""
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def csp(headers) -> dict[str, str]:
    return dict(part.strip().split(" ", 1) for part in headers["Content-Security-Policy"].split(";"))


def sha256_source(text: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode()).digest()).decode() + "'"


def register(harness: Harness, **metadata) -> tuple[int, dict]:
    status, _, body = harness.http("POST", "/oauth/register", headers={"Content-Type": "application/json"},
                                   body=json.dumps(metadata).encode())
    return status, json.loads(body)


def registered(harness: Harness, **metadata) -> dict:
    status, client = register(harness, **{"client_name": "Claude", "redirect_uris": [CALLBACK], **metadata})
    assert status == 201, client
    return client


def consent(harness: Harness, query: dict) -> tuple[int, object, str]:
    """GET the consent page the client sent its user to."""
    status, headers, body = harness.http("GET", "/oauth/authorize?" + urllib.parse.urlencode(query))
    return status, headers, body.decode()


def answer(harness: Harness, page: str, **given: str) -> tuple[int, object, str]:
    """Submit the page's form as a browser does: its hidden fields, and what the user gave."""
    parsed = _Collect()
    parsed.feed(page)
    [form] = [a for t, a in parsed.tags if t == "form"]
    hidden = {a["name"]: a["value"] for t, a in parsed.tags if t == "input" and a.get("type") == "hidden"}
    assert (form["method"], form["action"]) == ("post", "/oauth/authorize")
    status, headers, body = harness.http("POST", form["action"], headers=OAUTH_FORM,
                                         body=urllib.parse.urlencode({**hidden, **given}).encode())
    return status, headers, body.decode()


def redirected(headers) -> tuple[str, dict[str, str]]:
    """Where a 303 sends the browser: the URI without its query, and the query."""
    location = urllib.parse.urlsplit(headers["Location"])
    return f"{location.scheme}://{location.netloc}{location.path}", dict(urllib.parse.parse_qsl(location.query))


def authorization(client: dict, challenge: str, **extra: str) -> dict:
    return {"response_type": "code", "client_id": client["client_id"], "redirect_uri": CALLBACK,
            "code_challenge": challenge, "code_challenge_method": "S256", "state": os.urandom(8).hex(),
            "resource": RESOURCE, **extra}


def code_for(harness: Harness, token: str, client: dict, challenge: str, **extra: str) -> str:
    """The code a user's Authorize sends back, for `token`."""
    _, _, page = consent(harness, authorization(client, challenge, **extra))
    status, headers, body = answer(harness, page, token=token, decision="authorize")
    assert status == 303, body
    return redirected(headers)[1]["code"]


def trade(harness: Harness, **fields: str) -> tuple[int, object, dict]:
    status, headers, body = harness.http("POST", "/oauth/token", headers=OAUTH_FORM,
                                         body=urllib.parse.urlencode(fields).encode())
    return status, headers, json.loads(body)


def sign_in(harness: Harness, token: str) -> str:
    """An MCP client's whole sign-in, from the 401 to the access token, as Claude.ai and
    ChatGPT make it; each step is held to what the specs say it answers."""
    status, headers, _ = harness.http("POST", "/mcp", headers={"Content-Type": "application/json"},
                                      body=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}).encode())
    assert (status, headers["WWW-Authenticate"]) == (401, f'Bearer resource_metadata="{RESOURCE_METADATA}"')
    resource = json.loads(harness.http("GET", urllib.parse.urlsplit(RESOURCE_METADATA).path)[2])
    assert (resource["resource"], resource["authorization_servers"]) == (RESOURCE, [ORIGIN])
    server = json.loads(harness.http("GET", "/.well-known/oauth-authorization-server")[2])
    assert server["issuer"] == ORIGIN and "S256" in server["code_challenge_methods_supported"]
    client = registered(harness, grant_types=["authorization_code", "refresh_token"], response_types=["code"],
                        token_endpoint_auth_method="none", scope="claudeai")
    verifier, challenge = pkce()
    asked = authorization(client, challenge)
    status, _, page = consent(harness, asked)
    assert status == 200, page
    status, headers, _ = answer(harness, page, token=token, decision="authorize")
    to, back = redirected(headers)
    assert (status, to, back["state"], back["iss"]) == (303, CALLBACK, asked["state"], ORIGIN)
    status, headers, granted = trade(harness, grant_type="authorization_code", code=back["code"], redirect_uri=CALLBACK,
                                     client_id=client["client_id"], code_verifier=verifier, resource=RESOURCE)
    assert status == 200 and headers["Cache-Control"] == "no-store", granted
    assert (granted["token_type"], granted["expires_in"], set(granted)) == (
        "Bearer", ACCESS_TOKEN_TTL_S, {"access_token", "token_type", "expires_in"})
    return granted["access_token"]


def test_oauth_discovery_points_an_mcp_client_at_this_host(worker):
    """A 401 from /mcp names the RFC 9728 metadata (with error="invalid_token" for a token
    that is no good); the metadata names this host as the authorization server, whose RFC
    8414 document is served where clients look for it. The OpenAPI twin's 401 names no
    metadata, which describes /mcp alone (RFC 9728 §3.3). A magic URL whose token is no
    good is 403 with no challenge: its path is the credential, with nothing to sign in to."""
    for method, path in (("POST", "/mcp"), ("DELETE", "/mcp"), ("GET", "/openapi.json"), ("POST", "/tools/mailbox_list")):
        status, headers, body = worker.http(method, path, body=b"{}" if method == "POST" else None)
        challenge = f'Bearer resource_metadata="{RESOURCE_METADATA}"' if path == "/mcp" else 'Bearer realm="nostr-mailbox"'
        assert (status, headers["WWW-Authenticate"]) == (401, challenge), path
        assert f"{ORIGIN}/mcp/s/nm1_" in json.loads(body)["error"], "the refusal names both ways in"
    for path, challenge in (("/mcp", f'resource_metadata="{RESOURCE_METADATA}"'), ("/tools/mailbox_list", 'realm="nostr-mailbox"')):
        status, headers, _ = worker.http("POST", path, body=b"{}", headers={"Authorization": "Bearer nm1_bm90IGpzb24"})
        assert (status, headers["WWW-Authenticate"]) == (401, f'Bearer {challenge}, error="invalid_token"'), path
    for method, path in (("POST", MAGIC), ("GET", f"{MAGIC}/openapi.json"), ("POST", f"{MAGIC}/tools/mailbox_list")):
        status, headers, body = worker.http(method, path, body=b"{}" if method == "POST" else None)
        assert (status, headers.get("WWW-Authenticate")) == (403, None), path
        assert json.loads(body)["error"] == "the nm1_ token is not base64url JSON"

    resource = {"resource": RESOURCE, "authorization_servers": [ORIGIN], "bearer_methods_supported": ["header"],
                "resource_name": "Private campaign relay"}
    server = {
        "issuer": ORIGIN, "authorization_endpoint": f"{ORIGIN}/oauth/authorize", "token_endpoint": f"{ORIGIN}/oauth/token",
        "registration_endpoint": f"{ORIGIN}/oauth/register", "response_types_supported": ["code"],
        "response_modes_supported": ["query"], "grant_types_supported": ["authorization_code"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "code_challenge_methods_supported": ["S256", "plain"], "authorization_response_iss_parameter_supported": True,
    }
    for paths, document in ((("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"), resource),
                            (("/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"), server)):
        for path in paths:
            status, headers, body = worker.http("GET", path)
            assert (status, headers["Content-Type"], json.loads(body)) == (200, "application/json", document), path


def test_an_mcp_client_signs_in_with_oauth_and_acts_as_the_tokens_own_persona(worker):
    """The sign-in end to end (sign_in holds each step), then MCP with the access token: the
    same persona as the token itself, the same bus, and a session either may use. The code
    and the access token seal the token; neither shows it."""
    campaign = f"oauth-{os.urandom(3).hex()}"
    token = org_token(worker, campaign)
    access = sign_in(worker, token)
    assert access.startswith("nmot_") and token.encode() not in base64.urlsafe_b64decode(access[5:] + "==")

    assistant = Mcp(worker, access)
    init = assistant.initialize()
    assert init["protocolVersion"] == "2025-06-18"
    assert [t["name"] for t in assistant.rpc("tools/list")["result"]["tools"]] == TOOLS
    listed = assistant.call("mailbox_list")
    assert (listed["campaign"], listed["relay_member"]) == (campaign, False)
    posted = assistant.call("mailbox_post", {"channel": "bus", "body": "signed in with OAuth, no token pasted"})
    assert posted["accepted"] is True

    direct = Mcp(worker, token)
    assert direct.call("mailbox_list")["persona"] == listed["persona"], "the access token acts as the token's persona"
    [read] = direct.call("mailbox_watch", {"channel": "bus", "history": True})["messages"]
    assert (read["id"], read["body"], read["author"]) == (posted["id"], "signed in with OAuth, no token pasted",
                                                           listed["persona"]["pubkey"])
    status, _, body = direct.post({"jsonrpc": "2.0", "id": 7, "method": "ping"}, session=assistant.session)
    assert (status, json.loads(body)["result"]) == (200, {}), "a session is the token's, however it was presented"
    status, acted = action(worker, access, "mailbox_list", {})
    assert (status, acted["persona"]) == (200, listed["persona"]), "the OpenAPI twin takes the access token too"

    # Revoking the persona shuts the access token out, as it shuts out the token.
    status, _, _ = worker.http("DELETE", f"/_admin/members/{listed['persona']['pubkey']}",
                               headers={"Authorization": f"Bearer {ADMIN_TOKEN}"})
    assert status == 200
    status, headers, body = Mcp(worker, access).post({"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert (status, headers["WWW-Authenticate"]) == (
        401, f'Bearer resource_metadata="{RESOURCE_METADATA}", error="invalid_token"')
    assert "spent, expired or unknown" in json.loads(body)["error"]


def test_registration_takes_only_redirect_uris_a_code_can_safely_reach(worker):
    """RFC 7591 with the redirect rules of RFC 6749 §3.1.2 and RFC 8252: https, loopback
    http and a native app's own scheme, never a fragment, a script or plain http elsewhere.
    A client registers what this server issues, and gets a secret when it asks to use one."""
    good = ["https://assistant.example/cb?x=1", "http://127.0.0.1:33418/callback", "http://localhost/cb",
            "http://[::1]:9/cb", "cursor://anysphere.cursor-retrieval/oauth/callback"]
    status, client = register(worker, client_name="Cursor", redirect_uris=good)
    assert status == 201 and client["client_id"].startswith("nmoc_")
    assert (client["redirect_uris"], client["token_endpoint_auth_method"], client["grant_types"],
            client["response_types"], "client_secret" in client) == (good, "none", ["authorization_code"], ["code"], False)
    assert client["client_id_issued_at"] > time.time() - 60

    status, confidential = register(worker, redirect_uris=[CALLBACK], token_endpoint_auth_method="client_secret_post")
    assert status == 201 and confidential["client_secret"].startswith("nmos_")
    assert (confidential["client_secret_expires_at"], "client_name" in confidential) == (0, False)

    refusals = [
        ({"client_name": "x"}, "invalid_redirect_uri", "redirect_uris is a non-empty array"),
        ({"redirect_uris": []}, "invalid_redirect_uri", "redirect_uris is a non-empty array"),
        ({"redirect_uris": ["/relative"]}, "invalid_redirect_uri", "is not an absolute URL"),
        ({"redirect_uris": ["http://assistant.example/cb"]}, "invalid_redirect_uri", "use https"),
        ({"redirect_uris": ["https://assistant.example/cb#frag"]}, "invalid_redirect_uri", "carries a fragment"),
        ({"redirect_uris": ["https://user:pw@assistant.example/cb"]}, "invalid_redirect_uri", "carries credentials"),
        ({"redirect_uris": ["javascript:alert(1)"]}, "invalid_redirect_uri", "cannot receive a code"),
        ({"redirect_uris": ["data:text/html,hi"]}, "invalid_redirect_uri", "cannot receive a code"),
        ({"redirect_uris": [CALLBACK], "grant_types": ["client_credentials"]}, "invalid_client_metadata",
         "must include authorization_code"),
        ({"redirect_uris": [CALLBACK], "response_types": ["token"]}, "invalid_client_metadata", "must include code"),
        ({"redirect_uris": [CALLBACK], "token_endpoint_auth_method": "private_key_jwt"}, "invalid_client_metadata",
         "must be one of none, client_secret_post, client_secret_basic"),
        ({"redirect_uris": [CALLBACK], "client_name": 7}, "invalid_client_metadata", "client_name must be a string"),
    ]
    for metadata, error, says in refusals:
        status, refused = register(worker, **metadata)
        assert (status, refused["error"]) == (400, error) and says in refused["error_description"], (metadata, refused)
    status, _, body = worker.http("POST", "/oauth/register", body=b"{nope", headers={"Content-Type": "application/json"})
    assert (status, json.loads(body)["error"]) == (400, "invalid_client_metadata")


def test_the_consent_page_says_who_asks_and_where_the_code_goes(worker, tmp_path):
    """Connect <client> to <relay>, with the destination of the code shown and admitted by
    the CSP's form-action, the client's own words escaped, and its script run by hash only.
    A request this host cannot trust to its redirect URI is shown here, never redirected;
    anything else wrong goes back to the client as RFC 6749 §4.1.2.1 has it."""
    client = registered(worker, client_name='Claude <script>alert("x")</script>')
    _, challenge = pkce()
    asked = authorization(client, challenge, scope="claudeai")
    status, headers, page = consent(worker, asked)
    assert status == 200 and headers["Content-Type"] == "text/html; charset=utf-8"
    assert page.startswith("<!doctype html>\n<html lang=\"en\">")
    assert "<h1 id=\"title\">Connect Claude &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; to Private campaign relay</h1>" in page
    assert "Authorizing sends a code to <strong class=\"mono\">https://assistant.example</strong>" in page
    assert "a name any client may give itself" in page and page.count("<script>") == 1
    policy = csp(headers)
    script = re.search(r"<script>(.*?)</script>", page, re.DOTALL).group(1)
    style = re.search(r"<style>(.*?)</style>", page, re.DOTALL).group(1)
    assert (policy["default-src"], policy["frame-ancestors"], policy["base-uri"]) == ("'none'", "'none'", "'none'")
    assert (policy["script-src"], policy["style-src"]) == (sha256_source(script), sha256_source(style))
    assert policy["form-action"] == "'self' https://assistant.example", "a browser holds the 303 to form-action too"
    assert (headers["X-Frame-Options"], headers["Referrer-Policy"], headers["Cache-Control"]) == ("DENY", "no-referrer", "no-store")
    parsed = _Collect()
    parsed.feed(page)
    hidden = {a["name"]: a["value"] for t, a in parsed.tags if t == "input" and a.get("type") == "hidden"}
    assert hidden == asked, "the form carries the request on exactly as the client sent it"
    (tmp_path / "consent.js").write_text(script)
    checked = subprocess.run(["node", "--check", str(tmp_path / "consent.js")], capture_output=True, text=True, check=False)
    assert checked.returncode == 0, checked.stderr
    ids = set(re.findall(r'\bid="([^"]+)"', page))
    assert set(re.findall(r"\$\('([^']+)'\)", script)) <= ids, "every element the script reaches is on the page"
    # The console's Pair card and this page keep the token under one key.
    console = re.search(r"<script>(.*?)</script>", worker.http("GET", "/")[2].decode(), re.DOTALL).group(1)
    key = re.compile(r"var TOKEN_KEY = '([^']+)';")
    assert key.search(script).group(1) == key.search(console).group(1) == "nostr-relay-deploy/mcp-token"

    loopback = registered(worker, redirect_uris=["http://127.0.0.1:33418/callback"])
    status, headers, _ = consent(worker, {**authorization(loopback, challenge), "redirect_uri": "http://127.0.0.1:50211/callback"})
    assert (status, csp(headers)["form-action"]) == (200, "'self' http://127.0.0.1:*"), "RFC 8252 §7.3: any loopback port"
    native = registered(worker, redirect_uris=["cursor://anysphere.cursor-retrieval/oauth/callback"])
    status, headers, page = consent(worker, {**authorization(native, challenge), "redirect_uri": native["redirect_uris"][0]})
    assert (status, csp(headers)["form-action"]) == (200, "'self' cursor:") and "an app on this device" in page

    forged = client["client_id"][:-4] + ("AAAA" if not client["client_id"].endswith("AAAA") else "BBBB")
    # A request this host cannot accept is explained here and sent nowhere, however good its
    # client and redirect URI: anyone may register those, and a request that redirected at
    # once would make this host an open redirector (RFC 9700 §4.11.2).
    shown_here = [
        ({**asked, "client_id": forged}, "never registered that client"),
        ({k: v for k, v in asked.items() if k != "client_id"}, "names no client"),
        ({**asked, "redirect_uri": "https://attacker.example/cb"}, "the redirect_uri is not one the client registered"),
        ({**asked, "redirect_uri": "https://assistant.example/api/mcp/auth_callback/"}, "is not one the client registered"),
        ({k: v for k, v in asked.items() if k != "code_challenge"}, "invalid_request: code_challenge is required"),
        ({**asked, "code_challenge": "short"}, "invalid_request: a code_challenge is 43 to 128 characters"),
        ({**asked, "code_challenge_method": "S512"}, "must be one of S256, plain"),
        ({**asked, "response_type": "token"}, "unsupported_response_type: this server issues authorization codes only"),
        ({k: v for k, v in asked.items() if k != "response_type"}, "invalid_request: response_type is required"),
        ({**asked, "resource": "https://elsewhere.example/mcp"}, f"invalid_target: this server issues tokens for {RESOURCE}"),
    ]
    for query, says in shown_here:
        status, headers, page = consent(worker, query)
        assert (status, "Location" in headers, csp(headers)["form-action"]) == (400, False, "'none'"), query
        assert says in page and "<form" not in page and "<script>" not in page, (query, page)
        assert "attacker.example" not in page, "a fault never repeats what the request claims"
    # RFC 8707 §2: a client may name several resources, each of them this one.
    status, _, _ = consent(worker, asked)
    several = f"/oauth/authorize?{urllib.parse.urlencode(asked)}&{urllib.parse.urlencode({'resource': ORIGIN})}"
    status, _, page = worker.http("GET", several)
    assert status == 200 and page.decode().count('name="resource"') == 2
    status, _, _ = worker.http("GET", several + "&" + urllib.parse.urlencode({"resource": "https://elsewhere.example/"}))
    assert status == 400

    # The user's answer: Deny goes back as access_denied; a token this relay does not honour
    # stays on the page.
    _, _, page = consent(worker, asked)
    status, headers, _ = answer(worker, page, decision="deny")
    assert (status, redirected(headers)[1]["error"]) == (303, "access_denied")
    elsewhere = invite_token(schema="cf.transport/1", relay="wss://relay.other.test", campaign="c",
                             operator_pubkeys=[NIP19_NPUB], code="c0de")
    status, headers, page = answer(worker, page, token=elsewhere, decision="authorize")
    assert (status, "Location" in headers) == (400, False)
    assert "does not honour that token: this token is for wss://relay.other.test" in page
    status, _, page = answer(worker, page, token="", decision="authorize")
    assert status == 400 and "Paste the nm1_ token" in page


def test_a_code_is_good_once_for_its_client_its_verifier_and_ten_minutes(worker, clock):
    """RFC 6749 §4.1.3 and RFC 7636 §4.6: the code goes to the client it was issued to, with
    the redirect URI it was sent to and the verifier of its challenge, within its lifetime,
    and once. S256 and plain both hold; a challenge without a method is plain."""
    token = org_token(worker, f"code-{os.urandom(3).hex()}")
    client, other = registered(worker), registered(worker)
    verifier, challenge = pkce()
    code = code_for(worker, token, client, challenge)
    assert code.startswith("nmoa_") and token.encode() not in base64.urlsafe_b64decode(code[5:] + "==")
    trade_with = {"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK,
                  "client_id": client["client_id"], "code_verifier": verifier}
    refusals = [
        ({"grant_type": "refresh_token"}, 400, "unsupported_grant_type"),
        ({"grant_type": None}, 400, "invalid_request"),
        ({"client_id": None}, 401, "invalid_client"),
        ({"client_id": other["client_id"]}, 400, "invalid_grant"),
        ({"code": code[:-3] + "xyz"}, 400, "invalid_grant"),
        ({"redirect_uri": CALLBACK + "/x"}, 400, "invalid_grant"),
        ({"redirect_uri": None}, 400, "invalid_grant"),
        ({"code_verifier": None}, 400, "invalid_request"),
        ({"code_verifier": pkce()[0]}, 400, "invalid_grant"),
        ({"resource": "https://elsewhere.example/mcp"}, 400, "invalid_target"),
    ]
    for change, status, error in refusals:
        fields = {k: v for k, v in {**trade_with, **change}.items() if v is not None}
        got, _, refused = trade(worker, **fields)
        assert (got, refused["error"]) == (status, error), (change, refused)
    status, _, granted = trade(worker, **trade_with)
    assert status == 200, granted
    status, _, again = trade(worker, **trade_with)
    assert (status, again["error"], again["error_description"]) == (
        400, "invalid_grant", "the code was already used: a code is good once")

    # A JSON body, as some clients send it, and PKCE plain, named or implied.
    for method in ("plain", None):
        plain = pkce()[0]
        extra = {"code_challenge_method": method} if method else {}
        query = {**authorization(client, plain), **extra}
        if method is None:
            del query["code_challenge_method"]
        _, _, page = consent(worker, query)
        _, headers, _ = answer(worker, page, token=token, decision="authorize")
        status, _, body = worker.http("POST", "/oauth/token", headers={"Content-Type": "application/json"}, body=json.dumps({
            **trade_with, "code": redirected(headers)[1]["code"], "code_verifier": plain}).encode())
        assert (status, json.loads(body)["token_type"]) == (200, "Bearer"), body

    # A redirect_uri left out of the request may be left out of the trade too.
    verifier, challenge = pkce()
    query = authorization(client, challenge)
    del query["redirect_uri"]
    _, _, page = consent(worker, query)
    _, headers, _ = answer(worker, page, token=token, decision="authorize")
    status, _, _ = trade(worker, grant_type="authorization_code", code=redirected(headers)[1]["code"],
                         client_id=client["client_id"], code_verifier=verifier)
    assert status == 200

    verifier, challenge = pkce()
    late = code_for(worker, token, client, challenge)
    clock(CODE_TTL_S + 1)
    status, _, refused = trade(worker, **{**trade_with, "code": late, "code_verifier": verifier})
    assert (status, refused["error"], refused["error_description"]) == (
        400, "invalid_grant", f"the code expired: a code is good for {CODE_TTL_S} seconds")


def test_an_access_token_expires_and_opens_only_here(worker, clock):
    """The access token is good for expires_in and no longer; one tampered with, a code
    presented as one, and a client secret presented as one are each refused 401, with the
    challenge that sends the client to sign in again."""
    token = org_token(worker, f"expiry-{os.urandom(3).hex()}")
    access = sign_in(worker, token)
    client = registered(worker)
    code = code_for(worker, token, client, pkce()[1])
    flipped = access[:-2] + ("AA" if not access.endswith("AA") else "BB")
    for presented, says in ((flipped, "not one this relay issued"), (code, "give an nm1_ token"),
                            (client["client_id"], "give an nm1_ token")):
        status, headers, body = Mcp(worker, presented).post({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        assert (status, headers["WWW-Authenticate"]) == (
            401, f'Bearer resource_metadata="{RESOURCE_METADATA}", error="invalid_token"'), presented
        assert says in json.loads(body)["error"]
    # Its first tool call redeems the token, so the persona outlives the token's own invite.
    assert Mcp(worker, access).call("mailbox_post", {"channel": "bus", "body": "joined"})["accepted"] is True
    clock(ACCESS_TOKEN_TTL_S - 60)
    assert Mcp(worker, access).rpc("ping")["result"] == {}, "good until its expires_in"
    clock(ACCESS_TOKEN_TTL_S + 1)
    status, headers, body = Mcp(worker, access).post({"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert (status, headers["WWW-Authenticate"]) == (401, f'Bearer resource_metadata="{RESOURCE_METADATA}", error="invalid_token"')
    assert "expired" in json.loads(body)["error"] and "authorize again" in json.loads(body)["error"]


def test_a_confidential_client_authenticates_with_its_secret(worker):
    """A client that registers client_secret_post or client_secret_basic must present its
    secret, in the body or as HTTP Basic (RFC 6749 §2.3.1), one way at a time."""
    token = org_token(worker, f"secret-{os.urandom(3).hex()}")
    for method in ("client_secret_post", "client_secret_basic"):
        client = registered(worker, token_endpoint_auth_method=method)
        verifier, challenge = pkce()
        code = code_for(worker, token, client, challenge)
        fields = {"grant_type": "authorization_code", "code": code, "redirect_uri": CALLBACK, "code_verifier": verifier}
        status, _, refused = trade(worker, **fields, client_id=client["client_id"])
        assert (status, refused["error"]) == (401, "invalid_client"), "no secret"
        status, _, refused = trade(worker, **fields, client_id=client["client_id"], client_secret="nmos_wrong")
        assert (status, refused["error"]) == (401, "invalid_client"), "a wrong secret"
        if method == "client_secret_post":
            status, _, granted = trade(worker, **fields, client_id=client["client_id"], client_secret=client["client_secret"])
        else:
            pair = ":".join(urllib.parse.quote(v, safe="") for v in (client["client_id"], client["client_secret"]))
            basic = {"Authorization": "Basic " + base64.b64encode(pair.encode()).decode(), **OAUTH_FORM}
            status, _, body = worker.http("POST", "/oauth/token", headers=basic, body=urllib.parse.urlencode({
                **fields, "client_secret": client["client_secret"]}).encode())
            assert (status, json.loads(body)["error"]) == (400, "invalid_request"), "Basic or client_secret, not both"
            status, headers, body = worker.http("POST", "/oauth/token", headers={**basic, "Authorization": "Basic Zm9v"},
                                                body=urllib.parse.urlencode(fields).encode())
            assert (status, headers["WWW-Authenticate"]) == (401, 'Basic realm="oauth"')
            status, _, body = worker.http("POST", "/oauth/token", headers=basic, body=urllib.parse.urlencode(fields).encode())
            granted = json.loads(body)
        assert (status, granted["token_type"]) == (200, "Bearer"), (method, granted)
        assert Mcp(worker, granted["access_token"]).rpc("ping")["result"] == {}


def test_a_magic_url_is_the_whole_credential(worker):
    """/mcp/s/<token> needs no header: MCP Streamable HTTP, its OpenAPI document (whose
    server is the magic URL and which names no security scheme, for "Authentication: None")
    and its tool calls, as the token's own persona. A path and a header that differ are
    refused, as a header and ?token= are."""
    campaign = f"magic-{os.urandom(3).hex()}"
    token = org_token(worker, campaign)
    magic = Mcp(worker, token, magic=True)
    assert magic.initialize()["protocolVersion"] == "2025-06-18"
    assert [t["name"] for t in magic.rpc("tools/list")["result"]["tools"]] == TOOLS
    posted = magic.call("mailbox_post", {"channel": "bus", "body": "pasted once, as a URL"})
    persona = magic.call("mailbox_list")["persona"]
    assert Mcp(worker, token).call("mailbox_list")["persona"] == persona

    status, _, body = worker.http("GET", f"/mcp/s/{token}/openapi.json")
    doc = json.loads(body)
    assert (status, doc["servers"], doc["security"]) == (200, [{"url": f"{ORIGIN}/mcp/s/{token}"}], [])
    assert "securitySchemes" not in doc["components"] and "treat it as a password" in doc["info"]["description"]
    assert [p["post"]["operationId"] for p in doc["paths"].values()] == TOOLS
    assert list(doc["paths"]) == [f"/tools/{t}" for t in TOOLS], "relative to the magic server URL"
    status, acted = action(worker, token, "mailbox_watch", {"channel": "bus", "history": True}, magic=True)
    assert (status, [m["id"] for m in acted["messages"]]) == (200, [posted["id"]])
    assert action(worker, token, "mailbox_nope", {}, magic=True)[0] == 404
    assert action(worker, token, "mailbox_post", {"channel": "bus"}, magic=True) == (400, {"error": "mailbox_post needs [\"body\"]"})

    status, headers, _ = worker.http("GET", f"/mcp/s/{token}")
    assert (status, headers["Allow"]) == (405, "POST, DELETE")
    other = org_token(worker, f"magic-{os.urandom(3).hex()}")
    status, _, body = worker.http("POST", f"/mcp/s/{token}", body=b"{}", headers={"Authorization": f"Bearer {other}"})
    assert (status, json.loads(body)) == (400, {"error": "the URL's path and Authorization header carry two different tokens"})
    status, _, body = worker.http("POST", f"/mcp/s/{token}?token={other}", body=b"{}")
    assert (status, json.loads(body)) == (400, {"error": "the URL's path and ?token= carry two different tokens"})
    same = Mcp(worker, token)
    status, _, body = worker.http("POST", f"/mcp/s/{token}", headers={"Authorization": f"Bearer {token}"},
                                  body=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}).encode())
    assert (status, json.loads(body)["result"]) == (200, {}), "the same token twice is one token"
    status, _, body = same.post({"jsonrpc": "2.0", "id": 2, "method": "ping"}, session=magic.session)
    assert status == 200, "a session the magic URL opened is the token's"
    status, _, _ = worker.http("DELETE", f"/mcp/s/{token}", headers={"Mcp-Session-Id": magic.session})
    assert status == 204
    status, _, _ = magic.post({"jsonrpc": "2.0", "id": 9, "method": "ping"})
    assert status == 404, "an ended session answers 404"

    # A spent token is refused in the path as anywhere else, with nothing to sign in to.
    reworded = invite_token(**{**json.loads(base64.urlsafe_b64decode(token[4:] + "==")), "member": "someone else"})
    status, headers, body = worker.http("GET", f"/mcp/s/{reworded}/openapi.json")
    assert (status, headers.get("WWW-Authenticate")) == (403, None)
    assert "spent, expired or unknown" in json.loads(body)["error"]

    # A tool is one of the six by its own name, never a name every object inherits.
    for tool in ("constructor", "hasownproperty"):
        assert action(worker, token, tool, {}, magic=True)[0] == 404, tool
        assert action(worker, token, tool, {})[0] == 404, tool
    fresh = Mcp(worker, token, magic=True)
    for name in ("constructor", "toString", "__proto__"):
        assert fresh.rpc("tools/call", {"name": name, "arguments": {}})["error"]["code"] == -32602, name
    refused = fresh.rpc("tools/call", {"name": "mailbox_list", "arguments": {"constructor": "x"}})["error"]
    assert (refused["code"], refused["message"]) == (-32602, 'mailbox_list takes ["persona"]; unknown: ["constructor"]')


def test_the_console_pairs_a_coding_agent_with_urls_the_worker_serves(worker, tmp_path):
    """The console's Pair card turns a token into the OAuth URL and the two magic URLs,
    with the block it runs itself; each URL is one the Worker answers for that token. The
    card asks the relay about a token in a header only, never in a URL a log would keep."""
    page = worker.http("GET", "/")[2].decode()
    script = re.search(r"<script>(.*?)</script>", page, re.DOTALL).group(1)
    for needle in ('id="pair-card"', 'id="pair-oauth"', 'id="pair-mcp"', 'id="pair-openapi"', 'id="pair-remember"'):
        assert needle in page, needle
    block = re.search(r"^  // BEGIN connection URLs\n.*?^  // END connection URLs\n", script, re.DOTALL | re.MULTILINE)
    program = tmp_path / "urls.cjs"
    program.write_text(block.group(0) + "\nconsole.log(JSON.stringify(connectionUrls(process.argv[2], process.argv[3])));\n")
    token = org_token(worker, f"pair-{os.urandom(3).hex()}")
    done = subprocess.run(["node", str(program), ORIGIN, token], capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    urls = json.loads(done.stdout)
    assert urls == {"oauth": RESOURCE, "mcp": f"{ORIGIN}/mcp/s/{token}", "openapi": f"{ORIGIN}/mcp/s/{token}/openapi.json",
                    "join": f"{ORIGIN}/join/#{token}"}
    assert 'id="pair-join"' in page and 'id="pair-clients"' in page
    joined = urllib.parse.urlsplit(urls["join"])
    assert (worker.http("GET", joined.path)[::2], joined.fragment) == ((200, page.encode()), token), "the console opens it"
    path = {name: urllib.parse.urlsplit(url).path for name, url in urls.items() if name != "join"}
    status, headers, _ = worker.http("POST", path["oauth"], body=b"{}")
    assert (status, headers["WWW-Authenticate"]) == (401, f'Bearer resource_metadata="{RESOURCE_METADATA}"')
    assert Mcp(worker, path["mcp"].rsplit("/", 1)[1], magic=True).rpc("ping")["result"] == {}
    status, _, body = worker.http("GET", path["openapi"])
    assert (status, json.loads(body)["servers"]) == (200, [{"url": urls["mcp"]}])
    assert "fetch('/openapi.json', { headers: { Authorization: 'Bearer ' + token } })" in script
    assert "?token=" not in script and "/mcp/s/' + token + '/openapi.json'" in script
    ids = set(re.findall(r'\bid="([^"]+)"', page))
    assert set(re.findall(r"\$\('([^']+)'\)", script)) <= ids, "every element the script reaches is on the page"


# A page's whole script, run under Node against a stand-in DOM: elements by id that record
# text, values and `hidden`, a location and history, localStorage, and a fetch that answers
# from the scenario and records every request. It is a test double, said openly: no browser
# lays the page out or enforces its CSP here. What it shows is what the script itself
# sends, and when, from the page's own markup (which ids start hidden).
PAGE_RUNNER = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const [scriptPath, scenarioPath] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const elements = new Map(), requests = [], snapshots = {};
function element(id) {
  if (!elements.has(id)) {
    const node = { id: id, textContent: '', value: '', className: '', checked: false, dataset: {}, type: 'button',
      hidden: scenario.hidden.includes(id), listeners: {}, parentElement: { className: '' },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      setAttribute() {}, appendChild() {}, prepend() {}, reset() {} };
    elements.set(id, node);
  }
  return elements.get(id);
}
let fresh = 0;
const sandbox = {
  document: { getElementById: element, querySelectorAll: () => [], createElement: () => element('#new' + (++fresh)),
              createTextNode: () => ({}), documentElement: { dataset: {} }, title: '' },
  location: { hash: scenario.hash, host: scenario.host, origin: 'https://' + scenario.host, pathname: scenario.path, search: '', reload() { requests.push({ reload: true }); } },
  history: { replaceState(_state, _title, url) { requests.push({ replaceState: url }); } },
  localStorage: { items: new Map(), getItem(k) { return this.items.get(k) ?? null; },
    setItem(k, v) { this.items.set(k, v); requests.push({ stored: k, value: v }); },
    removeItem(k) { this.items.delete(k); }, get length() { return this.items.size; },
    key(i) { return Array.from(this.items.keys())[i]; } },
  matchMedia: () => ({ matches: false }),
  addEventListener() {}, clearTimeout, navigator: {}, console: console, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams,
  atob, btoa, setTimeout, Promise, JSON, Uint8Array, Array, Object, Map, Error, String, Math, Date,
  fetch: async (url, init) => {
    init = init || {};
    requests.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body || null });
    const queue = scenario.replies[String(url)] || [];
    const reply = queue.length ? queue.shift() : { status: 200, body: JSON.stringify({ name: 'test relay', limitation: {} }) };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status,
             json: async () => JSON.parse(reply.body), text: async () => reply.body };
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
(async () => {
  if (scenario.port) {
    sandbox.WebSocket = class extends WebSocket {
      constructor(url) { super('ws://127.0.0.1:' + scenario.port); requests.push({ dial: url }); }
      send(message) { requests.push({ frame: JSON.parse(message) }); super.send(message); }
      close() { requests.push({ socketClosed: true }); super.close(); }
    };
    sandbox.fetch = async (url, init) => {
      requests.push({ url, headers: init.headers });
      return fetch('http://127.0.0.1:' + scenario.port + url, init);
    };
  }
  if (scenario.extension) {
    const nostr = await import(scenario.nostr);
    const key = nostr.secretKey(scenario.extension);
    sandbox.nostr = { getPublicKey: () => key.pubkey,
      signEvent: (e) => nostr.signEvent(key, e.kind, e.tags, e.content, e.created_at) };
  }
  for (const id of scenario.hidden) element(id);
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox);
  await settle();
  for (const [verb, id, value] of scenario.steps) {
    if (verb === 'set') element(id).value = value;
    if (verb === 'submit' || verb === 'click' || verb === 'input') {
      for (const fn of element(id).listeners[verb] || []) await fn({ preventDefault() {} });
    }
    if (verb === 'mark') requests.push({ mark: id });
    await settle();
  }
  const seen = {};
  for (const [id, node] of elements) if (!id.startsWith('#new')) seen[id] = { text: node.textContent, value: node.value, hidden: node.hidden, className: node.className };
  process.stdout.write(JSON.stringify({ requests: requests, elements: seen }) + "\n", () => process.exit(0));
})().catch((err) => { console.error(err); process.exit(1); });
"""


def run_page(tmp_path: Path, page: str, *, hash: str = "", steps: list | None = None,
             replies: dict | None = None, path: str = "/join/", relay_port: int | None = None,
             extension: str | None = None) -> dict:
    """Run `page`'s script under PAGE_RUNNER: what it requested, and its elements after."""
    script = re.search(r"<script>(.*?)</script>", page, re.DOTALL).group(1)
    hidden = sorted({a["id"] for _, a in _parsed(page).tags if "hidden" in a and "id" in a})
    (tmp_path / "page.js").write_text(script)
    (tmp_path / "runner.cjs").write_text(PAGE_RUNNER)
    (tmp_path / "scenario.json").write_text(json.dumps({"hash": hash, "host": RELAY_HOST, "hidden": hidden,
                                                        "steps": steps or [], "replies": replies or {}, "path": path,
                                                        "port": relay_port, "extension": extension,
                                                        "nostr": str(REPO / "templates/cloudflare/src/nostr.ts")}))
    done = subprocess.run(["node", str(tmp_path / "runner.cjs"), str(tmp_path / "page.js"),
                           str(tmp_path / "scenario.json")], capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout.strip().splitlines()[-1])


def bearers(requests: list[dict]) -> list[dict]:
    return [r for r in requests if "url" in r and any(k.lower() == "authorization" for k in r["headers"])]


def test_an_invite_link_opens_the_console_and_sends_its_token_nowhere(worker, console_ws, tmp_path):
    """Reading a link at boot, or submitting a hidden pairing form while locked,
    must never send its bearer token to the relay or enable member controls."""
    code = hashlib.sha256(b"a code the console reads").hexdigest()
    token = invite_token(schema="cf.transport/1", relay=f"wss://{RELAY_HOST}", campaign="agents",
                         operator_pubkeys=[NIP19_NPUB], campaign_key="cd" * 32, code=code)
    served = worker.http("GET", "/join/")[2].decode()
    opened = run_page(tmp_path, served, hash=f"#{token}", steps=[["mark", "submit"], ["submit", "pair-form"]],
                      replies={"/openapi.json": [{"status": 200, "body": "{}"}]})
    requests, seen = opened["requests"], opened["elements"]
    assert requests[0] == {"replaceState": "/join/"}, "the fragment leaves the address bar first"
    before = requests[:requests.index({"mark": "submit"})]
    assert bearers(before) == [] and [r["url"] for r in before if "url" in r] == ["/"], "only NIP-11 at boot"
    assert seen["open-invite"]["text"] == "Redeem this invite" and seen["link-card"]["hidden"] is False
    assert seen["workspace"]["hidden"] is True
    assert not seen.get("pair-mcp", {}).get("text")
    assert bearers(requests) == [], "even a synthetic submit cannot send a bearer while locked"

    k8s = (console_build(console_ws) / "console" / "index.html").read_text()
    opened = run_page(tmp_path, k8s, hash=f"#{token}")
    assert bearers(opened["requests"]) == [] and opened["elements"]["pair-card"]["hidden"] is True
    assert opened["elements"].get("pair-mcp", {"text": ""})["text"] == "", "no MCP URL where no MCP server is"
    assert opened["elements"]["open-invite"]["text"] == "Redeem this invite"


def test_a_pasted_invite_gets_the_preview_a_clicked_link_gets(worker, build, tmp_path):
    code = hashlib.sha256(b"a pasted code").hexdigest()
    token = invite_token(schema="cf.transport/1", relay=f"wss://{RELAY_HOST}", campaign="agents",
                         operator_pubkeys=[NIP19_NPUB], code=code, member="boaz")
    for page in (worker.http("GET", "/")[2].decode(), (build / "github-pages" / "index.html").read_text()):
        for steps, fragment in (([], f"#{token}"), ([["set", "open-token", token], ["input", "open-token"]], "")):
            preview = run_page(tmp_path, page, hash=fragment, steps=steps)
            assert token not in json.dumps(preview["requests"])
            assert not any("dial" in r or "stored" in r for r in preview["requests"])
            assert token in preview["elements"]["install-prompt"]["text"]
            install, join = preview["elements"]["install-command"]["text"].splitlines()
            assert install == f"uv tool install git+{SOURCE_URL}"
            assert f"crosswire join '{token}'" in join and "crosswire watch bus" in join
    for given in (f"https://{RELAY_HOST}/join/#{token}", token, f"#join={token}"):
        seen = run_page(tmp_path, worker.http("GET", "/")[2].decode(),
                        steps=[["set", "open-token", given], ["submit", "open-form"]])
        assert bearers(seen["requests"]) == []
        els = seen["elements"]
        assert els["open-token"]["value"] == "", "the pasted token does not linger in the field"
        assert not els["link-card"]["hidden"], given
        assert els["link-about"]["text"] == "An invite to campaign agents on this relay, for boaz."
        assert els["link-command"]["text"] == f"crosswire join {token}"
    seen = run_page(tmp_path, worker.http("GET", "/")[2].decode(),
                    steps=[["set", "open-token", code], ["submit", "open-form"]])
    assert seen["elements"]["open-invite"]["text"] == "Redeem this invite", "retain the claim for retry"
    pages = (build / "github-pages" / "index.html").read_text()
    seen = run_page(tmp_path, pages, steps=[["set", "open-token", f"https://{RELAY_HOST}/join/#{token}"],
                                            ["submit", "open-form"]])
    els = seen["elements"]
    assert (els["invite"]["hidden"], els["invite-join"]["hidden"]) == (False, False)
    assert els["invite-command"]["text"] == f"nostr-mailbox join {token}" and els["open-token"]["value"] == ""
    assert [r["url"] for r in seen["requests"] if "url" in r] == [f"https://{RELAY_HOST}/"], "NIP-11 only"


def test_console_admission_uses_the_authenticated_relay(relay, worker, console_ws, tmp_path):
    """Run the actual UI handlers through AUTH, the gated REQ, claim, re-probe and sign-out
    against each relay implementation. The DOM and the extension API are the test doubles."""
    page = (worker.http("GET", "/")[2].decode() if relay.name == "worker"
            else (console_build(console_ws) / "console/index.html").read_text())
    code = json.loads(relay.admin("invites", "create", "--ttl", "1h", "--json"))["code"]
    token = invite_token(schema="cf.transport/1", relay=f"wss://{RELAY_HOST}", campaign="bus", code=code)

    def run(steps, **kwargs):
        return run_page(tmp_path, page, steps=steps, relay_port=relay.port, **kwargs)

    invalid = run([["set", "open-token", "unused-claim-code"], ["submit", "open-form"]])
    assert invalid["elements"]["workspace"]["hidden"]
    assert "invite" in invalid["elements"]["whoami"]["text"].lower()
    # The generated identity survives a refused invite and is never persisted.
    assert invalid["elements"]["backup-key"]["text"].startswith("nsec1")

    admitted = run([["submit", "open-form"]], hash=f"#{token}")
    els = admitted["elements"]
    assert not els["workspace"]["hidden"], els["whoami"]
    assert els["admission"]["hidden"] and not els["signout"]["hidden"]
    assert els["local-pair"]["hidden"] == (relay.name == "worker")
    frames = [r["frame"] for r in admitted["requests"] if "frame" in r]
    proof, claim = [f[1] for f in frames if f[0] in ("AUTH", "EVENT")]
    assert [proof["kind"], claim["kind"]] == [22242, 28934]
    assert all(event_is_signed(event) for event in (proof, claim))
    assert ["claim", code] in claim["tags"] and claim["pubkey"] == proof["pubkey"]
    assert len([f for f in frames if f[0] == "REQ" and f[2].get("ids")]) == 2
    nsec = els["backup-key"]["text"]
    assert nsec.startswith("nsec1") and nsec not in json.dumps(admitted["requests"])
    assert token not in json.dumps(admitted["requests"])

    restored = run([["set", "nsec", nsec], ["submit", "key-form"]])
    assert not restored["elements"]["workspace"]["hidden"]
    assert restored["elements"]["backup"]["hidden"] and not restored["elements"]["nsec"]["value"]
    assert nsec not in json.dumps(restored["requests"])
    assert [r["frame"][1]["pubkey"] for r in restored["requests"]
            if r.get("frame", [None])[0] == "AUTH"] == [proof["pubkey"]]

    guest = fresh_key()
    stranger = run([["click", "signin"]], extension=guest.secret.hex())
    assert stranger["elements"]["workspace"]["hidden"]
    assert "Redeem an invite" in stranger["elements"]["whoami"]["text"]
    relay.admin("members", "add", guest.pubkey)
    member = run([["click", "signin"]], extension=guest.secret.hex())
    assert not member["elements"]["workspace"]["hidden"]
    locked = run([["set", "nsec", nsec], ["submit", "key-form"], ["click", "signout"]])
    assert locked["elements"]["workspace"]["hidden"] and locked["elements"]["signout"]["hidden"]
    assert locked["elements"]["backup-key"]["text"] == "" and {"reload": True} in locked["requests"]
    assert {"socketClosed": True} in locked["requests"]
    if relay.name == "worker":
        paired = run([["click", "signin"], ["set", "room", "agents"], ["click", "mint"],
                      ["submit", "pair-form"]], extension=guest.secret.hex())
        minted = paired["elements"]["pair-token"]["value"]
        assert paired["elements"]["pair-mcp"]["text"] == f"https://{RELAY_HOST}/mcp/s/{minted}"
        assert bearers(paired["requests"]) == [{"url": "/openapi.json", "headers": {"Authorization": f"Bearer {minted}"}}]
        assert paired["elements"]["pair-status"]["text"] == "This relay honours the token."


def test_console_redeems_a_topic_grant_with_the_same_seat(relay, worker, console_ws, tmp_path):
    page = (worker.http("GET", "/")[2].decode() if relay.name == "worker"
            else (console_build(console_ws) / "console/index.html").read_text())
    [(keeper, wire)] = enrolled(relay, 1)
    group, group_code = "topic-" + os.urandom(4).hex(), os.urandom(16).hex()
    assert wire.publish(keeper.event(9007, [["h", group]]))[0]
    assert wire.publish(keeper.event(9009, [["h", group], ["code", group_code]]))[0]
    claim = next(t[1] for t in wire.invite()["tags"] if t[0] == "claim")
    redeem_key, epoch = fresh_key(), os.urandom(32).hex()
    token = invite_token(schema="cf.transport/1", relay=f"wss://{RELAY_HOST}", campaign="test", code=claim,
                         keyring=group, topic=group, role="read-only", owner=keeper.pubkey, group_code=group_code,
                         redeem=redeem_key.secret.hex(), epochs={"1": epoch}, current=1)
    result = run_page(tmp_path, page, relay_port=relay.port,
                      steps=[["set", "open-token", token], ["submit", "open-form"]])
    assert not result["elements"]["workspace"]["hidden"]
    assert result["elements"]["topic-status"]["text"] == "Joined as read-only."
    ring = json.loads(result["elements"]["topic-keys"]["text"])
    assert ring["name"] == group and ring["epochs"] == {"1": epoch}
    assert all(secret not in json.dumps(result["requests"]) for secret in (token, epoch, redeem_key.secret.hex()))
    req = next(r["frame"][1] for r in result["requests"]
               if r.get("frame", [None])[0] == "EVENT" and r["frame"][1]["kind"] == 9021)
    assert req["pubkey"] == ring["owner"]
    proof = bytes.fromhex(next(t[1] for t in req["tags"] if t[0] == "proof"))
    msg = hashlib.sha256(b"nostr-mailbox/topic-redeem/v1" + hashlib.sha256(group_code.encode()).digest()
                         + bytes.fromhex(req["pubkey"])).digest()
    assert schnorr_verify(msg, bytes.fromhex(redeem_key.pubkey), proof)


@pytest.mark.parametrize(("path", "fragment", "active"), [
    ("/docs", "", "docs"), ("/docs/", "", "docs"), ("/", "#docs", "docs"),
    ("/", "#acls", "acls"), ("/docs/", "#architecture", "architecture"),
    ("/docs/", "#switchboard", "switchboard"),
])
def test_console_documentation_deep_links(worker, tmp_path, path, fragment, active):
    page = worker.http("GET", path)[2].decode()
    seen = run_page(tmp_path, page, path=path, hash=fragment)
    assert [tab for tab in ("switchboard", "docs", "acls", "architecture")
            if not seen["elements"][tab]["hidden"]] == [active]
    assert not any("replaceState" in request for request in seen["requests"])
    assert seen["elements"]["workspace"]["hidden"]
    assert re.findall(r'<svg role="img".*?viewBox="([^"]+)"', page) == ["0 0 1120 320"] * 2
    for svg in re.findall(r"<svg .*?</svg>", page, re.DOTALL):
        assert 'var(--' in svg and not re.search(r'(?:fill|stroke)="#', svg)


MAYWE_ANSWERS = [
    (200, {"ok": True, "status": "pending"}, "good", "Request received. Check your inbox to confirm your place on the waitlist."),
    (200, {"ok": False, "status": "paused"}, "bad", "Invite requests are temporarily paused; please try again shortly."),
    (401, {"detail": "unknown key, or this key is not valid for this origin"}, "bad",
     "MayWe refused the request (HTTP 401): unknown key, or this key is not valid for this origin"),
    (422, {"detail": [{"msg": "value is not a valid email address"}]}, "bad",
     "MayWe refused the request (HTTP 422): value is not a valid email address"),
]


@pytest.mark.parametrize("status, answer, cls, said", MAYWE_ANSWERS, ids=["pending", "paused", "401", "422"])
def test_both_pages_say_what_maywe_answered_beside_the_email_field(worker, build, tmp_path, status, answer, cls, said):
    """MayWe's subscribe answers {ok, status}, ok false with 'paused' while the list takes
    no requests (newsletter app/routes/subscribe.py); 'pending' is also its answer where it
    sends no new mail, so success promises none. Both pages carry one answer reader."""
    console, pages = worker.http("GET", "/")[2].decode(), (build / "github-pages" / "index.html").read_text()
    block = re.compile(r"^  // BEGIN MayWe answer\n.*?^  // END MayWe answer\n", re.DOTALL | re.MULTILINE)
    assert block.search(console).group(0) == block.search(pages).group(0), "one reader on both pages"
    steps = [["set", "maywe-email", "someone@example.org"], ["set", "maywe-note", "Claude Code"],
             ["submit", "maywe-form"]]
    replies = {SUBSCRIBE_URL: [{"status": status, "body": json.dumps(answer)}]}
    for page in (console, pages):
        seen = run_page(tmp_path, page, steps=steps, replies=replies)
        posted = [r for r in seen["requests"] if r.get("url") == SUBSCRIBE_URL]
        assert len(posted) == 1 and posted[0]["method"] == "POST"
        form = urllib.parse.parse_qs(posted[0]["body"])
        assert (form["email"], form["source"], form["details"]) == (
            ["someone@example.org"], ["crosswire:invite-request"], ['{"use_case":"Claude Code"}'])
        status_line = seen["elements"]["maywe-status"]
        assert (status_line["text"], status_line["className"]) == (said, f"note {cls}")
        assert (seen["elements"]["maywe-email"]["value"] == "") == (cls == "good"), "kept for a retry on failure"


def console_block(script: str, name: str) -> str:
    """One `// BEGIN <name>` … `// END <name>` block of the console's own script."""
    block = re.search(rf"^  // BEGIN {re.escape(name)}\n.*?^  // END {re.escape(name)}\n", script, re.DOTALL | re.MULTILINE)
    assert block, name
    return block.group(0)


def console_mint(tmp_path: Path, script: str, origin: str, **given) -> dict:
    """What the console's Mint button packs, run under Node by the console's own packer and
    connection-URL blocks: the room's key (a fresh one when none is given), the nm1_ token,
    the operator's npub, and the URLs the Pair card shows for the token."""
    program = tmp_path / "mint.cjs"
    program.write_text(console_block(script, "nm1_ token packer") + console_block(script, "connection URLs") + """
const given = JSON.parse(process.argv[2]);
const key = given.campaignKey || freshRoomKey();
const token = packInvite(Object.assign({}, given, { campaignKey: key }));
console.log(JSON.stringify({ key: key, token: token, npub: npubOf(given.operator), urls: connectionUrls(process.argv[3], token) }));
""")
    done = subprocess.run(["node", str(program), json.dumps(given), origin], capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


@pytest.mark.skipif(not os.environ.get("NOSTR_MAILBOX_SRC"),
                    reason="set NOSTR_MAILBOX_SRC=<nostr-mailbox checkout>/skills/nostr-mailbox to run its CLI on a "
                           "token the console mints")
def test_a_token_the_console_mints_pairs_an_mcp_client_and_the_cli_in_one_room(worker, tmp_path):
    """The console's Mint button, end to end with nothing faked on either side: a member's
    REQ for kind 28935 gets a relay-signed code; the console's own packer makes it a whole
    nm1_ token for a room, byte for byte what nostr-mailbox's encoder makes of the same
    declaration; a magic-URL MCP client posts with it; a second token for the same room and
    key, joined by nostr-mailbox's own CLI through its join link, decrypts that post; and
    the client reads the CLI's answer. The NIP-07 signer and localStorage, which only a
    browser has, stand outside: the member signs here with its own key."""
    sys.path.insert(0, os.environ["NOSTR_MAILBOX_SRC"])
    from nostr_mailbox import bech32  # type: ignore[import-not-found]
    from nostr_mailbox import cli as mailbox_cli  # type: ignore[import-not-found]
    from nostr_mailbox.profile import Trust  # type: ignore[import-not-found]

    page = worker.http("GET", "/")[2].decode()
    script = re.search(r"<script>(.*?)</script>", page, re.DOTALL).group(1)
    assert "packInvite({ relay: RELAY_URL, campaign: room, operator: state.me, campaignKey: key.hex, code: code });" in script
    assert "var events = await query({ kinds: [28935], limit: 1 });" in script
    relay = WorkerRelay(worker)
    [(member, wire)] = enrolled(relay, 1)

    def minted_code() -> str:
        invite = wire.invite()
        assert invite["pubkey"] == relay_pubkey(relay) and event_is_signed(invite), "the console checks this too"
        return next(t[1] for t in invite["tags"] if t[0] == "claim")

    room = f"agents-{os.urandom(3).hex()}"
    code = minted_code()
    first = console_mint(tmp_path, script, ORIGIN, relay=f"wss://{RELAY_HOST}", campaign=f"#{room}",
                         operator=member.pubkey, code=code)
    key, token = first["key"], first["token"]
    assert re.fullmatch(r"[0-9a-f]{64}", key) and first["npub"] == bech32.encode("npub", bytes.fromhex(member.pubkey))
    declared = Trust.from_mapping({"schema": "cf.transport/1", "relay": f"wss://{RELAY_HOST}", "campaign": room,
                                   "operator_pubkeys": [first["npub"]], "campaign_key": key}, source="the console's room")
    assert token == mailbox_cli._encode_invite_token(declared, code), "nostr-mailbox's own encoder, byte for byte"
    assert first["urls"] == {"oauth": RESOURCE, "mcp": f"{ORIGIN}/mcp/s/{token}",
                             "openapi": f"{ORIGIN}/mcp/s/{token}/openapi.json", "join": f"{ORIGIN}/join/#{token}"}

    # The 1-paste magic URL: an MCP client set to Authentication: None, on the room's bus.
    status, _, body = worker.http("GET", urllib.parse.urlsplit(first["urls"]["openapi"]).path)
    assert (status, json.loads(body)["servers"]) == (200, [{"url": first["urls"]["mcp"]}])
    chatgpt = Mcp(worker, urllib.parse.urlsplit(first["urls"]["mcp"]).path.rsplit("/", 1)[1], magic=True)
    chatgpt.initialize()
    listed = chatgpt.call("mailbox_list")
    assert (listed["campaign"], listed["relay_member"], listed["token"]["redeemed"]) == (room, False, False)
    posted = chatgpt.call("mailbox_post", {"channel": "bus", "body": "From ChatGPT, on a token the console minted"})
    assert posted["accepted"] and posted["topic"] == "bus"
    [stored] = wire.read({"ids": [posted["id"]]})
    assert ["t", f"{room}:bus"] in stored["tags"] and ["epoch", "1"] in stored["tags"]
    assert "console minted" not in stored["content"], "the relay keeps NIP-44 ciphertext only"

    # A second Mint for the same room carries the same key. The CLI dials the harness on
    # loopback, so this token names the relay's public name as relay_auth_url, as a seat
    # behind a port-forward does; the console itself never sets it.
    second = console_mint(tmp_path, script, ORIGIN, relay=f"ws://127.0.0.1:{worker.port}", campaign=room,
                          operator=member.pubkey, code=minted_code(), campaignKey=key, relayAuthUrl=f"wss://{RELAY_HOST}")
    home = tmp_path / "agent"
    joined = nostr_mailbox_cli(home, "join", second["urls"]["join"])
    assert (joined["joined"], joined["campaign"]) == (f"ws://127.0.0.1:{worker.port}", room)
    check = nostr_mailbox_cli(home, "relay", "check")
    assert (check["ok"], check["authenticated"], check["relay_access"]) == (True, True, True)
    seen = nostr_mailbox_cli(home, "watch", "bus", "--wait-seconds", "0")
    assert "rejected" not in seen, seen["rejected"]
    assert [(m["id"], m["body"]) for m in seen["messages"]] == [(posted["id"], "From ChatGPT, on a token the console minted")]
    reply = nostr_mailbox_cli(home, "post", "bus", "From the local agent, on the same room key")
    messages = chatgpt.call("mailbox_watch", {"channel": "bus"})["messages"]
    assert [(m["id"], m["body"], m["author"]) for m in messages] == [
        (reply["id"], "From the local agent, on the same room key", bech32.pubkey_hex(joined["npub"]))]


def test_oauth_and_magic_url_clients_talk_with_a_local_agent(worker, keeper):
    """Both zero-paste connections on one topic, with nostr-mailbox's own CLI on the other
    end and nothing faked: a client that signed in with OAuth posts over /mcp, a client on a
    magic URL posts over /mcp/s/<token> and over its OpenAPI twin, the CLI decrypts all
    three and answers on the bus, and both clients read the answer. Each client has a token
    of its own, as the docs say to give one."""
    topic, cli = keeper["topic"], keeper["cli"]
    second = cli("topic", "invite", topic, "--for", "claude")
    assert (second["topic"], second["role"]) == (topic, "read-write")

    claude = Mcp(worker, sign_in(worker, second["token"]))
    claude.initialize()
    claude_persona = claude.call("mailbox_list")["persona"]
    asked = claude.call("mailbox_post", {"channel": "bus", "kind": "question", "body": "From Claude (OAuth): CI green?"})
    chatgpt = Mcp(worker, keeper["token"], magic=True)
    chatgpt.initialize()
    chatgpt_persona = chatgpt.call("mailbox_list")["persona"]
    noted = chatgpt.call("mailbox_post", {"channel": topic, "body": "From ChatGPT (magic URL): watching too"})
    status, acted = action(worker, keeper["token"], "mailbox_post", {"channel": "bus", "body": "From a GPT Action (magic URL)"},
                           magic=True)
    assert status == 200 and all(p["accepted"] for p in (asked, noted, acted))
    assert claude_persona["pubkey"] != chatgpt_persona["pubkey"]

    seen = cli("watch", "bus", "--wait-seconds", "0")
    assert "rejected" not in seen, seen["rejected"]
    assert {(m["id"], m["author"], m["body"]) for m in seen["messages"]} == {
        (asked["id"], claude_persona["pubkey"], "From Claude (OAuth): CI green?"),
        (noted["id"], chatgpt_persona["pubkey"], "From ChatGPT (magic URL): watching too"),
        (acted["id"], chatgpt_persona["pubkey"], "From a GPT Action (magic URL)"),
    }
    reply = cli("post", "bus", "From the local agent: green", "--kind", "answer", "--reply-to", asked["id"])
    for client, own in ((claude, {asked["id"]}), (chatgpt, {noted["id"], acted["id"]})):
        messages = client.call("mailbox_watch", {"channel": "bus"})["messages"]
        assert reply["id"] in {m["id"] for m in messages}, "each client reads the local agent's answer"
        assert not own & {m["id"] for m in messages}, "and is not sent its own posts"
        [answered] = [m for m in messages if m["id"] == reply["id"]]
        assert (answered["author"], answered["reply_to"], answered["body"]) == (
            keeper["pubkey"], asked["id"], "From the local agent: green")


# ====================================================================== check-clean
def test_check_clean_passes_on_a_clean_repository(tmp_path):
    ws = git_workspace(tmp_path)
    run_cli(ws, "--target", "all")
    assert PRIVATE["relay_host"] in (ws / ".build" / "kubernetes" / "ingressroute.yaml").read_text()
    done = run_cli(ws, "--check-clean")
    assert "check-clean: OK" in done.stdout


def test_check_clean_includes_every_local_relay(tmp_path):
    ws = git_workspace(tmp_path)
    (ws / "relay.local.toml").rename(ws / "relay.internal.local.toml")
    edge_host = "edge.remote-zeta.test"
    (ws / "profiles").mkdir()
    external = "profiles/relay.external.local.toml"
    (ws / external).write_text(dump_toml(private_config(relay_host=edge_host)))
    for profile in ("internal", "external"):
        config = external if profile == "external" else "relay.internal.local.toml"
        run_cli(ws, "--config", config, "--profile", profile, "--target", "all")
    assert git(ws, "status", "--porcelain") == ""
    run_cli(ws, "--check-clean")

    (ws / "notes.md").write_text(PRIVATE["relay_host"] + "\n" + edge_host)
    for source in ([], ["--config", external], ["--example"]):
        done = run_cli(ws, "--check-clean", *source, expect=1)
        assert "relay.internal.local.toml" in done.stderr and edge_host in done.stderr


def test_check_clean_rejects_unignored_and_force_added_profile_configs(tmp_path):
    ws = git_workspace(tmp_path)
    # An example-only config still needs protection even when it has no private tokens.
    (ws / "configs").mkdir()
    profile = "configs/relay.external.local.toml"
    shutil.copyfile(ws / "relay.toml.example", ws / profile)
    gitignore = ws / ".gitignore"
    rules = gitignore.read_text()
    gitignore.write_text(rules + f"\n!{profile}\n")
    assert f"{profile} is not gitignored" in run_cli(ws, "--check-clean", expect=1).stderr
    gitignore.write_text(rules)
    git(ws, "add", "-f", profile)
    assert f"{profile} is tracked by Git" in run_cli(ws, "--check-clean", expect=1).stderr


LEAKS = {
    "a tracked file": lambda ws, token: (ws / "README.md").write_text(f"Deployed at {token}\n") or git(ws, "add", "-A"),
    "an untracked file": lambda ws, token: (ws / "notes.md").write_text(f"see {token}\n"),
    "a staged version only": lambda ws, token: (
        (ws / "staged.md").write_text(token), git(ws, "add", "staged.md"), (ws / "staged.md").write_text("clean")),
    "committed history": lambda ws, token: (
        (ws / "old.md").write_text(token), git(ws, "add", "-A"), git(ws, "commit", "-qm", "add"),
        git(ws, "rm", "-q", "old.md"), git(ws, "commit", "-qm", "remove")),
    "a commit message": lambda ws, token: git(ws, "commit", "-q", "--allow-empty", "-m", f"deploy to {token}"),
    "a path name": lambda ws, token: (ws / f"{token}.md").write_text("clean"),
}


@pytest.mark.parametrize("where", LEAKS)
@pytest.mark.parametrize("token", [PRIVATE["relay_host"], PRIVATE["storage_class"].upper(),
                                   "intranet-zeta.test", PRIVATE["forbidden"]],
                         ids=["relay_host", "storage_class in upper case", "relay_host's parent domain",
                              "forbidden_tokens"])
def test_check_clean_finds_a_private_value_wherever_git_would_publish_it(tmp_path, where, token):
    ws = git_workspace(tmp_path)
    LEAKS[where](ws, token)
    done = run_cli(ws, "--check-clean", expect=1)
    assert token.casefold() in done.stderr.casefold()


def test_check_clean_finds_secret_shaped_values(tmp_path):
    ws = git_workspace(tmp_path)
    invite = base64.urlsafe_b64encode(json.dumps({"relay": f"wss://{RELAY_HOST}", "code": "c0de"}).encode())
    secrets_file = "\n".join([
        "nsec1" + "q" * 58,
        "-----BEGIN " + "EC PRIVATE KEY-----",
        "RELAY_SIGNING_KEY=" + "a1" * 32,
        "ADMIN_TOKEN = '" + "b2" * 32 + "'",
        "client-key-data: " + base64.b64encode(b"-----BEGIN " + b"RSA PRIVATE KEY-----\n").decode(),
        "token: nm1_" + invite.rstrip(b"=").decode(),
    ])
    (ws / "leak.txt").write_text(secrets_file)
    done = run_cli(ws, "--check-clean", expect=1)
    for kind in hydrate.SECRET_KINDS:
        assert kind in done.stderr, kind
    assert "a1" * 32 not in done.stderr, "a secret's value is never printed"
    (ws / "leak.txt").write_text("Join with: nostr-mailbox join nm1_<token>\nclient-key-data: DATA+OMITTED\n")
    run_cli(ws, "--check-clean")


def test_check_clean_requires_the_private_files_to_stay_ignored(tmp_path):
    ws = git_workspace(tmp_path)
    gitignore = (ws / ".gitignore").read_text()
    (ws / ".gitignore").write_text(gitignore.replace("relay.local.toml\n", "").replace("*.local.toml\n", ""))
    done = run_cli(ws, "--check-clean", expect=1)
    assert "relay.local.toml is not gitignored" in done.stderr
    (ws / ".gitignore").write_text(gitignore)
    git(ws, "add", "-f", "relay.local.toml")
    done = run_cli(ws, "--check-clean", expect=1)
    assert "relay.local.toml is tracked by Git" in done.stderr


def test_check_clean_does_not_forbid_public_vocabulary(tmp_path):
    ws = git_workspace(tmp_path)
    data = private_config()
    data["kubernetes"]["namespace"] = "relay"
    (ws / "relay.local.toml").write_text(dump_toml(data))
    done = run_cli(ws, "--check-clean")
    assert "kubernetes.namespace value 'relay' is not checked" in done.stdout


def test_check_clean_without_a_local_config_checks_secrets_and_forbid(tmp_path):
    ws = git_workspace(tmp_path)
    (ws / "relay.local.toml").unlink()
    (ws / "README.md").write_text("mentions acme-internal\n")
    assert "no relay.local.toml" in run_cli(ws, "--check-clean").stdout
    done = run_cli(ws, "--check-clean", "--forbid", "ACME-internal", expect=1)
    assert "acme-internal" in done.stderr and "--forbid" in done.stderr


# =========================================================================== verify
class _RecordingProxy:
    """A loopback TCP listener that counts connections: an HTTP proxy nobody should use."""

    def __init__(self):
        self.sock = socket.create_server(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.connections = 0
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            conn.close()

    def close(self):
        self.sock.close()


def test_verify_reads_nip11_directly_whatever_proxy_the_environment_names(example_ws, worker, monkeypatch):
    proxy = _RecordingProxy()
    try:
        proxied = {name: f"http://127.0.0.1:{proxy.port}"
                   for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")}
        for name, value in proxied.items():
            monkeypatch.setenv(name, value)
        monkeypatch.delenv("NO_PROXY", raising=False)
        monkeypatch.delenv("no_proxy", raising=False)
        with pytest.raises((urllib.error.URLError, ConnectionError, OSError)):
            urllib.request.urlopen(f"{worker.origin}/")        # the control: plain urllib takes the proxy
        assert proxy.connections == 1
        env = {k: v for k, v in os.environ.items() if k.lower() != "no_proxy"} | proxied
        done = run_cli(example_ws, "--example", "--verify", "--verify-url", f"{worker.origin}/", env=env)
        assert "verify: OK" in done.stdout and '"access_control_allow_origin": "*"' in done.stdout
        assert proxy.connections == 1, "--verify must not go through the environment's proxy"
    finally:
        proxy.close()


def test_verify_fails_on_a_relay_that_does_not_advertise_both_gates(example_ws):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"name": "Private campaign relay", "limitation": {"auth_required": False}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/nostr+json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        done = run_cli(example_ws, "--example", "--verify", "--verify-url",
                       f"http://127.0.0.1:{server.server_address[1]}/", expect=1)
        assert "limitation.auth_required is False" in done.stderr
        assert "limitation.membership_required is None" in done.stderr
    finally:
        server.shutdown()


def test_cli_usage_errors():
    for args, message in ((["--apply", "--example", "--target", "compose"], "--apply needs --target kubernetes"),
                          (["--example"], "nothing to do"),
                          (["--example", "--target", "all", "--verify-url", "http://x/"], "--verify-url needs --verify")):
        done = subprocess.run([sys.executable, str(REPO / "scripts" / "hydrate.py"), *args],
                              capture_output=True, text=True, check=False)
        assert done.returncode == 2 and message in done.stderr, args
