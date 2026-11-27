#!/usr/bin/env python3
"""Hydrate the relay templates with one operator's settings, and keep those settings out of Git.

    python3 scripts/hydrate.py --target all                   relay.local.toml -> .build/<target>/
    python3 scripts/hydrate.py --example --target all         relay.toml.example -> .build/<target>/
    python3 scripts/hydrate.py --config relay.external.local.toml --profile external --target cloudflare
    python3 scripts/hydrate.py --check-clean                  nothing private in what Git would publish
    python3 scripts/hydrate.py --target kubernetes --apply    namespace, signing Secret, apply -k
    python3 scripts/hydrate.py --target kubernetes --verify   rollout state + NIP-11 at https://<relay_host>/

Targets: kubernetes, compose, cloudflare, github-pages (or all). Output goes to
.build/<target>/ or .build/<profile>/<target>/. Both .build/ and *.local.toml are
gitignored. Standard library only, Python 3.12+.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import datetime
import html
import json
import re
import secrets
import shlex
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = REPO_ROOT / "templates"
EXAMPLE_CONFIG = REPO_ROOT / "relay.toml.example"
LOCAL_CONFIG = REPO_ROOT / "relay.local.toml"
BUILD_DIR = REPO_ROOT / ".build"
TARGETS = ("kubernetes", "compose", "cloudflare", "github-pages")
MANIFEST = ".hydrated"          # what the last hydration wrote, so stale outputs can go

# The relay release nostr-mailbox is tested against, pinned by digest.
NCLI_IMAGE = ("ghcr.io/ohstr/ncli:0.8.0-rc.54"
              "@sha256:fc131ffc2de36b54e2e7598f2ee0cddec1e64a113d85491632c51e3dc988516a")
# Names nostr-mailbox's `--kubectl` reaches by default (namespace aside, which is
# configurable): pod nostr-relay-0, container relay. They are also the names of the live
# objects a zero-downtime apply must update in place, so they are not settings.
STATEFULSET_NAME = "nostr-relay"
APP_LABEL = "nostr-relay"
SIGNING_SECRET = "nostr-relay-signing"
CONFIGMAP_NAME = "nostr-relay-config"


class HydrateError(Exception):
    """Something the operator has to fix; the message says what."""


class ConfigError(HydrateError):
    """relay.local.toml (or the file given) is not a valid configuration."""


class ApplyError(HydrateError):
    """A kubectl step of --apply or --verify failed."""


class VerifyError(HydrateError):
    """The deployed relay does not answer as configured."""


# ============================================================================ validation
_DNS_LABEL = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
_QUANTITY = re.compile(r"(?P<num>\d+(\.\d*)?|\.\d+)(?P<suffix>[eE][+-]?\d+|Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?")
_QUANTITY_SCALE = {
    "": Decimal(1), "n": Decimal("1e-9"), "u": Decimal("1e-6"), "m": Decimal("1e-3"),
    "k": Decimal("1e3"), "M": Decimal("1e6"), "G": Decimal("1e9"), "T": Decimal("1e12"),
    "P": Decimal("1e15"), "E": Decimal("1e18"),
    "Ki": Decimal(2**10), "Mi": Decimal(2**20), "Gi": Decimal(2**30), "Ti": Decimal(2**40),
    "Pi": Decimal(2**50), "Ei": Decimal(2**60),
}
_LABEL_NAME = re.compile(r"[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?")
_LABEL_VALUE = re.compile(r"([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?")
_NIP05_NAME = re.compile(r"[a-z0-9._-]+")
_HEX64 = re.compile(r"[0-9a-f]{64}")


def _require(kind: type, value: Any, where: str, what: str) -> Any:
    # bool is an int in Python; a TOML `true` is never a count.
    if not isinstance(value, kind) or (kind is int and isinstance(value, bool)):
        raise ConfigError(f"{where} must be {what}, got {value!r}")
    return value


def hostname(value: Any, where: str) -> str:
    _require(str, value, where, "a DNS hostname string")
    if len(value) > 253 or "." not in value:
        raise ConfigError(f"{where} must be a fully qualified hostname such as relay.example.com, "
                          f"got {value!r}")
    for label in value.split("."):
        if not _DNS_LABEL.fullmatch(label):
            raise ConfigError(
                f"{where} must be a lowercase hostname (labels of a-z, 0-9 and inner '-', 1-63 "
                f"characters; no scheme, port or path), got {value!r}")
    return value


def text_line(value: Any, where: str) -> str:
    _require(str, value, where, "a string")
    if not value.strip() or any(ch in value for ch in "\r\n\t") or not value.isprintable():
        raise ConfigError(f"{where} must be one non-empty line of printable text, got {value!r}")
    return value


def positive_int(value: Any, where: str) -> int:
    _require(int, value, where, "a positive integer")
    if value <= 0:
        raise ConfigError(f"{where} must be a positive integer, got {value!r}")
    return value


def boolean(value: Any, where: str) -> bool:
    return _require(bool, value, where, "true or false")


def quantity_value(text: str) -> Decimal:
    """A Kubernetes resource quantity as a number of base units ("4Gi" -> 4294967296)."""
    m = _QUANTITY.fullmatch(text)
    if m is None:
        raise ValueError(text)
    suffix = m.group("suffix") or ""
    number = Decimal(m.group("num"))
    if suffix[:1] in ("e", "E"):
        return number * (Decimal(10) ** int(suffix[1:]))
    return number * _QUANTITY_SCALE[suffix]


def k8s_quantity(value: Any, where: str) -> str:
    _require(str, value, where, 'a Kubernetes quantity string such as "4Gi" or "500m"')
    try:
        amount = quantity_value(value)
    except (ValueError, InvalidOperation) as exc:
        raise ConfigError(f'{where} must be a Kubernetes quantity such as "4Gi", "128Gi", "2" or '
                          f'"500m", got {value!r}') from exc
    if amount <= 0:
        raise ConfigError(f"{where} must be a positive quantity, got {value!r}")
    return value


def dns_label(value: Any, where: str) -> str:
    _require(str, value, where, "a DNS-1123 label")
    if not _DNS_LABEL.fullmatch(value):
        raise ConfigError(f"{where} must be a DNS-1123 label (a-z, 0-9, inner '-', at most 63 "
                          f"characters), got {value!r}")
    return value


def dns_subdomain(value: Any, where: str) -> str:
    _require(str, value, where, "a DNS-1123 subdomain")
    if len(value) > 253 or not all(_DNS_LABEL.fullmatch(part) for part in value.split(".")):
        raise ConfigError(f"{where} must be a DNS-1123 subdomain (lowercase labels joined by '.'), "
                          f"got {value!r}")
    return value


def plain_name(value: Any, where: str) -> str:
    """A name rendered unquoted into YAML: letters, digits, '-', '_' and '.' only."""
    _require(str, value, where, "a name")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise ConfigError(f"{where} must be letters, digits, '.', '_' or '-', got {value!r}")
    return value


def path_text(value: Any, where: str) -> str:
    _require(str, value, where, "a file path")
    if "\n" in value or "\x00" in value:
        raise ConfigError(f"{where} must be a single-line path, got {value!r}")
    return value


def label_selector(value: Any, where: str) -> str:
    """`key=value[,key=value...]`, the equality form `kubectl -l` takes."""
    _require(str, value, where, 'a label selector such as "app.kubernetes.io/name=traefik"')
    for pair in value.split(","):
        key, sep, val = pair.partition("=")
        prefix, slash, name = key.rpartition("/")
        ok = (sep == "=" and _LABEL_NAME.fullmatch(name) and _LABEL_VALUE.fullmatch(val)
              and (not slash or dns_subdomain_ok(prefix)))
        if not ok:
            raise ConfigError(f"{where} must be key=value pairs joined by ',' with valid Kubernetes "
                              f"label keys and values, got {value!r}")
    return value


def dns_subdomain_ok(text: str) -> bool:
    return 0 < len(text) <= 253 and all(_DNS_LABEL.fullmatch(p) for p in text.split("."))


def compose_cpus(value: Any, where: str) -> str:
    _require(str, value, where, 'a CPU count string such as "2" or "0.5"')
    if not re.fullmatch(r"\d+(\.\d+)?", value) or Decimal(value) <= 0:
        raise ConfigError(f'{where} must be a positive decimal CPU count such as "2" or "0.5", '
                          f"got {value!r}")
    return value


def compose_bytes(value: Any, where: str) -> str:
    _require(str, value, where, 'a Compose byte value such as "4G" or "512M"')
    m = re.fullmatch(r"(\d+(\.\d+)?)([bkmgBKMG][bB]?)?", value)
    if m is None or Decimal(m.group(1)) <= 0:
        raise ConfigError(f'{where} must be a positive Compose byte value such as "4G", "512M" or '
                          f'"1g", got {value!r}')
    return value


def worker_name(value: Any, where: str) -> str:
    _require(str, value, where, "a Cloudflare Worker name")
    if not _DNS_LABEL.fullmatch(value):
        raise ConfigError(f"{where} must be a Worker name (a-z, 0-9, inner '-', at most 63 "
                          f"characters), got {value!r}")
    return value


def r2_bucket(value: Any, where: str) -> str:
    _require(str, value, where, "an R2 bucket name")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", value):
        raise ConfigError(f"{where} must be an R2 bucket name (3-63 characters: a-z, 0-9, inner "
                          f"'-'), got {value!r}")
    return value


def past_date(value: Any, where: str) -> str:
    _require(str, value, where, 'a date "YYYY-MM-DD"')
    try:
        day = datetime.date.fromisoformat(value)
    except ValueError as exc:
        raise ConfigError(f'{where} must be a date "YYYY-MM-DD", got {value!r}') from exc
    if len(value) != 10 or day > datetime.datetime.now(datetime.UTC).date():
        raise ConfigError(f"{where} must be a YYYY-MM-DD date no later than today (wrangler "
                          f"refuses future compatibility dates), got {value!r}")
    return value


def slug(value: Any, where: str) -> str:
    _require(str, value, where, "a campaign slug")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", value):
        raise ConfigError(f"{where} must be a slug (a-z, 0-9, '-', '_'), got {value!r}")
    return value


def nip05_map(value: Any, where: str) -> dict[str, str]:
    _require(dict, value, where, 'a table of name = "npub1..." or 64-hex public keys')
    names: dict[str, str] = {}
    for name, key in value.items():
        if not _NIP05_NAME.fullmatch(name):
            raise ConfigError(f"{where}: {name!r} is not a NIP-05 name (a-z, 0-9, '.', '_', '-')")
        if not isinstance(key, str):
            raise ConfigError(f"{where}.{name} must be an npub or a 64-hex public key, got {key!r}")
        try:
            names[name] = pubkey_hex(key)
        except ValueError as exc:
            raise ConfigError(f"{where}.{name}: {exc}") from exc
    return names


def token_list(value: Any, where: str) -> list[str]:
    _require(list, value, where, "a list of strings")
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ConfigError(f"{where} must hold non-empty strings, got {item!r}")
    return list(value)


def optional(check: Callable[[Any, str], Any]) -> Callable[[Any, str], Any]:
    """`check`, except that the empty string means "not set"."""
    def checked(value: Any, where: str) -> Any:
        return value if value == "" else check(value, where)
    checked.__name__ = f"optional_{check.__name__}"
    return checked


# ------------------------------------------------------------------------------ bech32
_BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _bech32_polymod(values: list[int]) -> int:
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i, gen in enumerate((0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)):
            chk ^= gen if (top >> i) & 1 else 0
    return chk


def bech32_decode(text: str) -> tuple[str, bytes]:
    """(hrp, data) of a BIP-173 bech32 string; ValueError if it is not one."""
    if text.lower() != text and text.upper() != text:
        raise ValueError("bech32 must not mix upper and lower case")
    text = text.lower()
    hrp, sep, rest = text.rpartition("1")
    if not sep or not hrp or len(rest) < 6 or any(ch not in _BECH32 for ch in rest):
        raise ValueError(f"{text!r} is not bech32")
    values = [_BECH32.index(ch) for ch in rest]
    expanded = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    if _bech32_polymod(expanded + values) != 1:
        raise ValueError(f"{text!r} has a bad bech32 checksum")
    acc, bits, out = 0, 0, bytearray()
    for v in values[:-6]:
        acc = (acc << 5) | v
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    if bits >= 5 or (acc << (8 - bits)) & 0xFF:
        raise ValueError(f"{text!r} has non-zero bech32 padding")
    return hrp, bytes(out)


def pubkey_hex(text: str) -> str:
    """A public key given as npub or 64 lowercase hex, as 64 lowercase hex."""
    if _HEX64.fullmatch(text):
        return text
    if text.lower().startswith("npub1"):
        hrp, data = bech32_decode(text)
        if hrp != "npub" or len(data) != 32:
            raise ValueError(f"{text!r} is not an npub of a 32-byte key")
        return data.hex()
    raise ValueError(f"{text!r} is neither an npub nor 64 lowercase hex characters")


# ============================================================================== schema
@dataclass(frozen=True)
class Field:
    check: Callable[[Any, str], Any]
    # An identifying value names the operator's own environment (a host, a cluster
    # object, a path). When relay.local.toml changes one from the example, --check-clean
    # forbids it in everything Git would publish. Sizes, counts and switches identify
    # nothing and are not checked.
    identifying: bool = False


SCHEMA: dict[str, dict[str, Field]] = {
    "relay": {
        "relay_host": Field(hostname, identifying=True),
        "relay_name": Field(text_line, identifying=True),
        "events_per_minute": Field(positive_int),
        "max_blob_bytes": Field(positive_int),
        "max_uploads_per_signer": Field(positive_int),
    },
    "kubernetes": {
        "namespace": Field(dns_label, identifying=True),
        "storage_size": Field(k8s_quantity),
        "storage_class": Field(optional(dns_subdomain), identifying=True),
        "priority_class": Field(optional(dns_subdomain), identifying=True),
        "cpu_request": Field(k8s_quantity),
        "memory_request": Field(k8s_quantity),
        "memory_limit": Field(k8s_quantity),
        "cert_resolver": Field(plain_name, identifying=True),
        "ingress_priority": Field(positive_int),
        "avoid_control_plane": Field(boolean),
        "traefik_namespace": Field(dns_label, identifying=True),
        "traefik_pod_selector": Field(optional(label_selector), identifying=True),
        "traefik_egress_network_policy": Field(boolean),
        "kubeconfig": Field(optional(path_text), identifying=True),
        "context": Field(optional(path_text), identifying=True),
    },
    "compose": {
        "cpus": Field(compose_cpus),
        "memory_limit": Field(compose_bytes),
    },
    "cloudflare": {
        "worker_name": Field(worker_name, identifying=True),
        "r2_bucket": Field(r2_bucket, identifying=True),
        "compatibility_date": Field(past_date),
    },
    "github_pages": {
        "title": Field(text_line, identifying=True),
        "campaign": Field(slug, identifying=True),
        "domain": Field(optional(hostname), identifying=True),
        "nip05": Field(nip05_map, identifying=True),
    },
    "hygiene": {
        "forbidden_tokens": Field(token_list),
    },
}


@dataclass
class Config:
    path: Path
    values: dict[str, dict[str, Any]] = field(default_factory=dict)

    def __getitem__(self, section: str) -> dict[str, Any]:
        return self.values[section]


def load_config(path: Path) -> Config:
    """Parse and validate one configuration file. Every key of SCHEMA is required, and an
    unknown key is an error: a typo must not silently fall back to a default."""
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError(f"{path} not found. Start from the example: cp relay.toml.example "
                          "relay.local.toml (gitignored), or pass --example") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"{path} is not valid TOML: {exc}") from exc
    sections = {"relay": {k: v for k, v in raw.items() if not isinstance(v, dict)}}
    for name, value in raw.items():
        if isinstance(value, dict):
            if name not in SCHEMA or name == "relay":
                raise ConfigError(f"{path}: unknown section [{name}] (known: "
                                  f"{', '.join('[' + s + ']' for s in SCHEMA if s != 'relay')})")
            sections[name] = value
    cfg = Config(path=path)
    problems: list[str] = []
    for section, fields in SCHEMA.items():
        given = sections.get(section)
        label = "top level" if section == "relay" else f"[{section}]"
        if given is None:
            problems.append(f"missing section [{section}]")
            continue
        for key in given.keys() - fields.keys():
            problems.append(f"unknown key {key!r} at the {label}")
        cfg.values[section] = {}
        for key, spec in fields.items():
            where = key if section == "relay" else f"{section}.{key}"
            if key not in given:
                problems.append(f"missing key {where} (see relay.toml.example)")
                continue
            try:
                cfg.values[section][key] = spec.check(given[key], where)
            except ConfigError as exc:
                problems.append(str(exc))
    if not problems:
        k8s = cfg["kubernetes"]
        if quantity_value(k8s["memory_request"]) > quantity_value(k8s["memory_limit"]):
            problems.append(f"kubernetes.memory_request ({k8s['memory_request']}) is larger than "
                            f"kubernetes.memory_limit ({k8s['memory_limit']}); Kubernetes refuses that")
    if problems:
        raise ConfigError(f"{path} is not a valid relay configuration:\n  - " + "\n  - ".join(problems))
    return cfg


# =========================================================================== rendering
_PLACEHOLDER = re.compile(r"\{\{\s*([a-z0-9_]+)\s*\}\}")


def render(text: str, values: dict[str, str], *, source: str) -> str:
    """Fill `{{ name }}` placeholders. A placeholder ending in `_block` must stand alone on
    its line: it expands to any number of lines at that indentation, or to none."""
    def lookup(name: str) -> str:
        if name not in values:
            raise HydrateError(f"template {source} uses {{{{ {name} }}}}, which hydrate.py does not set")
        return values[name]

    out: list[str] = []
    for line in text.splitlines(keepends=True):
        whole = _PLACEHOLDER.fullmatch(line.strip())
        if whole and whole.group(1).endswith("_block"):
            indent = line[: len(line) - len(line.lstrip())]
            out.extend(f"{indent}{block_line}\n" for block_line in lookup(whole.group(1)).splitlines())
            continue
        for name in _PLACEHOLDER.findall(line):
            if name.endswith("_block"):
                raise HydrateError(f"template {source}: {{{{ {name} }}}} must stand alone on its line")
        out.append(_PLACEHOLDER.sub(lambda m: lookup(m.group(1)), line))
    return "".join(out)


def _flow_labels(selector: str) -> str:
    pairs = (pair.partition("=") for pair in selector.split(","))
    return ", ".join(f"{json.dumps(k)}: {json.dumps(v)}" for k, _, v in pairs)


def common_values(cfg: Config) -> dict[str, str]:
    relay = cfg["relay"]
    return {
        "ncli_image": NCLI_IMAGE,
        "relay_host": relay["relay_host"],
        "relay_name_yaml": json.dumps(relay["relay_name"]),
        "events_per_minute": str(relay["events_per_minute"]),
        "max_blob_bytes": str(relay["max_blob_bytes"]),
        "max_uploads_per_signer": str(relay["max_uploads_per_signer"]),
    }


AVOID_CONTROL_PLANE = """\
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        preference:
          matchExpressions:
            - key: node-role.kubernetes.io/control-plane
              operator: DoesNotExist
"""


def kubernetes_files(cfg: Config) -> dict[str, str]:
    k8s = cfg["kubernetes"]
    selector = k8s["traefik_pod_selector"]
    resources = ["namespace.yaml", "statefulset.yaml", "service.yaml", "ingressroute.yaml",
                 "networkpolicy.yaml"]
    if k8s["traefik_egress_network_policy"]:
        resources.append("traefik-networkpolicy.yaml")
    values = {
        **common_values(cfg),
        "namespace": k8s["namespace"],
        "statefulset_name": STATEFULSET_NAME,
        "app_label": APP_LABEL,
        "signing_secret": SIGNING_SECRET,
        "configmap_name": CONFIGMAP_NAME,
        "storage_size": k8s["storage_size"],
        "cpu_request": k8s["cpu_request"],
        "memory_request": k8s["memory_request"],
        "memory_limit": k8s["memory_limit"],
        "cert_resolver": k8s["cert_resolver"],
        "ingress_priority": str(k8s["ingress_priority"]),
        "traefik_namespace": k8s["traefik_namespace"],
        "priority_class_block": f"priorityClassName: {k8s['priority_class']}" if k8s["priority_class"] else "",
        "storage_class_block": f"storageClassName: {k8s['storage_class']}" if k8s["storage_class"] else "",
        "affinity_block": AVOID_CONTROL_PLANE if k8s["avoid_control_plane"] else "",
        "traefik_from_pod_selector_block":
            f"podSelector: {{ matchLabels: {{ {_flow_labels(selector)} }} }}" if selector else "",
        "traefik_pod_selector_flow": f"{{ matchLabels: {{ {_flow_labels(selector)} }} }}" if selector else "{}",
        "resources_block": "\n".join(f"- {name}" for name in resources),
    }
    names = [*resources, "kustomization.yaml"]
    files = {name: render(_template("kubernetes", name), values, source=f"kubernetes/{name}")
             for name in names}
    files["relay.yaml"] = render(_template("shared", "relay.yaml"), values, source="shared/relay.yaml")
    return files


def compose_files(cfg: Config) -> dict[str, str]:
    values = {**common_values(cfg), "compose_cpus": cfg["compose"]["cpus"],
              "compose_memory_limit": cfg["compose"]["memory_limit"]}
    return {
        "compose.yaml": render(_template("compose", "compose.yaml"), values, source="compose/compose.yaml"),
        "Caddyfile": render(_template("compose", "Caddyfile"), values, source="compose/Caddyfile"),
        ".env.example": render(_template("compose", "env.example"), values, source="compose/env.example"),
        "relay.yaml": render(_template("shared", "relay.yaml"), values, source="shared/relay.yaml"),
    }


def cloudflare_files(cfg: Config) -> dict[str, str]:
    cf = cfg["cloudflare"]
    values = {**common_values(cfg), "worker_name": cf["worker_name"], "r2_bucket": cf["r2_bucket"],
              "compatibility_date": cf["compatibility_date"],
              "relay_name_toml": json.dumps(cfg["relay"]["relay_name"])}
    files = {"wrangler.toml": render(_template("cloudflare", "wrangler.toml"), values,
                                     source="cloudflare/wrangler.toml")}
    for source in sorted((TEMPLATES / "cloudflare" / "src").glob("*.ts")):
        files[f"src/{source.name}"] = source.read_text(encoding="utf-8")   # copied verbatim
    return files


def github_pages_files(cfg: Config) -> dict[str, str]:
    pages, host = cfg["github_pages"], cfg["relay"]["relay_host"]
    names = pages["nip05"]
    nostr_json = {"names": names, "relays": {key: [f"wss://{host}"] for key in sorted(set(names.values()))}}
    if names:
        rows = "\n".join(f"      <tr><td><code>{html.escape(name)}</code></td><td><code>{key}</code></td></tr>"
                         for name, key in sorted(names.items()))
        section = f"""\
<section aria-labelledby="directory-title">
  <h2 id="directory-title">NIP-05 directory</h2>
  <p>Names published in <code>/.well-known/nostr.json</code> on this site.</p>
  <table>
    <thead><tr><th>Name</th><th>Public key (hex)</th></tr></thead>
    <tbody>
{rows}
    </tbody>
  </table>
</section>"""
    else:
        section = ""
    values = {
        "relay_host": host,
        "relay_host_js": json.dumps(host),
        "title_html": html.escape(pages["title"]),
        "campaign": pages["campaign"],
        "nip05_section_block": section,
    }
    page = render(_template("github-pages", "index.html"), values, source="github-pages/index.html")
    files = {
        "index.html": page,
        # The same page at /join/ (GitHub Pages sends /join there), so an invite link with
        # this site's host, /join/#nm1_… as well as /#nm1_…, opens it with the token read.
        "join/index.html": page,
        ".well-known/nostr.json": json.dumps(nostr_json, indent=2, sort_keys=True) + "\n",
        # GitHub Pages runs Jekyll by default, and Jekyll drops dot-directories such as
        # .well-known/. This empty file turns Jekyll off.
        ".nojekyll": "",
    }
    if pages["domain"]:
        files["CNAME"] = pages["domain"] + "\n"
    return files


RENDERERS: dict[str, Callable[[Config], dict[str, str]]] = {
    "kubernetes": kubernetes_files,
    "compose": compose_files,
    "cloudflare": cloudflare_files,
    "github-pages": github_pages_files,
}


def _template(target: str, name: str) -> str:
    return (TEMPLATES / target / name).read_text(encoding="utf-8")


def write_target(target: str, files: dict[str, str], build_dir: Path = BUILD_DIR) -> Path:
    """Write one target's files. Only files an earlier hydration wrote (listed in its
    manifest) are ever removed, so an operator's own .env, data/ or .wrangler/ next to
    them survives a re-hydration."""
    out = build_dir / target
    out.mkdir(parents=True, exist_ok=True)
    manifest = out / MANIFEST
    previous = set(manifest.read_text(encoding="utf-8").split("\n")) - {""} if manifest.exists() else set()
    for name, content in files.items():
        path = out / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    for stale in sorted(previous - files.keys()):
        (out / stale).unlink(missing_ok=True)
    manifest.write_text("".join(f"{name}\n" for name in sorted(files)), encoding="utf-8")
    return out


NEXT_STEPS = {
    "kubernetes": "python3 scripts/hydrate.py --config {config}{profile_arg} --target kubernetes --apply",
    "compose": "copy {out}/ to the host and follow the steps at the top of compose.yaml",
    "cloudflare": "cd {out} and follow the steps at the top of wrangler.toml",
    "github-pages": "publish {out}/ as the site root of a GitHub Pages branch",
}


def hydrate(cfg: Config, targets: list[str], profile: str | None = None) -> list[Path]:
    build_dir = BUILD_DIR / profile if profile else BUILD_DIR
    written = []
    for target in targets:
        files = RENDERERS[target](cfg)
        out = write_target(target, files, build_dir)
        written.append(out)
        print(f"hydrated {out.relative_to(REPO_ROOT)}/ ({len(files)} files) from {_shown(cfg.path)}")
        next_step = NEXT_STEPS[target].format(out=_shown(out), config=shlex.quote(_shown(cfg.path)),
                                              profile_arg=f" --profile {profile}" if profile else "")
        print(f"  next: {next_step}")
    return written


def _shown(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


# ======================================================================== check-clean
@dataclass
class Finding:
    what: str              # the forbidden token, or the name of a secret pattern
    origin: str            # where the token comes from
    locations: list[str] = field(default_factory=list)


_SECRET_PATTERNS: dict[str, re.Pattern[bytes]] = {
    "a bech32 nsec secret key": re.compile(rb"nsec1[02-9ac-hj-np-z]{58}"),
    "a PEM private key block": re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "a relay signing key value": re.compile(rb"RELAY_SIGNING_KEY\s*[=:]\s*[\"']?[0-9a-fA-F]{64}"),
    "an ADMIN_TOKEN value": re.compile(rb"ADMIN_TOKEN\s*[=:]\s*[\"']?[0-9a-fA-F]{64}"),
}
SECRET_KINDS = [*_SECRET_PATTERNS, "a kubeconfig client key", "an nm1_ invite token"]
_KUBE_CLIENT_KEY = re.compile(rb"client-key-data:\s*([A-Za-z0-9+/=]+)")
_INVITE_TOKEN = re.compile(rb"nm1_([A-Za-z0-9_-]+)")


def _secret_hits(data: bytes) -> list[tuple[str, int]]:
    """(pattern name, byte offset) of each secret-shaped value in `data`."""
    hits = [(name, m.start()) for name, pattern in _SECRET_PATTERNS.items() for m in pattern.finditer(data)]
    for m in _KUBE_CLIENT_KEY.finditer(data):
        try:
            decoded = base64.b64decode(m.group(1), validate=True)
        except binascii.Error:
            continue                        # not base64, so not key material
        if decoded.startswith(b"-----BEGIN"):
            hits.append(("a kubeconfig client key", m.start()))
    for m in _INVITE_TOKEN.finditer(data):
        body = m.group(1)
        try:
            decoded = json.loads(base64.urlsafe_b64decode(body + b"=" * (-len(body) % 4)))
        except (binascii.Error, ValueError):
            continue                        # prose such as nm1_<token>, not a token
        if isinstance(decoded, dict) and "code" in decoded:
            hits.append(("an nm1_ invite token (it carries a bearer code)", m.start()))
    return hits


def private_tokens(local: Config, example: Config) -> tuple[dict[str, str], list[str]]:
    """Tokens that must not be published, each with where it came from, and notes on
    values deliberately not checked."""
    tokens: dict[str, str] = {}
    notes: list[str] = []
    example_text = example.path.read_text(encoding="utf-8").casefold()

    def strings(value: Any) -> set[str]:
        if isinstance(value, str):
            return {value} if value else set()
        if isinstance(value, dict):
            return {s for k, v in value.items() for s in (strings(k) | strings(v))}
        if isinstance(value, list):
            return {s for v in value for s in strings(v)}
        return set()

    for section, fields in SCHEMA.items():
        for key, spec in fields.items():
            if not spec.identifying:
                continue
            origin = key if section == "relay" else f"{section}.{key}"
            derived = set(strings(local[section][key])) - strings(example[section][key])
            if key == "relay_host":
                host = local[section][key]
                parent = host.split(".", 1)[1]
                if "." in parent and parent not in strings(example[section][key]):
                    derived.add(parent)
            for value in sorted(derived):
                folded = value.casefold()
                if folded in example_text:
                    notes.append(f"{origin} value {value!r} is not checked: relay.toml.example "
                                 "already contains it, so it is public vocabulary")
                    continue
                tokens.setdefault(folded, f"{origin} in {_shown(local.path)}")
    for token in local["hygiene"]["forbidden_tokens"]:
        tokens.setdefault(token.casefold(), f"hygiene.forbidden_tokens in {_shown(local.path)}")
    return tokens, notes


def _git(*args: str, data: bytes | None = None) -> bytes:
    argv = ["git", "-C", str(REPO_ROOT), *args]
    try:
        done = subprocess.run(argv, input=data, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise HydrateError("git is not installed or not on PATH; --check-clean needs it") from exc
    if done.returncode != 0:
        raise HydrateError(f"`{shlex.join(argv)}` exited {done.returncode}: "
                           f"{done.stderr.decode(errors='replace').strip()}")
    return done.stdout


def _ignored(rel: str) -> bool:
    argv = ["git", "-C", str(REPO_ROOT), "check-ignore", "-q", "--no-index", "--", rel]
    code = subprocess.run(argv, capture_output=True, check=False).returncode
    if code not in (0, 1):                  # 0: ignored, 1: not ignored, anything else: broken
        raise HydrateError(f"`{shlex.join(argv)}` exited {code}: is {REPO_ROOT} a Git repository?")
    return code == 0


def _cat_blobs(shas: list[str]) -> dict[str, bytes]:
    """Contents of the given blob ids, read in one `git cat-file --batch`."""
    if not shas:
        return {}
    raw = _git("cat-file", "--batch", data="".join(f"{s}\n" for s in shas).encode())
    blobs, at = {}, 0
    for sha in shas:
        end = raw.index(b"\n", at)
        header = raw[at:end].split()
        if len(header) < 3 or header[1] != b"blob":
            raise HydrateError(f"git cat-file did not return blob {sha}: {raw[at:end]!r}")
        size = int(header[2])
        blobs[sha] = raw[end + 1:end + 1 + size]
        at = end + 1 + size + 1
    return blobs


def _publishable() -> Iterator[tuple[str, bytes]]:
    """(location, bytes) of everything Git would publish: the working tree (tracked files
    and files not ignored), the index, every reachable commit message and blob, and the
    paths themselves."""
    paths = sorted(set(_git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
                       .decode().split("\0")) - {""})
    worktree: dict[str, bytes] = {}
    for rel in paths:
        yield f"path name {rel}", rel.encode()
        path = REPO_ROOT / rel
        if path.is_symlink():
            worktree[rel] = str(path.readlink()).encode()
        elif path.is_file():
            worktree[rel] = path.read_bytes()
        else:
            continue                        # deleted in the working tree: the index has it
        yield rel, worktree[rel]
    staged: dict[str, str] = {}
    for entry in _git("ls-files", "-z", "--stage").decode().split("\0"):
        if entry:
            meta, rel = entry.split("\t", 1)
            if meta.split()[0] != "160000":                   # not a submodule commit
                staged[meta.split()[1]] = rel
    for sha, data in _cat_blobs(list(staged)).items():
        if worktree.get(staged[sha]) != data:   # a staged version the working tree no longer shows
            yield f"index (staged) {staged[sha]}", data
    if not _git("rev-parse", "--all").strip():
        return                                                # no commits yet
    log = _git("log", "--all", "--format=%H%x00%B%x00").decode(errors="replace").split("\0")
    for sha, message in zip(log[0::2], log[1::2]):
        yield f"commit message {sha.strip()[:12]}", message.encode()
    history: dict[str, str] = {}
    for line in _git("rev-list", "--all", "--objects").decode(errors="replace").splitlines():
        sha, _, rel = line.partition(" ")
        if rel:
            history.setdefault(sha, rel)
    kinds = _git("cat-file", "--batch-check", data="".join(f"{s}\n" for s in history).encode())
    blob_shas = [line.split()[0] for line in kinds.decode().splitlines() if line.split()[1] == "blob"]
    for rel in sorted(set(history.values())):
        yield f"history path name {rel}", rel.encode()
    for sha, data in _cat_blobs(blob_shas).items():
        yield f"history {history[sha]} (blob {sha[:12]})", data


def _line_of(data: bytes, offset: int) -> int:
    return data.count(b"\n", 0, offset) + 1


def check_clean(cfg_path: Path | None, extra_tokens: list[str]) -> int:
    """0 when nothing private would be published, 1 when something would."""
    problems: list[str] = []
    # Include ignored operator files. Avoid walking relay data volumes and installed
    # dependencies, which can be much larger than the configuration tree.
    config_names = _git("ls-files", "-z", "--cached", "--others", "--exclude=.build/",
                        "--exclude=.venv/", "--exclude=node_modules/", "--", "*.local.toml")
    local_names = set(config_names.decode().split("\0")) - {""}
    local_paths = {REPO_ROOT / rel for rel in local_names if (REPO_ROOT / rel).is_file()}
    probes = {"relay.local.toml", "relay.profile.local.toml", ".build/kubernetes/statefulset.yaml",
              ".build/profile/kubernetes/statefulset.yaml", ".env"}
    probes.update(local_names)
    for probe in sorted(probes):
        if not _ignored(probe):
            problems.append(f"{probe} is not gitignored: restore the rules in .gitignore")
    tracked_private = _git("ls-files", "-z", "--", "*.local.toml", ".build", ".env").decode().split("\0")[:-1]
    problems.extend(f"{rel} is tracked by Git: `git rm --cached {rel}`" for rel in tracked_private)

    example = load_config(EXAMPLE_CONFIG)
    if cfg_path is not None:
        local_paths.add(cfg_path.absolute())
    if not local_paths:
        print("check-clean: no relay.local.toml or other *.local.toml; checking secret patterns and --forbid")
    tokens = {token.casefold(): "--forbid" for token in extra_tokens}
    for path in sorted(local_paths):
        derived, notes = private_tokens(load_config(path), example)
        tokens.update(derived)
        for note in notes:
            print(f"check-clean: note: {note}")

    findings: dict[str, Finding] = {}
    for location, data in _publishable():
        text = data.decode("utf-8", errors="replace").casefold()
        for token, origin in tokens.items():
            at = text.find(token)
            if at >= 0:
                line = text.count("\n", 0, at) + 1
                findings.setdefault(token, Finding(token, origin)).locations.append(f"{location}:{line}")
        for name, offset in _secret_hits(data):
            findings.setdefault(name, Finding(name, "secret pattern")).locations.append(
                f"{location}:{_line_of(data, offset)}")

    scanned = f"{len(tokens)} private token(s) and {len(SECRET_KINDS)} kinds of secret"
    if not problems and not findings:
        print(f"check-clean: OK: {scanned}, none found in the working tree, the index or history")
        return 0
    print("check-clean: FAIL", file=sys.stderr)
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    for finding in findings.values():
        print(f"  {finding.what!r} ({finding.origin}) found in:", file=sys.stderr)
        for location in finding.locations:
            print(f"      {location}", file=sys.stderr)
        if any(loc.startswith(("history", "commit message")) for loc in finding.locations):
            print("      It is in committed history: only rewriting that history removes it.",
                  file=sys.stderr)
    return 1


# ========================================================================== kubernetes
def kubectl_base(cfg: Config) -> list[str]:
    k8s = cfg["kubernetes"]
    argv = ["kubectl"]
    if k8s["kubeconfig"]:
        path = Path(k8s["kubeconfig"]).expanduser()
        if not path.is_file():
            raise ConfigError(f"kubernetes.kubeconfig points at {path}, which is not a file")
        argv += ["--kubeconfig", str(path)]
    if k8s["context"]:
        argv += ["--context", k8s["context"]]
    return argv


def run_kubectl(argv: list[str], *, stdin: str | None = None) -> str:
    print(f"+ {shlex.join(argv)}", file=sys.stderr)
    try:
        done = subprocess.run(argv, input=stdin, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise ApplyError(f"{argv[0]} is not installed or not on PATH") from exc
    if done.returncode != 0:
        raise ApplyError(f"`{shlex.join(argv)}` exited {done.returncode}:\n{done.stderr.strip()}")
    return done.stdout


_IMMUTABLE_HINT = (
    "\nThe live StatefulSet differs in a field Kubernetes never updates in place "
    "(serviceName, selector, podManagementPolicy or volumeClaimTemplates). For a "
    "zero-downtime apply, set kubernetes.storage_size and kubernetes.storage_class in "
    "{config} to the live values: kubectl -n {ns} get statefulset {name} "
    "-o jsonpath='{{.spec.volumeClaimTemplates}}'")


def apply_kubernetes(cfg: Config, build: Path) -> None:
    k = kubectl_base(cfg)
    ns = cfg["kubernetes"]["namespace"]
    run_kubectl([*k, "apply", "-f", str(build / "namespace.yaml")])
    existing = run_kubectl([*k, "-n", ns, "get", "secret", SIGNING_SECRET, "--ignore-not-found", "-o", "name"])
    if existing.strip():
        print(f"secret/{SIGNING_SECRET} already exists in {ns}: left untouched")
    else:
        # 32 random bytes as hex, handed to kubectl on stdin: never in argv, a file or output.
        run_kubectl([*k, "-n", ns, "create", "secret", "generic", SIGNING_SECRET,
                     "--from-file=RELAY_SIGNING_KEY=/dev/stdin"], stdin=secrets.token_hex(32))
        print(f"secret/{SIGNING_SECRET} created in {ns} with a fresh signing key")
    try:
        run_kubectl([*k, "apply", "-k", str(build), "--dry-run=server"])
    except ApplyError as exc:
        if "updates to statefulset spec" in str(exc):
            raise ApplyError(str(exc) + _IMMUTABLE_HINT.format(config=_shown(cfg.path), ns=ns,
                                                               name=STATEFULSET_NAME)) from exc
        raise
    print(run_kubectl([*k, "apply", "-k", str(build)]).rstrip())
    print(f"applied. updateStrategy is OnDelete: a changed template reaches the pod only when "
          f"{STATEFULSET_NAME}-0 is deleted. `--verify` shows whether a rollout is pending.")


def verify_rollout(cfg: Config) -> None:
    k = kubectl_base(cfg)
    ns = cfg["kubernetes"]["namespace"]
    sts = json.loads(run_kubectl([*k, "-n", ns, "get", "statefulset", STATEFULSET_NAME, "-o", "json"]))
    status = sts.get("status", {})
    if status.get("readyReplicas", 0) < 1:
        raise VerifyError(f"statefulset/{STATEFULSET_NAME} in {ns} has no ready replica: "
                          f"kubectl -n {ns} describe pod {STATEFULSET_NAME}-0")
    pod = json.loads(run_kubectl([*k, "-n", ns, "get", "pod", f"{STATEFULSET_NAME}-0", "-o", "json"]))
    running = pod.get("metadata", {}).get("labels", {}).get("controller-revision-hash")
    wanted = status.get("updateRevision")
    if running == wanted:
        print(f"rollout: {STATEFULSET_NAME}-0 runs the applied revision {wanted}")
    else:
        print(f"rollout PENDING: {STATEFULSET_NAME}-0 runs revision {running}, the applied one is "
              f"{wanted}. When a restart suits the members (it drops every socket once): "
              f"kubectl -n {ns} delete pod {STATEFULSET_NAME}-0")


def verify_nip11(cfg: Config, url: str | None = None) -> dict[str, Any]:
    """Fetch the relay's NIP-11 document, bypassing any HTTP(S)_PROXY in the environment,
    and require the two gates and the configured name."""
    url = url or f"https://{cfg['relay']['relay_host']}/"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, headers={"Accept": "application/nostr+json"})
    try:
        with opener.open(request) as response:
            body = response.read()
            cors = response.headers.get("Access-Control-Allow-Origin")
    except urllib.error.HTTPError as exc:
        raise VerifyError(f"{url} answered the NIP-11 request with HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise VerifyError(f"cannot reach {url}: {exc.reason}") from exc
    try:
        document = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise VerifyError(f"the NIP-11 answer of {url} is not JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise VerifyError(f"the NIP-11 answer of {url} is not a JSON object")
    limits = document.get("limitation") if isinstance(document.get("limitation"), dict) else {}
    failures = []
    for gate in ("auth_required", "membership_required"):
        if limits.get(gate) is not True:
            failures.append(f"limitation.{gate} is {limits.get(gate)!r}, not true")
    if document.get("name") != cfg["relay"]["relay_name"]:
        failures.append(f"name is {document.get('name')!r}, relay_name is {cfg['relay']['relay_name']!r}")
    if failures:
        raise VerifyError(f"{url} does not answer as configured:\n  - " + "\n  - ".join(failures))
    summary = {"url": url, "name": document["name"], "auth_required": True, "membership_required": True,
               "supported_nips": document.get("supported_nips"), "software": document.get("software"),
               "version": document.get("version"), "access_control_allow_origin": cors}
    print(f"verify: OK {json.dumps(summary)}")
    if cors is None:
        print("verify: note: no Access-Control-Allow-Origin header; the GitHub Pages status page "
              "cannot read this document from a browser")
    return summary


# ================================================================================ main
def profile_name(value: str) -> str:
    if not _DNS_LABEL.fullmatch(value) or value in TARGETS:
        raise argparse.ArgumentTypeError("use a lowercase DNS label distinct from the target names")
    return value


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hydrate.py", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    source = p.add_mutually_exclusive_group()
    source.add_argument("--config", type=Path, help="configuration file (default: relay.local.toml)")
    source.add_argument("--example", action="store_true", help="use relay.toml.example")
    p.add_argument("--profile", type=profile_name, help="write targets under .build/<profile>/")
    p.add_argument("--target", choices=[*TARGETS, "all"], help="render the selected deployment target(s)")
    p.add_argument("--check-clean", action="store_true",
                   help="fail if anything Git would publish holds a private value or a secret")
    p.add_argument("--forbid", action="append", default=[], metavar="TOKEN",
                   help="one more forbidden token for --check-clean (repeatable)")
    p.add_argument("--apply", action="store_true", help="apply the rendered manifests (needs --target kubernetes)")
    p.add_argument("--verify", action="store_true",
                   help="check the NIP-11 document at https://<relay_host>/ (and, with --target "
                        "kubernetes, the StatefulSet rollout)")
    p.add_argument("--verify-url", metavar="URL",
                   help="NIP-11 URL to check instead of https://<relay_host>/ (e.g. a port-forward)")
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not (args.target or args.check_clean or args.verify):
        parser.error("nothing to do: give --target, --check-clean or --verify")
    if args.apply and args.target != "kubernetes":
        parser.error("--apply needs --target kubernetes")
    if args.verify_url and not args.verify:
        parser.error("--verify-url needs --verify")
    config_path = EXAMPLE_CONFIG if args.example else args.config
    try:
        status = 0
        if args.target or args.verify:
            cfg = load_config(config_path or LOCAL_CONFIG)
            if args.target:
                targets = list(TARGETS) if args.target == "all" else [args.target]
                written = hydrate(cfg, targets, args.profile)
                if args.apply:
                    apply_kubernetes(cfg, written[0])
            if args.verify:
                if args.target == "kubernetes" and not args.verify_url:
                    verify_rollout(cfg)
                verify_nip11(cfg, args.verify_url)
        if args.check_clean:
            status = check_clean(config_path, args.forbid)
        return status
    except VerifyError as exc:                  # the relay answered, and not as configured
        print(f"hydrate.py: verify FAILED: {exc}", file=sys.stderr)
        return 1
    except HydrateError as exc:                 # configuration, usage or tooling
        print(f"hydrate.py: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
