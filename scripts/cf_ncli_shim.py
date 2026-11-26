#!/usr/bin/env python3
"""`ncli relay ...` for the Cloudflare Worker target, so nostr-mailbox manages members there too.

nostr-mailbox reaches a relay's admin CLI through a command prefix (`--exec PREFIX`) and
appends `ncli relay <verb> ... --config /app/ncli/relay.yaml`. This script is such a
prefix: it takes that exact argv and turns it into calls to the Worker's /_admin/ API,
authenticated with the ADMIN_TOKEN secret given to `wrangler secret put ADMIN_TOKEN`.

    export ADMIN_TOKEN=...                     # or --token-file PATH
    SHIM="python3 scripts/cf_ncli_shim.py --url https://relay.example.com"
    nostr-mailbox setup --relay wss://relay.example.com --campaign my-campaign --exec "$SHIM"
    nostr-mailbox invite --exec "$SHIM"
    nostr-mailbox relay add <npub> --exec "$SHIM"
    nostr-mailbox relay revoke <npub> --exec "$SHIM"

Verbs, as ncli spells them:
    ncli relay invites create [--ttl 168h] [--max-uses 1] [--json]
    ncli relay invites list [--json]
    ncli relay invites revoke <code>
    ncli relay members add <npub|hex>
    ncli relay members remove <npub|hex>
    ncli relay members list [--json]

`--config` is accepted wherever ncli takes it and has no effect: the Worker reads its
settings from wrangler.toml, not from a relay.yaml. Environment HTTP proxies are not used.
Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hydrate import pubkey_hex  # the one bech32 decoder of this repository

# membership.inviteTTL and inviteMaxUses of templates/shared/relay.yaml: the defaults an
# ncli relay applies to an invite created without them.
DEFAULT_TTL = "168h"
DEFAULT_MAX_USES = 1
_DURATION = re.compile(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?")


class ShimError(Exception):
    """The admin call could not be made, or the Worker refused it."""


def duration_seconds(text: str) -> int:
    """A Go-style duration of hours, minutes and seconds ("168h", "1h30m") in seconds."""
    m = _DURATION.fullmatch(text)
    if not text or m is None:
        raise ShimError(f"--ttl {text!r} is not a duration such as 168h, 90m or 1h30m")
    hours, minutes, seconds = (int(g) if g else 0 for g in m.groups())
    total = hours * 3600 + minutes * 60 + seconds
    if total <= 0:
        raise ShimError(f"--ttl {text!r} must be longer than zero")
    return total


class Admin:
    def __init__(self, url: str, token: str):
        self.base = url.rstrip("/") + "/_admin/"
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        url = self.base + path
        request = urllib.request.Request(
            url, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json",
                     "Content-Type": "application/json"})
        try:
            with self.opener.open(request) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace").strip()
            if exc.code == 404 and not detail:
                raise ShimError(
                    f"{method} {url} answered 404 with no body: the Worker hides /_admin/ unless "
                    "the bearer token equals its ADMIN_TOKEN secret. Check ADMIN_TOKEN here and "
                    "`wrangler secret list` there, and that --url is the Worker's host") from exc
            raise ShimError(f"{method} {url} answered {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise ShimError(f"cannot reach {url}: {exc.reason}") from exc


def build_ncli_parser() -> argparse.ArgumentParser:
    ncli = argparse.ArgumentParser(prog="ncli", add_help=True)
    verbs = ncli.add_subparsers(dest="group", required=True)
    relay = verbs.add_parser("relay").add_subparsers(dest="noun", required=True)
    invites = relay.add_parser("invites").add_subparsers(dest="verb", required=True)
    members = relay.add_parser("members").add_subparsers(dest="verb", required=True)

    def leaf(parent, name: str):
        p = parent.add_parser(name)
        p.add_argument("--config", help="accepted for ncli compatibility; the Worker has no relay.yaml")
        return p

    create = leaf(invites, "create")
    create.add_argument("--ttl", default=DEFAULT_TTL)
    create.add_argument("--max-uses", type=int, default=DEFAULT_MAX_USES)
    create.add_argument("--json", action="store_true")
    leaf(invites, "list").add_argument("--json", action="store_true")
    leaf(invites, "revoke").add_argument("code")
    leaf(members, "add").add_argument("pubkey")
    leaf(members, "remove").add_argument("pubkey")
    leaf(members, "list").add_argument("--json", action="store_true")
    return ncli


def run(argv: list[str]) -> int:
    shim = argparse.ArgumentParser(prog="cf_ncli_shim.py", description=__doc__.split("\n\n")[0])
    shim.add_argument("--url", default=os.environ.get("NOSTR_RELAY_ADMIN_URL"),
                      help="the Worker's origin, https://<relay_host> (or NOSTR_RELAY_ADMIN_URL)")
    shim.add_argument("--token-file", type=Path, help="read ADMIN_TOKEN from this file")
    split = next((i for i, a in enumerate(argv) if a in ("ncli", "relay")), len(argv))
    opts = shim.parse_args(argv[:split])
    rest = argv[split:]
    if rest[:1] == ["ncli"]:
        rest = rest[1:]
    args = build_ncli_parser().parse_args(rest)
    if not opts.url:
        shim.error("give --url https://<relay_host> or set NOSTR_RELAY_ADMIN_URL")
    if opts.token_file is not None:
        token = opts.token_file.read_text(encoding="utf-8").strip()
    else:
        token = os.environ.get("ADMIN_TOKEN", "")
    if not token:
        shim.error("set ADMIN_TOKEN (the Worker's `wrangler secret put ADMIN_TOKEN` value) or "
                   "give --token-file")
    admin = Admin(opts.url, token)

    if args.noun == "invites" and args.verb == "create":
        if args.max_uses <= 0:
            raise ShimError(f"--max-uses must be positive, got {args.max_uses}")
        invite = admin.call("POST", "invites", {"ttl_seconds": duration_seconds(args.ttl),
                                                "max_uses": args.max_uses})
        print(json.dumps(invite) if args.json else invite["code"])
    elif args.noun == "invites" and args.verb == "list":
        listed = admin.call("GET", "invites")
        print(json.dumps(listed) if args.json else "\n".join(
            f"{i['code']} uses={i['uses']}/{i['max_uses']} expires_at={i['expires_at']}"
            for i in listed["invites"]))
    elif args.noun == "invites" and args.verb == "revoke":
        print(f"revoked {admin.call('DELETE', 'invites/' + args.code)['revoked']}")
    elif args.noun == "members" and args.verb in ("add", "remove"):
        try:
            key = pubkey_hex(args.pubkey)
        except ValueError as exc:
            raise ShimError(str(exc)) from exc
        if args.verb == "add":
            said = admin.call("PUT", f"members/{key}")
            print(f"{'already a member' if said['already_member'] else 'added'} {key}")
        else:
            said = admin.call("DELETE", f"members/{key}")
            print(f"{'removed' if said['was_member'] else 'was not a member'} {key}")
    else:
        listed = admin.call("GET", "members")
        print(json.dumps(listed) if args.json else "\n".join(m["pubkey"] for m in listed["members"]))
    return 0


def main() -> int:
    try:
        return run(sys.argv[1:])
    except ShimError as exc:
        print(f"cf_ncli_shim: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
