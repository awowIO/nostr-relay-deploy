# Changelog

## Unreleased

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
