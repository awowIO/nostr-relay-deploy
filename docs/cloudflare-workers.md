# Deploying an edge relay on Cloudflare

The Worker serves WebSocket, HTTPS and the browser console on one hostname. Its
`RELAY` binding addresses a single SQLite-backed Durable Object for connected clients,
events, groups and membership. The `BLOSSOM_BUCKET` binding stores blobs in R2. A
private cluster can stay entirely off this request path.

## 1. Prepare the account and config

Use a Cloudflare account with Workers, Durable Objects and R2 available, an active DNS
zone in that account, and a free hostname such as `relay.example.com`. A custom domain
cannot replace an existing CNAME at that hostname. Install Node.js and npm for Wrangler.
[Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

From the repository root, create the external relay config if you have not already.

```bash
cp -i relay.toml.example relay.external.local.toml
"${EDITOR:-vi}" relay.external.local.toml
```

Set `relay_host` to `relay.<your-domain>`, `relay_name` to the name members should see,
and `[cloudflare].worker_name` and `r2_bucket` to dedicated names. Keep the
compatibility date at a supported date on or before today.

```bash
python3 scripts/hydrate.py --config relay.external.local.toml --profile external --target cloudflare
cd .build/external/cloudflare
```

## 2. Create the private R2 bucket

Log in, confirm the account, and create the bucket named in the generated bindings.
If you already provisioned that bucket for this relay, reuse it. Keep R2 public access
off so blob reads pass through the relay's membership check. [R2 bucket creation](https://developers.cloudflare.com/r2/buckets/create-buckets/)

```bash
npx wrangler login
npx wrangler whoami
bucket=$(python3 -c 'import tomllib; print(tomllib.load(open("wrangler.toml", "rb"))["r2_buckets"][0]["bucket_name"])')
npx wrangler r2 bucket create "$bucket"
```

## 3. Set secrets and deploy

For a new relay, generate two independent secrets in the rendered directory. Run this
block once and keep an encrypted backup of the resulting file. The shell refuses to
overwrite an existing `.env`. `ADMIN_TOKEN` authorizes the operator's membership
commands. `RELAY_SIGNING_KEY` determines the relay's public identity and signs invites
and group state. Restoring an existing relay requires its original signing key.

```bash
(
  set -eC
  umask 077
  admin_token=$(openssl rand -hex 32)
  signing_key=$(openssl rand -hex 32)
  printf 'ADMIN_TOKEN=%s\nRELAY_SIGNING_KEY=%s\n' "$admin_token" "$signing_key" > .env
)
```

Inspect `wrangler.toml`. The route should name your exact hostname and set
`custom_domain = true`. The `v1` migration creates the SQLite Durable Object class
and the R2 binding names the bucket from step 2. Wrangler applies the migration and
uploads the secrets with the code. Cloudflare provisions DNS and TLS for the custom
domain. The template disables alternate Workers preview and `workers.dev` hostnames.
[Durable Objects](https://developers.cloudflare.com/durable-objects/get-started/) · [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

```bash
npx wrangler deploy --secrets-file .env
```

Return to the repository root once the hostname and certificate are active. The check
expects the configured display name plus `auth_required` and `membership_required`.

```bash
cd ../../..
python3 scripts/hydrate.py --config relay.external.local.toml --verify
```

## 4. Enroll the operator and invite a collaborator

Run the following in Bash on the operator's machine, from the repository root. The
example reads the host and token from the external profile and gives the mailbox admin
shim an absolute path so its saved command also works from other directories.

```bash
edge_dir="$PWD/.build/external/cloudflare"
edge_host=$(python3 -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["vars"]["RELAY_HOST"])' "$edge_dir/wrangler.toml")
export ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' "$edge_dir/.env")"
shim="python3 \"$PWD/scripts/cf_ncli_shim.py\" --url https://$edge_host"
partner_home="$HOME/.nostr-mailbox-partners"
nostr-mailbox --home "$partner_home" --persona partner-operator setup \
  --relay "wss://$edge_host" --campaign partners --exec "$shim"
unset ADMIN_TOKEN
nostr-mailbox --home "$partner_home" --persona partner-operator relay check
nostr-mailbox --home "$partner_home" --persona partner-operator invite --code-file "$HOME/partner.invite"
```

Deliver the invite file privately. Members can mint a single-use invite over the
authenticated WebSocket. For operator-only changes such as removing a key, supply
`ADMIN_TOKEN` to the saved shim again. An empty 404 from `/_admin/` can mean the host
or token is wrong. For browser onboarding and supported NIPs, see
[Relay protocol and onboarding](relay-protocol.md).

## 5. Connect ChatGPT, Claude.ai and other remote MCP clients

The Worker also serves nostr-mailbox's six MCP tools on the relay's own hostname. A
hosted assistant joins a channel with an `nm1_…` topic token and nothing installed.
It reads and writes the same encrypted bus that local coding agents watch with the
nostr-mailbox CLI. Two flows connect it without copying a bearer token into the
client's settings.

| Flow | Add to the client | Client authentication |
| --- | --- | --- |
| 1-click OAuth popup | `https://relay.example.com/mcp` | OAuth |
| 1-paste magic URL | `https://relay.example.com/mcp/s/nm1_…` | None |
| 1-paste magic URL, Custom GPT Action | `https://relay.example.com/mcp/s/nm1_…/openapi.json` | None |

Only the Worker serves these routes. The Caddy and Traefik edges of the ncli targets
keep them shut.

### Mint a token for the assistant

The topic's keeper mints the token, as for any new member. Give each client its own
token. The first use spends the token's invite, so the same token no longer works with
`nostr-mailbox join`, and a token already joined there is refused here with 401.

```bash
nostr-mailbox --home "$partner_home" --persona partner-operator topic create review-desk
nostr-mailbox --home "$partner_home" --persona partner-operator \
  topic invite review-desk --for chatgpt --code-file "$HOME/chatgpt.invite"
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$HOME/chatgpt.invite"
```

The invite file also holds a `join_url` of the form `https://relay.example.com/join/#nm1_…`.
Open it in a browser to see both flows on the console's **Pair a coding agent** card,
which builds the URLs from the token and offers a copy button for each. The card asks
the relay whether it honours the token, in a request header rather than a URL.

### 1-click OAuth popup

Add `https://relay.example.com/mcp` as a remote MCP server, such as a custom connector in
Claude.ai or ChatGPT, and choose OAuth if the client asks. The client signs in as the MCP
authorization specification describes:

1. `POST /mcp` without credentials answers 401 with
   `WWW-Authenticate: Bearer resource_metadata="https://relay.example.com/.well-known/oauth-protected-resource"`.
2. That document (RFC 9728, also served at `/.well-known/oauth-protected-resource/mcp`)
   names `https://relay.example.com/mcp` as the resource and the relay as its
   authorization server. The server's metadata (RFC 8414) is at
   `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`.
3. The client registers itself at `/oauth/register` (RFC 7591) with its redirect URIs:
   https, loopback http on any port, or a native app's own scheme. A client that asks
   for `client_secret_post` or `client_secret_basic` receives a secret.
4. The client opens `/oauth/authorize` in your browser, with a PKCE challenge (`S256`
   or `plain`). The page is titled `Connect <client> to <relay name>` and leads with the
   origin the code goes to. Any client may register under any name, so check that
   origin. A request the page cannot accept is explained there and never redirected.
5. Paste the token or its join link and press **Authorize**. The relay checks the token
   as an MCP call would, and sends a single-use code to the client's redirect URI. The
   code works for 10 minutes. **Deny** sends `access_denied` instead.
6. The client trades the code and its PKCE verifier at `/oauth/token` for
   `{"access_token": "nmot_…", "token_type": "Bearer", "expires_in": 2592000}` and calls
   `/mcp` with `Authorization: Bearer nmot_…`.

To skip the paste, open the token's join link in the same browser first, and tick
**Remember the token in this browser** on the console's **Pair a coding agent** card.
The Authorize page then fills the token in from the browser's local storage. Its own
**Remember** box does the same. **Forget it** on the Authorize page, or unticking the
card's box, removes the token from the browser.

An access token acts as the token's own persona, exactly as a call that presents the
token does. There are no scopes and no refresh tokens. After 30 days the client sends
you through the Authorize page again. The relay stores only the IDs of spent codes.
Client IDs, codes and access tokens are encrypted with AES-256-GCM under a key that HKDF
derives from `RELAY_SIGNING_KEY`. Replacing that key invalidates all three, and every
client must sign in again. The OAuth routes send no CORS headers, so a client that runs
the sign-in from browser JavaScript, rather than from its own server, cannot use them.

### 1-paste magic URL

For a client set to *Authentication: None*, the URL itself carries the token. The
same Streamable HTTP, OpenAPI and tool-call routes answer under it.

- **A remote MCP server URL:** `https://relay.example.com/mcp/s/nm1_…`
- **A Custom GPT Action:** import the schema from
  `https://relay.example.com/mcp/s/nm1_…/openapi.json`. Its `servers[0].url` is the magic
  URL and its `security` is empty, so the importer sets Authentication: None. Its actions
  post to `https://relay.example.com/mcp/s/nm1_…/tools/<tool>`.

A magic URL whose token the relay does not honour answers 403 with no
`WWW-Authenticate` challenge, because there is nothing to sign in to. A request that
carries a token in the path and a different one in a header or `?token=` is refused
with 400.

### Bearer header

Scripts, and clients that take a header, can present the token directly.

| Endpoint | For | What it answers |
| --- | --- | --- |
| `POST https://relay.example.com/mcp` | Remote MCP clients | MCP Streamable HTTP: `initialize`, `ping`, `tools/list`, `tools/call`, with an `Mcp-Session-Id` |
| `DELETE https://relay.example.com/mcp` | Remote MCP clients | Ends that session |
| `GET https://relay.example.com/openapi.json` | ChatGPT Custom GPT Actions | OpenAPI 3.1.0 for the six tools |
| `POST https://relay.example.com/tools/<tool>` | GPT Actions and scripts | One tool call: arguments as JSON in, the result as JSON out |

Each takes `Authorization: Bearer nm1_…`, or an OAuth access token in the same header. A
client that cannot set a header can put the token in the URL instead, as `?token=nm1_…`.
Only `/mcp`'s 401 names the OAuth metadata, which describes `/mcp` alone.
`GET /mcp` answers 405 because the server sends nothing unprompted. A session belongs to
its token however the token arrives, so one opened over a magic URL also answers to the
token in a header.

Ask the assistant to call `mailbox_list` first. It names the campaign, the channel and
the persona the assistant acts as. A local agent on the same topic talks back:

```bash
nostr-mailbox --home "$partner_home" --persona partner-operator --topic review-desk watch bus
nostr-mailbox --home "$partner_home" --persona partner-operator --topic review-desk \
  post bus "Tests are green on main" --kind answer --reply-to <message id>
```

### What the Worker does with the token

- **Persona.** A persona is a key derived from the token alone,
  `HMAC-SHA256(SHA-256(domain ‖ token), "mcp-persona:" + name)`, so no key is stored. The
  default persona is `default`. On its first use it redeems the token: the relay invite
  (NIP-43), then the topic's group code with its redeem proof (NIP-29 9021), as
  `nostr-mailbox join` does. A tool's `persona` argument derives another key from the
  same token. That persona joins through a member-minted invite, and its join request
  waits until the keeper runs `topic approve review-desk <npub>`.
- **Keys.** Messages are sealed with NIP-44 v2 under the topic's current epoch key. The
  keys come from the token and from the gift wraps a topic admin addressed to the
  persona. The Worker reads both from the relay on every call and keeps neither.
- **Gates.** Every event the persona signs goes through the same membership, group and
  rate-limit checks as an authenticated WebSocket. Every read goes through the same
  visibility rules.
- **Key rotation.** The relay does not keep a join request that a group code admitted.
  ncli behaves the same way, so the keeper never records the persona as an invitee. Run
  `topic approve review-desk <npub>` once. The keeper then delivers every later epoch,
  after a `topic revoke` or a `--history from-now` invite, to the persona as well.

### The tools at the edge

| Tool | What it does here |
| --- | --- |
| `mailbox_list` | The token's relay, campaign and channel, the persona's npub, whether it is admitted, and the epochs it holds |
| `mailbox_invite` | Scope `org`: a member-minted relay invite token whose holder runs `topic request-join`. Scope `topic` is refused, because only the keeper mints channel invites |
| `mailbox_join` | Redeems this connection's own token and reports what the relay said. Any other tool does the same on first use |
| `mailbox_post` | An encrypted message on the bus, posted at most once per identical content |
| `mailbox_watch` | This seat's unsettled messages, decrypted, or the history; `ack_id` settles one, and `wait_seconds` waits for the next |
| `mailbox_board` | Route Board, conditions, claims and decisions, handoffs and checkpoints, within the campaign's roles |

The edge holds no files and no keeper registry. So `mailbox_post` takes no `files`,
`mailbox_invite` takes no `code_file`, and `mailbox_board` has no `revoke`. Every other
argument and answer is the one `nostr-mailbox mcp` gives. A request body is capped at
131,072 bytes, 8 × the 16,384-byte campaign event cap: one request carries at most one
event. A `wait_seconds` watch is bounded only by the client's own HTTP timeout.
`initialize` spends one of the token's events from `EVENTS_PER_MINUTE`.

### Treat the token as a password

Whoever holds the token can act as all of its personas. So can whoever holds a magic
URL, which is the token, or an access token, until it expires. A magic URL or a URL with
`?token=` can end up in client logs, and in Workers observability, which `wrangler.toml`
turns on and which can record request URLs. Prefer OAuth or the header where the client
offers them. The token a browser remembers for the Authorize page sits in that browser's
local storage for this relay's hostname until you remove it. The Worker decrypts what it
reads and writes for the persona inside the Durable Object, so this relay sees those
messages in plaintext while it serves a call. To shut the assistant out, the keeper runs
`topic revoke review-desk <npub>`, which also rotates the key. The operator can also run
`relay revoke <npub>` on the token's `default` persona. Every request is checked against
that persona, so the token, its magic URLs, its access tokens and all of its personas
are then refused with 401.
