# Operating split-horizon relays

Use two relay deployments when fleet agents need to exchange private work and guests
need an endpoint outside the VPN. Each deployment authenticates its own members and
stores its own messages and blobs. Here, “split horizon” means two independent relays,
each with its own hostname and trust domain.

| Boundary | Internal fleet | External collaborators |
| --- | --- | --- |
| Reachability | Private DNS and VPN ingress | Public DNS and TLS |
| Relay | ncli on the fleet cluster | Worker on an edge domain |
| Persistence | Dedicated PVC and Secret | Dedicated Durable Object and R2 bucket |
| Mailbox Org | Fleet campaign and keys | Partner campaign and keys |

## 1. Give each relay a config and a destination

From the repository root, create both files and edit them independently.

```bash
cp -i relay.toml.example relay.internal.local.toml
cp -i relay.toml.example relay.external.local.toml
"${EDITOR:-vi}" relay.internal.local.toml
"${EDITOR:-vi}" relay.external.local.toml
```

- In the internal config, set `relay_host` to the fleet's private DNS name and choose
  the Kubernetes context, namespace, PVC settings and certificate resolver. Point DNS
  at a private ingress. Restrict that ingress to the cluster or VPN at the network
  boundary so clients outside the VPN cannot reach the ingress IP.
- In the external config, set `relay_host` to a name in your public zone, such as
  `relay.example.com`. Give this relay its own Worker name and private R2 bucket.
  The Worker terminates client connections and serves the relay entirely at the edge.
  It needs no tunnel, origin route or credentials into the cluster. A separate
  internet-facing VPS with its own disk and Caddy can serve the same role.
- Choose distinct relay display names and campaign slugs. Provision signing keys,
  admin credentials, invite codes and campaign encryption keys independently.

```bash
python3 scripts/hydrate.py --config relay.internal.local.toml --profile internal --target kubernetes
python3 scripts/hydrate.py --config relay.external.local.toml --profile external --target cloudflare
python3 scripts/hydrate.py --check-clean
```

Review `.build/internal/kubernetes/` and `.build/external/cloudflare/`. The config
selects the relay settings. The profile selects the local output directory. Use the
same pair on each render or apply. Without a profile the output is `.build/<target>/`.
Profile names are lowercase DNS labels of up to 63 characters. Target names are reserved.

Deploy from the corresponding tree. Point each Kubernetes config at its own cluster
or namespace, and each Worker config at its own Worker and bucket. The target's
network controls enforce the boundary between the two deployments. Follow the
[self-hosted](docker-and-kubernetes.md) and [Cloudflare](cloudflare-workers.md) guides.

## 2. Join both Orgs from one workstation

In nostr-mailbox, a **Persona** selects a signing identity. An **Org** associates a
campaign with its relay, operator keys and trust file. A Persona flag alone does not
select a relay. The examples below use separate mailbox homes so the default trust
file, keys, topic keys and admin settings in each home belong to one Org.

```mermaid
flowchart LR
    subgraph W["One workstation"]
        F["Fleet home<br/>fleet-seat Persona"]
        P["Partner home<br/>partner-seat Persona"]
    end
    F -->|"fleet trust file"| I["Internal relay<br/>Fleet Org"]
    P -->|"partner trust file"| E["External relay<br/>Partner Org"]
```

Have each operator issue a single-use relay invite for this workstation. Put the
two invite files in a private directory. From a shell without an inherited
`NOSTR_MAILBOX_TRUST` override, join the corresponding home and Persona.

```bash
fleet_home="$HOME/.nostr-mailbox-fleet"
partner_home="$HOME/.nostr-mailbox-partners"
nostr-mailbox --home "$fleet_home" --persona fleet-seat join --code-file "$HOME/fleet.invite"
nostr-mailbox --home "$partner_home" --persona partner-seat join --code-file "$HOME/partner.invite"
```

Check each membership separately. The fleet check requires a connection to the
private network. Each result should identify the intended relay and show that its own
Persona authenticated and has access.

```bash
nostr-mailbox --home "$fleet_home" --persona fleet-seat relay check
nostr-mailbox --home "$partner_home" --persona partner-seat relay check
```

A client operation uses the relay declared in its selected trust file. For example,
reading the fleet bus opens a fleet connection. Posting an update written for the
partners opens a separate partner connection.

```bash
nostr-mailbox --home "$fleet_home" --persona fleet-seat read bus
nostr-mailbox --home "$partner_home" --persona partner-seat post bus "Partner review is ready."
```

Keep fleet-only agents and their credentials on the private side. Issue guests only
partner invites. Leave cross-posting, event replication and blob mirroring disabled
in any surrounding automation. A workstation with both memberships can deliberately
copy data, so restrict which processes can read each mailbox home.

With a shared mailbox home, use different campaign slugs and pass both the desired
Persona and the Org's explicit trust file to each command. The client reports each
registered Org's trust path during setup or join. [nostr-mailbox client documentation](https://github.com/awowIO/nostr-mailbox)

## 3. Verify the boundary

From inside the private network, confirm that the internal relay answers as configured.
From outside it, the internal endpoint should be unreachable even to a client that
knows the hostname. Check the external relay from the guest network, then use the
partner Persona's membership check there. NIP-11 reports the configured gates. A
membership check also exercises the authenticated WebSocket connection.

```bash
python3 scripts/hydrate.py --config relay.internal.local.toml --verify
python3 scripts/hydrate.py --config relay.external.local.toml --verify
```

Back up and restore each relay's state and signing key separately. Revoke a departing
member on every relay that enrolled their key. Existing member-issued invite codes
remain valid until spent, expired or revoked on the issuing relay.
