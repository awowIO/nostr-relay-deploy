# Deploying ncli with Docker or Kubernetes

Both targets run the digest-pinned ncli image as UID/GID 65532 with a read-only root
filesystem. Each relay needs its own data store and signing key. Run examples from the
repository root unless a step names another directory.

## Docker Compose and Caddy

1. Prepare a host with Docker Engine, Compose v2 and OpenSSL. Set the relay hostname's
   DNS records to that host and allow inbound TCP 80 and 443 for Caddy's automatic TLS.
   Members connect on 443. The relay's own port 5500 stays inside the Compose network.

2. Copy the example config, edit the hostname, display name and Compose limits, and
   render the stack. This example deploys a standalone relay with the default output
   layout. For a profiled stack, add the profile and config flags and copy that tree.

   ```bash
   cp -i relay.toml.example relay.local.toml
   "${EDITOR:-vi}" relay.local.toml
   python3 scripts/hydrate.py --target compose
   ```

3. Copy the contents of `.build/compose/`, including `.env.example`, to a dedicated
   directory on the Docker host. From that directory, prepare storage and the initial
   signing key. The subshell creates a private `.env` and refuses to replace one that
   already exists. For an existing relay, restore its data and original key.

   ```bash
   sudo install -d -m 0750 -o 65532 -g 65532 data
   (
     set -eC
     umask 077
     signing_key=$(openssl rand -hex 32)
     { grep '^RELAY_HOST=' .env.example && printf 'RELAY_SIGNING_KEY=%s\n' "$signing_key"; } > .env
   )
   ```

4. Validate the rendered stack, start it and request its NIP-11 document.

   ```bash
   docker compose config --quiet && docker compose up -d
   docker compose ps
   relay_host=$(sed -n 's/^RELAY_HOST=//p' .env)
   curl -fsS -H 'Accept: application/nostr+json' "https://$relay_host/"
   ```

5. From the same host, enroll the operator and create an invite. Use the absolute path
   to the active Compose file. Back up `.env`, `data/` and Caddy's certificate volume.
   For two isolated Compose stacks, use separate hosts. On one Docker daemon the
   project names, bind addresses and published ports would also need coordination.

   ```bash
   mailbox_home="$HOME/.nostr-mailbox-compose"
   nostr-mailbox --home "$mailbox_home" setup --relay "wss://$relay_host" \
     --campaign my-campaign --compose "$PWD/compose.yaml"
   nostr-mailbox --home "$mailbox_home" relay check
   nostr-mailbox --home "$mailbox_home" invite --code-file "$HOME/compose-member.invite"
   ```

## Kubernetes StatefulSet and Traefik

1. Prepare a cluster with kubectl access, a provisioner for a ReadWriteOnce PVC,
   Traefik's `IngressRoute` CRD, a `websecure` entry point and a working TLS resolver.
   Use a NetworkPolicy-capable CNI. For a fleet relay, give Traefik a private ingress
   reachable only through the cluster or VPN. All clients must trust its certificate.

2. Prepare the internal configuration. Set `relay_host` and `[kubernetes]` values
   for `kubeconfig`, `context`, `namespace`, storage class and size, Traefik namespace,
   pod selector and certificate resolver. Enable `traefik_egress_network_policy`
   only when the selected ingress pods already have restricted egress. Their first
   egress policy would otherwise restrict all their other destinations.

   ```bash
   cp -i relay.toml.example relay.internal.local.toml
   "${EDITOR:-vi}" relay.internal.local.toml
   python3 scripts/hydrate.py --config relay.internal.local.toml --profile internal --target kubernetes
   kubectl kustomize .build/internal/kubernetes
   ```

3. Apply to the intended context. The hydrator applies the namespace, creates the
   signing Secret if absent, runs a server-side dry run of the kustomization, and
   applies the rendered tree. It preserves an existing signing key. Keep a protected
   backup of the Secret and PVC for recovery.

   ```bash
   python3 scripts/hydrate.py --config relay.internal.local.toml --profile internal --target kubernetes --apply
   ```

4. Once the pod is ready, verify its StatefulSet revision and NIP-11 response from
   the private network. Verification connects directly to the configured hostname.
   For a port-forward, supply a local HTTP URL using `--verify-url` to check NIP-11.

   ```bash
   python3 scripts/hydrate.py --config relay.internal.local.toml --profile internal --target kubernetes --verify
   ```

   There is one writer and one PVC. The `OnDelete` strategy lets the current pod keep
   serving after a manifest update. If verification reports a pending revision, schedule
   recreation of `nostr-relay-0` in the configured namespace and verify again. Its
   connections drop while the pod restarts. The StatefulSet's volume claim template,
   including its storage class and size, must match the live template on reapply.

5. On the operator machine, point kubectl at the same cluster as the hydrator. The
   mailbox CLI has its own Kubernetes connection settings. Give it a kubeconfig whose
   current context selects this cluster, and supply the exact relay namespace. Replace
   the sample hostname and namespace below with the internal config's values.

   ```bash
   fleet_host=relay.fleet.example.net
   fleet_namespace=nostr-relay
   fleet_home="$HOME/.nostr-mailbox-fleet"
   kubectl config current-context
   nostr-mailbox --home "$fleet_home" --persona fleet-operator setup \
     --relay "wss://$fleet_host" --campaign fleet --kubectl --namespace "$fleet_namespace"
   nostr-mailbox --home "$fleet_home" --persona fleet-operator relay check
   nostr-mailbox --home "$fleet_home" --persona fleet-operator invite --code-file "$HOME/fleet.invite"
   ```

Send the invite privately. The recipient can use the mailbox CLI with the invite file
or the join link. Browser onboarding at the relay's `/join/` path is available on the
Cloudflare target. [Member access and compatibility](relay-protocol.md)
