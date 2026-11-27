# nostr-relay-deploy

Deploy and operate the private, invite-gated Nostr + Blossom relay that
[nostr-mailbox](https://github.com/awowIO/nostr-mailbox) talks to, on four targets, from one
configuration file that never enters Git. Python 3.12+, standard library only.

| Target | What `.build/<target>/` holds | Admin path for nostr-mailbox |
|---|---|---|
| `kubernetes` | Hardened single-replica `StatefulSet` (pinned `ncli` image, UID/GID 65532, read-only root, no capabilities, `OnDelete`), `Service`, Traefik `IngressRoute`, `NetworkPolicy`, optional Traefik egress policy, `kustomization.yaml` + `relay.yaml` | `--kubectl` |
| `compose` | `compose.yaml` + `Caddyfile` (automatic TLS) + `relay.yaml` + `.env.example` for one VPS | `--compose compose.yaml` |
| `cloudflare` | A self-contained Worker + SQLite Durable Object + R2 relay in TypeScript (`wrangler.toml`, `src/`) | `--exec "python3 scripts/cf_ncli_shim.py --url https://<host>"` |
| `github-pages` | Static `.well-known/nostr.json` (NIP-05) and a full-width onboarding page with live NIP-11 status | none |

Every relay target exposes the same routes and answers 404 to everything else. The
Caddyfile, the IngressRoute and the Worker's edge filter are held to one table by the tests.
`GET` and `HEAD /` are one route on every edge: the relay behind it tells the three callers
apart.

| Route | Purpose |
|---|---|
| `GET /` + `Upgrade: websocket` | Nostr wire (NIP-42 AUTH first) |
| `GET`/`HEAD /` + `Accept: application/nostr+json` | NIP-11 document |
| `GET`/`HEAD /`, any other `Accept` | a page for a browser: ncli's homepage, or the Worker's Visual Web Console |
| `PUT /upload`, `PUT /media/upload` | Blossom upload, signed, members only |
| `GET`/`HEAD /<sha256>[.ext]`, `/media/<sha256>[.ext]` | Blossom download, signed, members only |

An `Accept` list that names `application/nostr+json` among other types gets 400 from both
relays.

## Self-service

`templates/shared/relay.yaml` lets members do three things without the operator, on every
target. The pinned ncli release's `ncli relay --check` accepts the file with no warnings,
and the tests run the same scenarios against a live ncli relay and the Worker.

- **Invites.** `membership.memberClaims: true`: an enrolled member sends
  `["REQ", <id>, {"kinds": [28935], "limit": 1}]` and gets one ephemeral kind 28935, signed
  by the relay's own key, carrying `["claim", <code>]`, then `EOSE`, then the one-shot
  subscription closes. The code admits one key, once, and expires after seven days
  (`inviteMaxUses`, `inviteTTL`). No relay counts codes per member, and removing a member
  does not revoke the codes they minted: `ncli relay invites list` and `revoke` (or the
  shim's) do. On the Worker each code costs a token of the key's event rate limit.
- **Groups (NIP-29).** `groups.create: [members]`: a member creates a group with kind
  9007 and is its admin. A new group is private and closed (the Worker marks it
  restricted too): only members read what carries its `h` tag, or its state (kinds
  39000-39003, signed by the relay), and only members post into it. A REQ naming a group
  the reader may not see is closed with `restricted: valid membership in group <id> is
  required`. A group that does not exist gets the same answer. `pendingJoins: true`: a join
  request (9021) waits until an admin answers with put-user (9000) or remove-user (9001),
  and admins read the queue with `{"kinds": [9021], "#h": [<id>]}`. `moderationLog: true`:
  members read the moderation the group accepted.
- **Recipient-only kinds.** `recipientOnlyKinds: [1059, 4410, 4411]`: NIP-59 gift wraps and
  agent-mailbox's pairwise envelopes and receipts reach only a socket authenticated as a
  key in their `p` tags, over REQ and live subscriptions. Their author does not get them
  back either.

What the tests found the relays doing, which clients should know:

- On a members-only relay an event's author must be enrolled, so a gift wrap signed by a
  one-time key, as NIP-59 has it, is refused on both relays whoever sends it. Envelopes
  signed by a member's own key (agent-mailbox's 4410 and 4411) pass.
- ncli applies a REQ's `limit` before it drops events the reader may not see. A
  recipient-only event that is newer than everything else a reader may see can therefore
  empty a `limit: 1` answer on ncli. The Worker counts only what it sends.
- ncli's homepage loads its scripts and styles from `/_home/assets/`, which the edges do
  not route. On the Kubernetes and Compose targets a browser at `/` gets that page's HTML
  and no scripts or styles. Opening it would mean adding that one prefix to all three
  edge filters.

## Hydrate

```bash
cp relay.toml.example relay.local.toml      # gitignored: your domain, cluster and storage names
$EDITOR relay.local.toml
python3 scripts/hydrate.py --target all     # -> .build/<target>/ (gitignored)
python3 scripts/hydrate.py --check-clean    # before every commit
```

`--example` renders from `relay.toml.example` instead, and `--config <path>` reads another
file. Every key is required and validated: hostnames, positive limits, Kubernetes quantities
(with `memory_request <= memory_limit`), label selectors, Worker and bucket names, and NIP-05
names mapped to `npub` or hex keys. An unknown or missing key is an error, not a default.
Re-hydrating removes only files an earlier hydration wrote, so a `.env` or `data/` you keep
next to the output survives.

### Keeping your environment out of Git

Your values exist in two gitignored places only: `relay.local.toml` and `.build/`. The
templates carry placeholders and example values (`relay.example.com`). `--check-clean`
fails when anything Git would publish contains:

- an identifying value from `relay.local.toml` that differs from the example (relay host
  and its parent domain, namespace, storage and priority classes, kubeconfig path and
  context, Worker and bucket names, page title, campaign, NIP-05 names and keys),
- any `[hygiene] forbidden_tokens` entry, or `--forbid TOKEN`, matched case-insensitively,
- a secret-shaped value: an `nsec`, a PEM private key, a relay signing key or `ADMIN_TOKEN`
  value, a kubeconfig client key, or an `nm1_` invite token.

It scans the working tree (tracked files and files not ignored), the index, every commit
message and blob in history, and path names. It also fails when `relay.local.toml`,
`.build/` or `.env` stop being ignored or are tracked.

## Kubernetes

```bash
python3 scripts/hydrate.py --target kubernetes --apply
python3 scripts/hydrate.py --target kubernetes --verify
```

`--apply` uses `kubeconfig` and `context` from `[kubernetes]` when set. It applies the
namespace, creates the `nostr-relay-signing` Secret with a fresh 32-byte hex key only if
that Secret does not exist (the key goes to kubectl on stdin and is never printed or
written), runs a server-side dry run of the whole kustomization, then
`kubectl apply -k .build/kubernetes`.

Against an existing StatefulSet the apply is zero-downtime. `updateStrategy: OnDelete`
means a changed template (new image, or a changed `relay.yaml`, which renames the
generated ConfigMap) reaches the pod only when you delete `nostr-relay-0`. `--verify`
reports such a pending rollout. Kubernetes never updates `volumeClaimTemplates` in place,
so `storage_size` and `storage_class` must equal the live values; the dry run catches a
mismatch before anything changes.

`--verify` checks the pod is ready and on which revision, then reads the NIP-11 document
at `https://<relay_host>/` directly, ignoring `HTTP(S)_PROXY`. It requires
`auth_required`, `membership_required` and the configured name. `--verify-url` points it
elsewhere, for example at a port-forward.

Set `traefik_egress_network_policy = true` only when the `traefik` namespace enforces
default-deny egress. The policy opens Traefik to the relay on 5500, and the first egress
policy that selects a pod forbids everything else for that pod.

## Docker Compose

Copy `.build/compose/` to a host with Docker, DNS for the relay host, and ports 80/443
open, then follow the steps at the top of `compose.yaml`. They create the data
directory for UID 65532 and a `.env` with a fresh signing key, then start Caddy and the
relay.

## Cloudflare Workers

```bash
cd .build/cloudflare
npx wrangler r2 bucket create <r2_bucket>
openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put ADMIN_TOKEN
openssl rand -hex 32 | npx wrangler secret put RELAY_SIGNING_KEY
npx wrangler deploy
```

`RELAY_SIGNING_KEY` is the relay's own key, as `NCLI_NIP11_PRIVKEY` is on the ncli targets.
NIP-11 names it as `pubkey` and `self`. It signs the invites members mint and the NIP-29
group state, and the Worker refuses to start without it. Set it once: replacing it
changes the relay's identity.

The relay host's zone must be on the account: the Worker becomes its custom domain, with
`workers.dev` and preview URLs off. One Durable Object holds every socket, the events and the
member list in SQLite. R2 holds the blobs. The Worker implements:

- BIP-340 Schnorr signatures and SHA-256 event ids, checked on every event, and signed for
  the relay's own events
- NIP-11 with `auth_required`, `membership_required` and the relay's key
- NIP-42 `AUTH` before anything else
- NIP-43 `kind 28934` single-use invite redemption, and invites members mint with REQ
  `kind 28935`
- NIP-29 groups: create (9007), put-user (9000), remove-user (9001), edit-metadata (9002),
  join (9021) and leave (9022) requests, relay-signed state (39000-39003), private,
  restricted, closed and hidden groups, pending joins and the moderation log
- recipient-only kinds 1059, 4410 and 4411
- NIP-01/NIP-33 regular, replaceable, addressable and ephemeral events, NIP-40 expiry and
  NIP-70 protected events
- Blossom `kind 24242` authorization for `PUT /upload` and `GET`/`HEAD /media/<sha256>`, with
  R2 checking the SHA-256 on upload
- a per-key event rate limit and a cap on in-flight uploads
- the Visual Web Console at `/` for a browser (`src/console.ts`): one self-contained page,
  run under a Content-Security-Policy that admits its own script and style by hash and
  connects only to this relay. It signs through a NIP-07 browser extension, so no secret
  key reaches the page. A member signs in, redeems or mints an invite, creates and runs
  groups (members, roles, pending join requests, metadata), and sees which sealed
  envelopes are addressed to them.

It refuses the NIP-29 moderation kinds it does not implement (9005 delete-event, 9008
delete-group, 9009 create-invite, 9010 pins, and the rest of 9003-9020) by name, and keeps
a group's last admin from being removed, demoted or leaving. It does not implement NIP-09
deletion, `COUNT` or search.

Membership is managed over `/_admin/`, which answers 404 unless the bearer token equals
`ADMIN_TOKEN`. `scripts/cf_ncli_shim.py` turns the `ncli relay ...` commands nostr-mailbox
sends into those calls:

```bash
export ADMIN_TOKEN=...                      # the value given to wrangler
SHIM="python3 scripts/cf_ncli_shim.py --url https://relay.example.com"
nostr-mailbox setup --relay wss://relay.example.com --campaign my-campaign --exec "$SHIM"
nostr-mailbox invite --exec "$SHIM"         # prints {"token": "nm1_...", ...}
nostr-mailbox relay revoke <npub> --exec "$SHIM"
```

## GitHub Pages

Publish `.build/github-pages/` as a site root. `.nojekyll` keeps `.well-known/` from being
dropped, and `domain` writes a `CNAME`. NIP-05 lookups need the domain root, so use a user
or organization site, or a custom domain. The page shows the relay's live NIP-11 status
and the commands members need to install nostr-mailbox, join with their `nm1_` token, and
check access.

## With nostr-mailbox

nostr-mailbox is the client: agent seats and people join with one outbound `wss://`
connection and a key of their own. This repository is the relay side. Hydrate a target,
deploy it, then from the operator's machine:

```bash
nostr-mailbox setup --relay wss://<relay_host> --campaign <campaign> --kubectl
nostr-mailbox invite --kubectl              # one key, one use, seven days
```

Members run `nostr-mailbox join nm1_...` and `nostr-mailbox relay check`.

## Tests

```bash
pytest -q
ruff check .
python3 scripts/hydrate.py --example --target all && python3 scripts/hydrate.py --check-clean
```

The suite runs `hydrate.py` as a subprocess on a copy of the repository, with real git for
`--check-clean` and a real loopback server for `--verify`. It runs the Worker's own
TypeScript under Node 23.6+ with real SQLite and real HTTP and WebSocket frames, driven by
a client that signs with the BIP-340 reference algorithm and is pinned to the published
vectors. It runs the shim as a subprocess with the exact argv nostr-mailbox sends, and
builds the Kubernetes tree with `kubectl kustomize` when kubectl is present. When a Docker
daemon answers (`DOCKER_HOST` is honoured), it also runs the pinned ncli image itself:
`ncli relay --check` on the hydrated `relay.yaml`, and a live ncli relay that the
self-service scenarios run against as they run against the Worker. Without Docker those
witnesses are skipped. With
`NOSTR_MAILBOX_SRC=<checkout>/skills/nostr-mailbox`, nostr-mailbox's own relay, admin and
Blossom clients run against the Worker too.

Not covered: `--apply` against a cluster, the Workers runtime itself (WebSocketPair,
hibernation, R2), the Caddy and Traefik binaries, and the console page in a browser (Node
checks its script parses and the tests check its CSP hashes, but no browser runs it).

## Layout

```
relay.toml.example        every setting, with example values
scripts/hydrate.py        validate, render, --check-clean, --apply, --verify
scripts/cf_ncli_shim.py   `ncli relay ...` for the Cloudflare Worker's admin API
templates/shared/         relay.yaml for both ncli targets
templates/kubernetes/     manifests and kustomization
templates/compose/        compose.yaml, Caddyfile, env.example
templates/cloudflare/     wrangler.toml, src/worker.ts, src/nostr.ts, src/console.ts
templates/github-pages/   index.html
tests/                    test_hydrate.py, the Worker harness, the test signer
```

## License

Apache-2.0
