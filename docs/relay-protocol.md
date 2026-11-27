# Relay protocol and onboarding

## Routes

| Request | Path | Purpose |
| --- | --- | --- |
| WebSocket upgrade | `/` | Nostr with NIP-42 authentication |
| GET or HEAD | `/` | NIP-11 with `Accept: application/nostr+json`, otherwise the homepage |
| PUT | `/upload` or `/media/upload` | Signed Blossom upload |
| GET or HEAD | `/<sha256>` or `/media/<sha256>` | Signed Blossom download, optionally with a file extension |
| GET or HEAD | `/join` or `/join/` | Cloudflare invite console |
| Bearer-authenticated admin requests | `/_admin/` | Cloudflare membership and invite administration |

Caddy and Traefik filter public requests before they reach ncli. Other routes return
404. The Worker applies the same relay and Blossom filters, and also serves its join
console and admin API. Send the NIP-11 media type on its own. Both relay implementations
return 400 for an Accept list that mixes it with other media types.

## What a member can do

- **Invite one key.** A member requests kind 28935 with a limit of one. The relay
  returns a signed ephemeral claim, sends EOSE and closes the subscription. Redeeming
  the code uses kind 28934. The default is one use within seven days. Each Worker
  claim counts against the member's event rate limit. Removing a member leaves their
  outstanding invites valid until they expire or an operator revokes them.
- **Run a private group.** Kind 9007 creates a NIP-29 group with its creator as admin.
  New groups are private and closed. Members can read the group's messages, signed
  state (39000–39003) and accepted moderation log. Admins can review pending joins
  (9021), admit a member (9000), remove one (9001), and edit metadata (9002).
  Querying a private group without membership gives the same restricted response as
  querying an unknown group.
- **Exchange envelopes and receipts.** Only keys in the event's `p` tags receive
  kinds 1059, 4410 and 4411 over queries or live subscriptions. A member can use
  their enrolled key for pairwise envelopes and receipts. Both implementations reject
  events authored by an unenrolled key, including a NIP-59 gift wrap signed with a
  one-time key.
- **Store a blob.** A member signs a kind 24242 Blossom authorization. The Worker
  verifies the SHA-256 during upload, limits concurrent uploads and stores the blob
  in the bound R2 bucket.

The Worker checks BIP-340 signatures and event IDs. It handles regular, replaceable,
addressable and ephemeral events, NIP-40 expiry, NIP-70 protected events and group
leave requests (9022). Its group moderation supports private, restricted, closed
and hidden groups and preserves the last admin. Unsupported moderation kinds are
rejected, including 9005 (delete event), 9008 (delete group), 9009 (create invite)
and 9010 (pins). NIP-09 deletion, COUNT and search are also unsupported.

On ncli, filtering recipient-only events happens after applying a query's limit. A
newer event a reader cannot see can therefore empty a limit-one answer. The Worker
counts events delivered to the reader.

## Invites and browser access

Relay and topic invites include a join URL. Its bearer token is in the URL fragment,
which browsers omit from HTTP requests. A recipient can redeem an invite file or
paste a join URL into the CLI prompt on any target.

```bash
nostr-mailbox join --code-file "$HOME/member.invite"
nostr-mailbox relay check
```

The Worker serves its self-contained console at the root and both join paths. It uses
a NIP-07 browser extension to sign. Members can redeem and mint invites, manage
groups and see envelopes addressed to them. The console reads invite fragments in the
forms `#nm1_…`, `#join=nm1_…` and `#invite=<code>`, then clears the fragment. It fills
a relay invite for its own host and waits for the member to redeem it. Topic invites
need the CLI to retain the channel keys. Invites naming a different relay stay unused.

On Compose and Kubernetes, the pinned ncli release serves homepage HTML at the root.
Its script and stylesheet paths under `/_home/assets/` fall outside the edge filters.
A browser receives 404 on the join paths. Use the CLI for invite links on these targets.

## Publish the optional GitHub Pages directory

Configure `[github_pages]` with the intended public title, campaign and optional
domain. The `nip05` table maps names to npub or hex public keys. Render the matching
relay config, then publish **only the contents of its github-pages directory** as the
site root. Render the external relay's directory from its own config.

```bash
python3 scripts/hydrate.py --config relay.external.local.toml --profile external --target github-pages
```

The output under `.build/external/github-pages/` includes an onboarding page at
`/` and `/join/`, `.well-known/nostr.json`, and `.nojekyll` so the hidden directory is
served. Setting `domain` adds a CNAME file. NIP-05 clients look up names at the domain
root, so use an organization/user site or a custom domain. Give the directory its own
hostname when the relay already occupies the relay hostname.

The page checks the relay's live NIP-11 status if browser CORS permits it, and turns
a same-relay invite fragment into a client join command. Every entry published here,
including relay addresses and public keys, is visible to visitors.
