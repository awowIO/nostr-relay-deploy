# Relay protocol and onboarding

## Routes

| Request | Path | Purpose |
| --- | --- | --- |
| WebSocket upgrade | `/` | Nostr with NIP-42 authentication |
| GET or HEAD | `/` | NIP-11 with `Accept: application/nostr+json`, otherwise the homepage |
| PUT | `/upload` or `/media/upload` | Signed Blossom upload |
| GET or HEAD | `/<sha256>` or `/media/<sha256>` | Signed Blossom download, optionally with a file extension |
| GET or HEAD | `/join` or `/join/` | Cloudflare invite console |
| POST, GET or DELETE | `/mcp` | Cloudflare remote MCP server, with an `nm1_…` token or an OAuth access token |
| GET | `/openapi.json` | Cloudflare OpenAPI 3.1 document of the MCP tools, with a token |
| POST | `/tools/<tool>` | Cloudflare tool call as plain JSON, with a token |
| POST, GET or DELETE | `/mcp/s/<nm1_token>` | Cloudflare remote MCP server at a magic URL whose path carries the token |
| GET | `/mcp/s/<nm1_token>/openapi.json` | Cloudflare OpenAPI 3.1 document whose server is that magic URL |
| POST | `/mcp/s/<nm1_token>/tools/<tool>` | Cloudflare tool call under the magic URL |
| GET | `/.well-known/oauth-protected-resource` or `/.well-known/oauth-protected-resource/mcp` | Cloudflare OAuth protected-resource metadata of `/mcp` (RFC 9728) |
| GET | `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration` | Cloudflare OAuth authorization server metadata (RFC 8414) |
| POST | `/oauth/register` | Cloudflare dynamic client registration (RFC 7591) |
| GET or POST | `/oauth/authorize` | Cloudflare consent page, and its answer |
| POST | `/oauth/token` | Cloudflare authorization code and PKCE verifier exchange for an access token |
| Bearer-authenticated admin requests | `/_admin/` | Cloudflare membership and invite administration |

Caddy and Traefik filter public requests before they reach ncli. Other routes return
404. The Worker applies the same relay and Blossom filters. It also serves its join
console, its admin API, and the remote MCP server and OAuth 2.1 sign-in described in
[Connect ChatGPT, Claude.ai and other remote MCP clients](cloudflare-workers.md#5-connect-chatgpt-claudeai-and-other-remote-mcp-clients).
Send the NIP-11 media type on its own. Both relay implementations return 400 for an
Accept list that mixes it with other media types.

## What a member can do

- **Invite one key.** A member requests kind 28935 with a limit of one. The relay
  returns a signed ephemeral claim, sends EOSE and closes the subscription. Redeeming
  the code uses kind 28934. The default is one use within seven days. Each Worker
  claim counts against the member's event rate limit. Removing a member leaves their
  outstanding invites valid until they expire or an operator revokes them.
- **Run a private group.** Kind 9007 creates a NIP-29 group with its creator as admin.
  New groups are private and closed. Members can read the group's messages, signed
  state (39000–39003) and accepted moderation log. Admins can review pending joins
  (9021), admit a member (9000), remove one (9001), and edit metadata (9002). An admin
  can also register a group invite code (9009). A join request that carries the code is
  admitted at once, and the code then admits no one else. Only the group's admins can
  read the 9009, and the request that spent the code is not kept. nostr-mailbox's
  `topic invite` and `join` rely on this.
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
rejected, including 9005 (delete event), 9008 (delete group) and 9010 (pins). NIP-09 deletion, COUNT and search are also unsupported.

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
groups and see envelopes addressed to them. Anyone with a token can pair a coding agent
on it without signing in. The console reads invite fragments in the
forms `#nm1_…`, `#join=nm1_…` and `#invite=<code>`, then clears the fragment. It fills
a relay invite for its own host and waits for the member to redeem it. Topic invites
need the CLI, or the Worker's remote MCP server, to hold the channel keys. Invites
naming a different relay stay unused.

On Compose and Kubernetes, the pinned ncli release serves homepage HTML at the root.
Its script and stylesheet paths under `/_home/assets/` fall outside the edge filters.
A browser receives 404 on the join paths. Use the CLI for invite links on these targets.

## Connect a hosted assistant without pasting a token

On the Cloudflare target, ChatGPT, Claude.ai and other MCP clients reach the relay's
mailbox tools with an `nm1_…` topic token. Neither flow puts the token in the client's
authentication settings.

1. **1-click OAuth popup.** Add `https://relay.example.com/mcp` to the client. Its first
   request is answered 401 with a `resource_metadata` challenge. The client discovers the
   relay's OAuth 2.1 server, registers itself, and opens the relay's consent page,
   titled `Connect <client> to <relay name>`. Paste the token there and press **Authorize**.
   The page fills the token in when this browser remembers it from the console. The
   client trades the code with its PKCE verifier for a 30-day access token.
2. **1-paste magic URL.** In a client set to Authentication: None, add
   `https://relay.example.com/mcp/s/nm1_…`, or import
   `https://relay.example.com/mcp/s/nm1_…/openapi.json` into a Custom GPT Action. That
   document's server is the magic URL and its `security` is empty.

The console's **Pair a coding agent** card builds the URLs for both flows from a token or
an invite link, each with a copy button. A magic URL is the token: keep it as private as
the token.

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
