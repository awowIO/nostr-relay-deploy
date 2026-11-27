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
  - `kubectl kustomize` (offline) builds the hydrated Kubernetes tree when kubectl is
    installed.
  - When a Docker daemon answers, the pinned ncli release itself: `ncli relay --check`
    on the hydrated relay.yaml, and a live ncli relay booted on it. The self-service
    scenarios (member-minted invites, NIP-29 groups, recipient-only kinds, what `/`
    answers) run against that relay and against the Worker, with the same assertions,
    so the Worker is held to what the relay the other two targets deploy actually does.

Not covered here, said plainly: `--apply` against a cluster (its real-contact path is an
operator's first apply, which runs a server-side dry run before it mutates anything);
the Workers runtime itself (WebSocketPair, hibernation, Durable Object routing, R2; the
harness stands in for those); Caddy and Traefik binaries; `docker compose config`; the
console page in a browser (its script is syntax-checked by Node and its CSP hashes are
checked, but no browser runs it). Without Docker the ncli witnesses are SKIPPED, and
nothing else here proves agreement with ncli.
Set NOSTR_MAILBOX_SRC=<nostr-mailbox checkout>/skills/nostr-mailbox to also run
nostr-mailbox's own client, admin wrapper and Blossom client against the Worker.
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
                                    "NetworkPolicy", "NetworkPolicy"])
    backend = next(d for d in docs if "name: nostr-relay-backend" in d)
    assert "namespace: traefik" in backend
    assert "auth_required: true" in next(d for d in docs if d.startswith("apiVersion: v1\ndata:"))


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
    if done.returncode != 0:
        return f"no Docker daemon answers (docker info: {done.stderr.strip()[:300]}); set DOCKER_HOST"
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
    assert {p.name for p in (cf / "src").iterdir()} == {"worker.ts", "nostr.ts", "console.ts"}
    for name in ("worker.ts", "nostr.ts", "console.ts"):
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
    assert "default-src 'none'" in csp and f"connect-src https://{RELAY_HOST};" in csp
    # Self-contained: no stylesheet, script, image or link pointing anywhere.
    assert not [(t, a) for t, a in parsed.tags if "src" in a or "href" in a or t == "link"]
    style = re.sub(r"/\*.*?\*/", "", parsed.style, flags=re.DOTALL)
    page_rule = re.search(r"\.page\s*\{([^}]*)\}", style).group(1)
    assert re.search(r"(^|;)\s*width:\s*100%", page_rule)
    assert re.search(r"max-width:\s*none", page_rule)
    assert "padding-inline: clamp(20px, 4vw, 64px)" in page_rule
    assert re.findall(r"max-width\s*:\s*([^;}]+)", style) == ["none"], "no boxed max-width container anywhere"
    assert "@media (max-width" not in style
    assert "@media (prefers-color-scheme: dark)" in style and "color-scheme: light dark" in style
    assert f'const RELAY_HOST = "{RELAY_HOST}";' in page
    assert 'fetch(url, { headers: { Accept: "application/nostr+json" }' in page
    for command in ("claude plugin marketplace add awowIO/nostr-mailbox",
                    "claude plugin install nostr-mailbox@nostr-mailbox",
                    "codex plugin marketplace add awowIO/nostr-mailbox",
                    "uv tool install git+https://github.com/awowIO/nostr-mailbox",
                    "nostr-mailbox join &lt;nm1_ token from your operator&gt;", "nostr-mailbox relay check",
                    f"nostr-mailbox setup --relay wss://{RELAY_HOST} --campaign my-campaign --kubectl"):
        assert command in page, command
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
# tells a WebSocket, a NIP-11 client and a browser apart. Every other path stays shut.
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
]


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
    """Evaluate the hydrated IngressRoute's match rules (Traefik v3 rule syntax)."""
    rules = re.findall(r"- match: '(.*)'", ingressroute)
    assert len(rules) == 3

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

    return any(evaluate(rule) for rule in rules)


@pytest.mark.parametrize("name, method, path, headers, host, admitted", PROBES, ids=[p[0] for p in PROBES])
def test_caddy_traefik_and_the_worker_admit_the_same_routes(build, worker, name, method, path, headers,
                                                            host, admitted):
    host = host or RELAY_HOST
    caddy = caddy_admits((build / "compose" / "Caddyfile").read_text(), host, method, path, headers)
    traefik = traefik_admits((build / "kubernetes" / "ingressroute.yaml").read_text(), host, method, path, headers)
    answer = worker.probe(method, path, headers, host)
    assert (caddy, traefik, answer["status"] != 404) == (admitted, admitted, admitted), answer
    if admitted and path == "/" and "Upgrade" in headers:
        assert answer["upgrade"] is True


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
    # Self-contained: no stylesheet, script, image or link to anywhere, and no other site named.
    assert not [(t, a) for t, a in parsed.tags if "src" in a or "href" in a or t == "link"]
    assert "http://" not in page and "https://" not in page
    # The CSP admits this script and this style, by hash, and connects to this relay only.
    script = re.search(r"<script>(.*?)</script>", page, re.DOTALL).group(1)
    style = re.search(r"<style>(.*?)</style>", page, re.DOTALL).group(1)
    policy = dict(part.strip().split(" ", 1) for part in headers["Content-Security-Policy"].split(";"))
    digest = lambda text: "'sha256-" + base64.b64encode(hashlib.sha256(text.encode()).digest()).decode() + "'"
    assert policy["default-src"] == "'none'" and policy["frame-ancestors"] == "'none'"
    assert policy["script-src"] == digest(script) and policy["style-src"] == digest(style)
    assert policy["connect-src"] == f"'self' wss://{RELAY_HOST}"
    assert headers["X-Content-Type-Options"] == "nosniff" and headers["Referrer-Policy"] == "no-referrer"
    # The script parses: the same engine family as the browsers that run it.
    (tmp_path / "console.js").write_text(script)
    checked = subprocess.run(["node", "--check", str(tmp_path / "console.js")], capture_output=True, text=True,
                             check=False)
    assert checked.returncode == 0, checked.stderr
    for needle in ("['AUTH', proof]", "kinds: [28935], limit: 1", "28934, [['-'], ['claim', code]]",
                   "publish(9007, [['h', id]]", "kinds: [9021], '#h': [id]", "kinds: [1059, 4410, 4411], '#p'",
                   "'wss://' + location.host", "window.nostr"):
        assert needle in script, needle
    assert "innerHTML" not in script, "what the relay sends is text, never markup"
    # Full width, light and dark, like the GitHub Pages page.
    css = re.sub(r"/\*.*?\*/", "", style, flags=re.DOTALL)
    page_rule = re.search(r"\.page\s*\{([^}]*)\}", css).group(1)
    assert re.search(r"(^|;)\s*width:\s*100%", page_rule) and re.search(r"max-width:\s*none", page_rule)
    assert "padding-inline: clamp(20px, 4vw, 64px)" in page_rule
    assert re.findall(r"max-width\s*:\s*([^;}]+)", css) == ["none"], "no boxed max-width container anywhere"
    assert "@media (prefers-color-scheme: dark)" in css and "color-scheme: light dark" in css
    status, headers, body = worker.http("HEAD", "/", headers={"Accept": "text/html"})
    assert (status, headers["Content-Type"], body) == (200, "text/html; charset=utf-8", b"")
    status, _, body = worker.http("GET", "/", headers={"Accept": "application/nostr+json, */*"})
    assert status == 400 and b"application/nostr+json" in body


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

    def connect(self) -> Wire:
        return Wire(self.harness.connect())

    def admin(self, *args: str) -> str:
        return run_shim(self.harness, *args).stdout

    def http(self, method: str, headers: dict[str, str]):
        return self.harness.http(method, "/", headers=headers)


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

    def http(self, method: str, headers: dict[str, str]):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/", method=method, headers=headers)
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


@pytest.fixture(scope="session")
def ncli_relay(build):
    problem = docker_problem()
    if problem is not None:
        pytest.skip(problem)
    name = f"nostr-relay-deploy-test-{os.urandom(4).hex()}"
    env = ncli_env((build / "compose" / "relay.yaml").read_text())
    started = subprocess.run(ncli_argv("-d", "--name", name, "-p", "127.0.0.1::5500"), env=env,
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


# ======================================================= self-service: the Worker only
def test_the_worker_keeps_group_state_its_own(worker):
    (alice, a), (bob, b) = enrolled(WorkerRelay(worker), 2)
    g = f"ops-{os.urandom(4).hex()}"
    assert a.publish(alice.event(9007, [["h", g]])) == (True, f"info: group {g} created.")
    meta = a.read({"kinds": [39000], "#d": [g]})[0]
    assert meta["tags"] == [["d", g], ["private"], ["restricted"], ["closed"]]
    roles = a.read({"kinds": [39003], "#d": [g]})[0]
    assert roles["tags"] == [["d", g], ["role", "admin", "may put-user, remove-user, edit-metadata"]]
    assert event_is_signed(roles) and roles["pubkey"] == RELAY_PUBKEY
    for kind in (39000, 39002, 28935):
        forged = alice.event(kind, [["d", g], ["p", alice.pubkey]])
        assert a.publish(forged) == (False, f"restricted: kind {kind} is signed by the relay alone")
    assert a.publish(alice.event(9007, [["h", "Not An Id"]])) == (
        False, "invalid: a group id is made of a-z, 0-9, '-' and '_' (NIP-29)")
    assert a.publish(alice.event(9007, [])) == (False, "invalid: nip29: missing h tag (group id)")
    assert a.publish(alice.event(9005, [["h", g], ["e", "0" * 64]])) == (
        False, "invalid: kind 9005 is not a NIP-29 request this relay implements (9000, 9001, 9002, 9007, 9021, 9022)")
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


# ====================================================================== check-clean
def test_check_clean_passes_on_a_clean_repository(tmp_path):
    ws = git_workspace(tmp_path)
    run_cli(ws, "--target", "all")
    assert PRIVATE["relay_host"] in (ws / ".build" / "kubernetes" / "ingressroute.yaml").read_text()
    done = run_cli(ws, "--check-clean")
    assert "check-clean: OK" in done.stdout


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
