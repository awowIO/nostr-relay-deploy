# Contributing

Changes to a deployment target should include a test of the generated files or the
operator command that uses them. For a change to an edge route, update the Caddy,
Traefik and Worker filters together and extend their shared route tests.

## Run the checks locally

Install Git, uv, Python 3.12+, Node.js 23.6+ (CI uses 24), kubectl, and Docker with
a running daemon. The development dependency group supplies Ruff and pytest. The
hydrator and admin shim use only Python's standard library.

The mailbox integration tests use a second repository. With both repositories side
by side, check out the same client revision as CI in a fresh checkout. If you already
have a checkout, point the environment variable at its skill directory.

```bash
git clone https://github.com/awowIO/nostr-mailbox.git ../nostr-mailbox && \
  git -C ../nostr-mailbox checkout --detach c8eabb8de4b3935b66d2e9d9604dbc048e8c90ea
export NOSTR_MAILBOX_SRC="$(cd ../nostr-mailbox/skills/nostr-mailbox && pwd)"
```

Run the checks from the root of this repository.

```bash
uv sync --locked
uv run ruff check .
python3 scripts/hydrate.py --check-clean
uv run pytest -q
```

For full coverage, confirm Docker answers in this shell and kubectl is on PATH.
If using Colima or another Docker context, select its running daemon via
`DOCKER_CONTEXT` or `DOCKER_HOST`. A complete run reports zero skips. CI checks
out full Git history for the hygiene scan and fails if any test skips.

The suite exercises the CLI with real Git repositories, renders the manifests with
kustomize, checks NIP-11 on loopback, runs the Worker code under Node with SQLite and
WebSockets, and starts the pinned ncli image in Docker. It runs mailbox setup, invite
and join against both relay implementations. Live Kubernetes changes, Cloudflare's
managed runtime, the Caddy/Traefik binaries and browser rendering are outside this suite.

## Submit a change

Keep machine-specific settings in `*.local.toml` files and generated files in
`.build/`. Use synthetic values in examples, tests, screenshots and commit messages.
The hygiene check also examines staged files and reachable history. It checks
identifying config values that differ from public example settings. Add any other
private identifiers to the config's `[hygiene].forbidden_tokens` list, or use the
repeatable `--forbid` option for a single run. For deployment
changes, describe the affected target, any operator action and the checks you ran
in the pull request. Put user-visible changes under Unreleased in [CHANGELOG.md](CHANGELOG.md).

Report security issues through the process in [SECURITY.md](SECURITY.md).
