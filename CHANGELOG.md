# Changelog

## Unreleased

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
