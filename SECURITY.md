# Security

## Report a vulnerability

Use **Report a vulnerability** on the repository's Security tab when private
reporting is available. If that option is unavailable, open an issue asking a
maintainer for a private reporting channel. Keep technical details and identifying
information out of that public request. [Repository security](https://github.com/awowIO/nostr-relay-deploy/security)

In the private report, include the affected commit, deployment target, expected
access boundary, observed impact and a minimal example using synthetic settings.
Redact invite tokens, Nostr private keys, relay signing keys, admin bearer tokens,
kubeconfigs, private hostnames and personal data from logs or screenshots.

## If a credential was exposed

Revoke unspent invites and remove compromised member keys on the affected relay. A
leaked Worker magic URL (`/mcp/s/nm1_…`) or OAuth access token (`nmot_…`) carries the
power of its `nm1_` token. Remove the token's `default` persona to shut out all three.
Replace an exposed Worker admin token in Cloudflare and in operator tooling. A
compromised relay signing key requires an identity change. Coordinate replacement
with members who trust the old public key. Removing a secret from Git does not
revoke a credential that others may already hold.

Keep private configs and rendered trees out of commits. The repository hygiene check
searches for configured identifiers and recognizable secret formats. Review diffs for
other sensitive material before sharing them.
