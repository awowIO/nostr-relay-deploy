# Changelog

## Unreleased

- Kubernetes can serve the Web Console: with `kubernetes.web_console = true` the
  Worker's console page, rendered from `console.ts` without its MCP and OAuth controls,
  answers browsers at `/`, `/join` and `/join/` from its own zero-egress nginx
  Deployment, while WebSocket and NIP-11 requests at `/` still reach the relay. The new
  key is required: add `web_console = false` to an existing configuration to keep it
  as it is.
- Traefik's egress policy is named after the relay's namespace
  (`<namespace>-backend`), so a second relay on a cluster no longer overwrites the
  first one's, and each relay namespace gets a default-deny NetworkPolicy.
- `relay.yaml` caps each key's REQs at `events_per_minute` a minute, which also caps how
  many invite codes one member mints on ncli.
- The console no longer sends a token to the relay when an invite link opens it or a
  member mints one; only submitting the Pair card does. Both pages open with
  **01 · Already invited**, which previews a pasted link, token or code, and
  **02 · Request an invite**, which now says when MayWe has paused requests. The header
  stays in view, a narrow screen no longer scrolls sideways, and the invite-request
  honeypot is hidden by a stylesheet rule the console's CSP admits. The GitHub Pages
  install commands name `awowIO/crosswire`.

- The Cloudflare Worker console and the GitHub Pages page share a new dense,
  full-width design: 13px type with tabular numerals, a header with the relay's name,
  WebSocket URL and signed-in key, light and dark themes with a header toggle, and a
  stat bar of what the relay advertises.
- The console's **Mint invite & magic MCP link** now mints a whole `nm1_…` token. The
  relay mints a single-use code, and the browser packs it, byte for byte as
  `nostr-mailbox invite` does, for a room whose 32-byte NIP-44 key the browser makes
  once and keeps. The **Pair a coding agent** card fills in at once with the magic MCP
  and OpenAPI URLs, the OAuth URL and the join link, and gives the setup for ChatGPT,
  Claude, Claude Code, Codex, Antigravity, Cursor and Pi or OpenCode.
- The README and the split-horizon guide show a public community switchboard beside an
  isolated internal relay.
- Hosted assistants can now connect to the Cloudflare Worker's MCP server without
  copying a bearer token into the client. `/mcp` answers 401 with an RFC 9728
  `resource_metadata` challenge. The Worker serves OAuth 2.1 discovery, dynamic client
  registration, a consent page and a PKCE token endpoint whose 30-day access tokens act
  as the token's persona. Magic URLs at `/mcp/s/<nm1_token>`, with an OpenAPI document
  at `/mcp/s/<nm1_token>/openapi.json`, serve clients set to Authentication: None. The
  console's new **Pair a coding agent** card shows both URLs with copy buttons, and can
  remember the token for the consent page.
- Added a remote MCP server to the Cloudflare Worker. `/mcp` speaks Streamable HTTP,
  `/openapi.json` and `/tools/<tool>` serve Custom GPT Actions, and all three
  authenticate with an `nm1_…` token. A persona derived from the token redeems it and
  posts and reads the topic's NIP-44 encrypted bus and board with nostr-mailbox's six
  tools.
- The Worker now accepts NIP-29 group invite codes (9009). It admits a join that
  carries one at once and spends the code, as the pinned ncli does.
- Added named hydration profiles. Operators can render and apply from
  `.build/<profile>/<target>/` and continue using the default `.build/<target>/` layout.
- Extended the Git hygiene check to include repository `*.local.toml` configs and any config
  explicitly supplied to the command.
- Added deployment guides for a private fleet relay, an independent collaborator
  relay, Cloudflare Workers with R2, and ncli on Compose or Kubernetes.
- Added contributor and security reporting instructions, locked development tools,
  and CI covering lint, Git hygiene and both relay implementations.
