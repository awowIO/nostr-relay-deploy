**PUBLIC REPO — do not push without approval.**

# nostr-relay-deploy

- Operator values (domains, cluster, storage and priority classes, kubeconfig paths) live only in
  `*.local.toml` and `.build/`, both gitignored. Templates carry `{{ placeholders }}` and example
  values (`relay.example.com`). Never write an operator value into a tracked file, a test or a commit
  message.
- Before every commit: `python3 scripts/hydrate.py --check-clean`. Tests that need secret-shaped
  strings build them from pieces so this repository's own check stays green.
- Checks: `ruff check .`, `pytest -q`, and
  `python3 scripts/hydrate.py --example --target all && python3 scripts/hydrate.py --check-clean`.
- Standard library only (Python 3.12+). The Worker has no npm dependencies and uses only erasable
  TypeScript, so Node's type stripping runs it in the tests.
- The names `nostr-relay`, `nostr-relay-signing`, `nostr-relay-config`, the pod `nostr-relay-0` and the
  StatefulSet's immutable fields are what a zero-downtime apply against the live StatefulSet depends
  on. Do not rename them.
- The three edge filters (`templates/compose/Caddyfile`, `templates/kubernetes/ingressroute.yaml`,
  `edgeRoute` in `templates/cloudflare/src/nostr.ts`) change together; the tests hold them to one table.
- `--apply`, `kubectl apply` and `wrangler` change live infrastructure: run them only with the
  operator's approval.
