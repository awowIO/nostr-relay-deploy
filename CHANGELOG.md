# Changelog

## Unreleased

- Added named hydration profiles. Operators can render and apply from
  `.build/<profile>/<target>/` and continue using the default `.build/<target>/` layout.
- Extended the Git hygiene check to include repository `*.local.toml` configs and any config
  explicitly supplied to the command.
- Added deployment guides for a private fleet relay, an independent collaborator
  relay, Cloudflare Workers with R2, and ncli on Compose or Kubernetes.
- Added contributor and security reporting instructions, locked development tools,
  and CI covering lint, Git hygiene and both relay implementations.
