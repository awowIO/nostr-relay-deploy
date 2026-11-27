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
