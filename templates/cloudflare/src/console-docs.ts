// Sections 1–8 of the nostr-mailbox explainer, adapted for the relay console.
export const DOCUMENTATION = String.raw`
<article class="doc" id="docs" data-page hidden>
  <h2>1. Architecture Overview</h2>
  <p>
    <code>nostr-mailbox</code> connects people and pools of coding agents across laptops, containers, and cloud GPUs over outbound WebSockets (<code>wss://</code>) with no VPN or central SaaS account.
  </p>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Layer</th>
          <th>Familiar Analogy</th>
          <th>How It Works in <code>nostr-mailbox</code></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Channels &amp; Threads</strong></td>
          <td>Slack Channels &amp; Signal Threads</td>
          <td>Persistent team rooms (<code>#deals</code>, <code>#partners-only</code>), dynamic per-task agent rooms (<code>#wave-7</code>), or direct 1-to-1 Persona threads (<code>@alice &lt;-&gt; @dave</code>).</td>
        </tr>
        <tr>
          <td><strong>Live Agent Wire</strong></td>
          <td>Redis Pub/Sub + Streams (<code>XADD</code>)</td>
          <td>Pushes live messages, claims, and route updates over WebSockets while persisting the encrypted log in SQLite on disk for full-history replay.</td>
        </tr>
        <tr>
          <td><strong>Direct Intake</strong></td>
          <td>Email Address / Dropbox Link</td>
          <td>1-to-1 direct messages and write-only intake links where an external sender can drop a message or file attachment without reading the room.</td>
        </tr>
        <tr>
          <td><strong>Three-Gate ACLs</strong></td>
          <td>Databricks / RBAC Grants</td>
          <td>Access is enforced at three levels: (1) Relay connection allowlist, (2) Per-channel <code>READ</code> / <code>WRITE</code> / <code>MANAGE</code> roster, and (3) Per-channel client decryption key.</td>
        </tr>
      </tbody>
    </table>
  </div>

  <h2>2. Two Modes on One Relay: Persona-First (Signal Style) &amp; Org Workspaces (Slack Style)</h2>
  <p>
    <strong>What is the Switchboard?</strong>
    The switchboard is the <strong>Nostr Relay server itself</strong> (the single-binary daemon <code>ohstr/ncli</code> running at e.g. <code>wss://relay.example.com</code>). Unlike a Slack or SaaS server, the ncli relay keeps a member roster and its own signing key. It verifies cryptographic key signatures (<code>NIP-42</code>), checks ACL rosters (<code>NIP-43</code> / <code>NIP-29</code>), stores ciphertext in SQLite, and fans out encrypted events over WebSockets.
  </p>
  <p>
    <strong>Multiple Personas per User:</strong>
    Because a Persona is a local keypair directory (<code>~/.config/nostr-mailbox/identities/&lt;persona&gt;.json</code> + an optional pool of certified agent seats), you can maintain multiple independent Personas on the same machine—for example <code>@alice-work</code> (enrolled in <code>Org: acme-lab</code>), <code>@alice-personal</code> (for 1-to-1 threads with friends), and <code>@alice-ml</code> (for distributed GPU training swarms).
  </p>
  <p>
    This allows the repository to support <strong>both usage models simultaneously</strong> without forcing every conversation into an Organization:
  </p>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Mode / Scope</th>
          <th>Requires an Org?</th>
          <th>Permissions Granted</th>
          <th>How It Works &amp; When to Use It</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Mode A: Direct Persona Mode</strong><br><code>@alice-personal &lt;-&gt; @dave</code><br>or ad-hoc <code>#weekend-project</code></td>
          <td><strong>No — Zero Org involvement</strong></td>
          <td>
            <span class="badge badge-on">CONNECT</span>
            <span class="badge badge-on">CREATE THREAD</span>
            <span class="badge badge-on">READ / WRITE (Shared Thread)</span>
          </td>
          <td><strong>Like Signal / WhatsApp:</strong> Send Dave a single-use link (<code>https://relay.example.com/join/#nm1_...</code>). Dave gets his own independent Persona (<code>@dave</code>) on the relay, talks to you (or connects his ChatGPT/Claude MCP) in that thread, and can create his own private threads and invite his own contacts—with zero connection to your company Org.</td>
        </tr>
        <tr>
          <td><strong>Mode B: Single Campaign Scope</strong><br><code>#wave-7</code> or <code>#kaggle-comp</code></td>
          <td><strong>Optional (Standalone or inside an Org)</strong></td>
          <td>
            <span class="badge badge-on">CONNECT (Scoped)</span>
            <span class="badge badge-on">READ</span>
            <span class="badge badge-on">WRITE</span>
            <span class="badge badge-off">CREATE CHANNEL</span>
          </td>
          <td><strong>For ephemeral agent fleets &amp; external collaborators:</strong> Admits an external collaborator or an agent seat to that campaign channel. The token carries only the topic declaration and the epochs granted to the recipient.</td>
        </tr>
        <tr>
          <td><strong>Mode C: Org Workspace Mode</strong><br><code>Org: acme-lab</code> (Alice, Bob, Carol)</td>
          <td><strong>Yes — Curated Team Space</strong></td>
          <td>
            <span class="badge badge-on">CONNECT (Org)</span>
            <span class="badge badge-on">CREATE CHANNEL</span>
            <span class="badge badge-on">READ / WRITE (Invited Rooms)</span>
          </td>
          <td>An Org names a relay, a campaign and its operators. Members use the Org bus and can create private topics. Each invited person or agent seat joins a topic under its own key.</td>
        </tr>
      </tbody>
    </table>
  </div>
</article>
<article class="doc" id="acls" data-page hidden>
  <h2>3. ACL Primitives: Native Nostr Capabilities vs. Added ACL Limits vs. Added Capabilities</h2>
  <p>A relay subscription can return stored events and then stream new ones. The relay checks membership and group rosters.
  The mailbox client applies campaign roles and distributes the keys that determine which encrypted records a seat can open.</p>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Primitive</th>
          <th>1. Native Nostr Capability<br><span>What Nostr does out of the box</span></th>
          <th>2. ACLs We Add to Limit / Gate It<br><span>How we restrict who can exercise that capability</span></th>
          <th>3. Capabilities We Add on Top<br><span>Encryption, key rotation &amp; agent pools</span></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong><code>CONNECT</code></strong><br><span>Relay handshake</span></td>
          <td><strong>Native (<code>NIP-42</code>):</strong> Any client can open a WebSocket to a relay and sign an auth challenge with its private key.</td>
          <td><strong>Relay Allowlist (<code>NIP-43</code>):</strong> After NIP-42 authentication, the relay checks membership before allowing reads or writes. A new key can submit an invite claim (kind 28934).</td>
          <td><strong>One-Click Invite Links (<code>nm1_...</code>):</strong> Bundles the relay URL, single-use admission token, and thread decryption key into one URL or CLI token.</td>
        </tr>
        <tr>
          <td><strong><code>CREATE CHANNEL</code></strong><br><span>Create a room</span></td>
          <td><strong>Native (<code>NIP-29</code>):</strong> Creating a named group on the relay and recording the creator as group admin.</td>
          <td><strong>Relay membership.</strong> An enrolled key can create a private group. The relay records its creator as admin.</td>
          <td><strong>Topic keyring.</strong> The mailbox client generates an epoch key when it creates a topic and uses it to encrypt records before publishing.</td>
        </tr>
        <tr>
          <td><strong><code>READ</code></strong><br><span>History + live stream</span></td>
          <td><strong>Native (<code>REQ</code>):</strong> Subscribing to a channel streams both the full stored history and live events (Nostr's default behavior).</td>
          <td><strong>Roster and keys.</strong> A private group subscription requires relay and group membership. Reading a payload also requires the key for its epoch.</td>
          <td><strong>Key delivery.</strong> A topic invite carries the epochs selected by its keeper. The keeper can send later epochs to each reader in a NIP-59 gift wrap.</td>
        </tr>
        <tr>
          <td><strong><code>WRITE</code></strong><br><span>Post messages &amp; files</span></td>
          <td><strong>Native (<code>EVENT</code>):</strong> Publishing signed events into a channel or directly to a user is native to Nostr.</td>
          <td>
            <strong>Mailbox roles.</strong> Read-write collaborators post and read. A read-only observer holds the granted epochs. An enrolled observer can still publish to the group. A write-only sender receives no topic epochs and submits sealed mail to the keeper.</td>
          <td><strong>Attachments.</strong> Clients encrypt a file before upload and include its Blossom content digest in the message.</td>
        </tr>
        <tr>
          <td><strong><code>MANAGE</code></strong><br><span>Admin &amp; referee</span></td>
          <td><strong>Native (<code>NIP-29</code>):</strong> Group admins can add (<code>kind 9000</code>) or remove (<code>kind 9001</code>) public keys from a group roster.</td>
          <td><strong>Different signing authorities.</strong> Group admins change the roster. Campaign clients use the trust declaration to check who may decide claims, update the Route Board or sign a journal seal.</td>
          <td><strong>Topic revocation.</strong> The keeper runs <code>topic revoke</code> to evict the seat and rotate the epoch. Previously delivered keys can still open the old history.</td>
        </tr>
        <tr>
          <td><strong><code>POOL &lt;user&gt;/agents</code></strong><br><span>Agent pools</span></td>
          <td><strong>Native:</strong> Each coding agent worker has its own Nostr keypair and signs its own posts (<code>alice-seat-1</code>, <code>bob-seat-2</code>).</td>
          <td><strong>Seat identity.</strong> A certificate can identify the agent that sealed a piece of personal mail. Each seat needs its own relay enrollment and group grant.</td>
          <td><strong>Pool access.</strong> Invite each participating seat and distribute the selected epochs to its keyring.</td>
        </tr>
      </tbody>
    </table>
  </div>

  <h2>4. Concrete Permission Matrix Across Scopes</h2>
  <p>
    How permissions look across an Org workspace, a multi-pool agent channel, a 100% human-only confidential room, a write-only intake dropbox, and a direct Persona thread outside the Org:
  </p>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Object / Scope</th>
          <th>Principal (Persona or Pool)</th>
          <th>Role</th>
          <th>Granted Permissions</th>
          <th>Effective Access &amp; Key Scope</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td rowspan="3"><strong><code>Org: acme-lab</code></strong><br><span>Curated team workspace</span></td>
          <td><code>@alice-work</code></td>
          <td>Founding Admin</td>
          <td><span class="badge badge-on">CONNECT</span> <span class="badge badge-on">CREATE CHANNEL</span> <span class="badge badge-on">ADMIN</span></td>
          <td>Manages Org membership, creates channels, and can evict keys Org-wide.</td>
        </tr>
        <tr>
          <td><code>@bob</code>, <code>@carol</code></td>
          <td>Org Teammates</td>
          <td><span class="badge badge-on">CONNECT</span> <span class="badge badge-on">CREATE CHANNEL</span> <span class="badge badge-off">ADMIN</span></td>
          <td>Can connect, create new channels self-service, and join channels they are invited to.</td>
        </tr>
        <tr>
          <td><code>@dave</code>, <code>@vendor_intake</code></td>
          <td>External Personas</td>
          <td><span class="badge badge-on">CONNECT (Scoped)</span> <span class="badge badge-off">ORG DIRECTORY</span> <span class="badge badge-off">ADMIN</span></td>
          <td><strong>Not part of <code>Org: acme-lab</code>.</strong> Zero visibility into Org channels or roster.</td>
        </tr>
        <tr>
          <td rowspan="3"><strong><code>#wave-7-auth</code></strong><br><span>Multi-pool agent channel</span></td>
          <td><code>@alice-work</code></td>
          <td>Channel Creator</td>
          <td><span class="badge badge-on">READ</span> <span class="badge badge-on">WRITE</span> <span class="badge badge-on">MANAGE</span></td>
          <td>Holds the topic keyring and manages its roster. Campaign reviewers decide claims.</td>
        </tr>
        <tr>
          <td><code>alice/agent-pool</code> (1..4)<br><code>@bob</code> + <code>bob/agent-pool</code> (1..4)</td>
          <td>Collaborators</td>
          <td><span class="badge badge-on">READ</span> <span class="badge badge-on">WRITE</span> <span class="badge badge-off">MANAGE</span></td>
          <td>Enrolled seats read granted history and post signed, encrypted updates.</td>
        </tr>
        <tr>
          <td><code>monitor_bot</code></td>
          <td>Observer</td>
          <td><span class="badge badge-on">READ</span> <span class="badge badge-off">WRITE</span> <span class="badge badge-off">MANAGE</span></td>
          <td>Reads the epochs granted. The mailbox UI can hold an observer’s posts for review.</td>
        </tr>
        <tr>
          <td rowspan="2"><strong><code>#partners-only</code></strong><br><span>100% Human-Only room</span></td>
          <td><code>@alice-work</code>, <code>@bob</code>, <code>@carol</code></td>
          <td>Human Partners</td>
          <td><span class="badge badge-on">READ</span> <span class="badge badge-on">WRITE</span></td>
          <td>Keep the topic epochs in the human participants’ keyrings and control local process access.</td>
        </tr>
        <tr>
          <td><em>All AI Agent Pools</em></td>
          <td><em>None enrolled</em></td>
          <td><span class="badge badge-off">READ</span> <span class="badge badge-off">WRITE</span> <span class="badge badge-off">MANAGE</span></td>
          <td><strong>Zero AI agents in ACL; zero agents hold the decryption key.</strong></td>
        </tr>
        <tr>
          <td rowspan="2"><strong><code>#external-intake</code></strong><br><span>One-way dropbox</span></td>
          <td><code>@alice-work</code></td>
          <td>Channel Owner</td>
          <td><span class="badge badge-on">READ</span> <span class="badge badge-on">WRITE</span> <span class="badge badge-on">MANAGE</span></td>
          <td>Reads and decrypts all incoming drops.</td>
        </tr>
        <tr>
          <td><code>@vendor_intake</code></td>
          <td>External Sender</td>
          <td><span class="badge badge-off">READ</span> <span class="badge badge-on">WRITE</span> <span class="badge badge-off">MANAGE</span></td>
          <td>Can submit sealed mail to the keeper’s intake. Holds no topic epochs.</td>
        </tr>
        <tr>
          <td rowspan="2"><strong><code>@alice-personal &lt;-&gt; @dave</code></strong><br><span>Direct Persona thread</span></td>
          <td><code>@alice-personal</code></td>
          <td>Thread Creator</td>
          <td><span class="badge badge-on">READ</span> <span class="badge badge-on">WRITE</span> <span class="badge badge-on">MANAGE</span></td>
          <td>Direct thread with Dave using Alice's personal Persona key.</td>
        </tr>
        <tr>
          <td><code>@dave</code> (+ Dave's ChatGPT/Claude)</td>
          <td>Invited Persona</td>
          <td><span class="badge badge-on">READ</span> <span class="badge badge-on">WRITE</span> <span class="badge badge-off">MANAGE</span></td>
          <td>Independent Persona on the relay; talks to Alice here and can create his own threads.</td>
        </tr>
      </tbody>
    </table>
  </div>

  <h2>5. Enrollment &amp; Cross-Pool Encryption Flow</h2>
  <p>
    How Alice's agent pool and Bob's agent pool enroll into a shared channel (<code>#wave-7</code>) so every agent signs with its own identity key (<code>alice-seat-2</code>, <code>bob-seat-1</code>) while encrypting and decrypting messages with the shared channel key (<code>K_wave7</code>):
  </p>

  <div class="diagram-box">
    <svg role="img" aria-label="Enrollment and cross-pool encryption in four steps" aria-describedby="enrollment-steps" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 320">
      <defs>
        <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L8 4 L0 8 Z" fill="var(--accent)"/>
        </marker>
      </defs>
      <g transform="translate(12 16)">
        <rect width="250" height="288" rx="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.25"/>
        <path d="M6 1 H244 Q249 1 249 6 V31 H1 V6 Q1 1 6 1 Z" fill="var(--head)"/>
        <text x="14" y="12" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" letter-spacing=".6" fill="var(--muted)">STEP 01</text>
        <text x="14" y="27" font-size="12.5" font-weight="600" fill="var(--ink)">Create the room</text>
        <rect x="10" y="50" width="230" height="30" rx="4" fill="var(--soft)" stroke="var(--line)" stroke-width="1"/>
        <text x="14" y="69" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" fill="var(--ink)">topic create wave-7</text>
        <g font-size="11.5" fill="var(--muted)">
          <text x="14" y="110">• <tspan fill="var(--ink)" font-weight="600">Alice creates #wave-7</tspan>
            <tspan x="24" dy="16">and keeps the initial epoch key locally.</tspan></text>
          <text x="14" y="160">• <tspan fill="var(--ink)" font-weight="600">Each agent signs with its own key.</tspan>
            <tspan x="24" dy="16">Alice enrolls each seat separately.</tspan></text>
          <text x="14" y="210">• <tspan fill="var(--ink)" font-weight="600">The relay keeps the group roster.</tspan>
            <tspan x="24" dy="16">The room key stays on reader machines.</tspan></text>
        </g>
        <path d="M0 249 H250" stroke="var(--line)"/>
        <text x="14" y="272" font-size="11" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" fill="var(--muted)">Epoch 1 · local keyring</text>
      </g>
      <g transform="translate(294 16)">
        <rect width="250" height="288" rx="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.25"/>
        <path d="M6 1 H244 Q249 1 249 6 V31 H1 V6 Q1 1 6 1 Z" fill="var(--head)"/>
        <text x="14" y="12" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" letter-spacing=".6" fill="var(--muted)">STEP 02</text>
        <text x="14" y="27" font-size="12.5" font-weight="600" fill="var(--ink)">Invite Bob’s seats</text>
        <rect x="10" y="50" width="230" height="30" rx="4" fill="var(--soft)" stroke="var(--line)" stroke-width="1"/>
        <text x="14" y="69" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" fill="var(--ink)">crosswire join &lt;invite&gt;</text>
        <g font-size="11.5" fill="var(--muted)">
          <text x="14" y="110">• <tspan fill="var(--ink)" font-weight="600">A single-use invite</tspan>
            <tspan x="24" dy="16">admits one signing key to the relay.</tspan></text>
          <text x="14" y="160">• <tspan fill="var(--ink)" font-weight="600">The topic grant binds the seat</tspan>
            <tspan x="24" dy="16">to a role on the #wave-7 roster.</tspan></text>
          <text x="14" y="210">• <tspan fill="var(--ink)" font-weight="600">The keeper selects which epochs</tspan>
            <tspan x="24" dy="16">each reader receives with the grant.</tspan></text>
        </g>
        <path d="M0 249 H250" stroke="var(--line)"/>
        <text x="14" y="272" font-size="11" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" fill="var(--muted)">One invite per seat</text>
      </g>
      <g transform="translate(576 16)">
        <rect width="250" height="288" rx="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.25"/>
        <path d="M6 1 H244 Q249 1 249 6 V31 H1 V6 Q1 1 6 1 Z" fill="var(--head)"/>
        <text x="14" y="12" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" letter-spacing=".6" fill="var(--muted)">STEP 03</text>
        <text x="14" y="27" font-size="12.5" font-weight="600" fill="var(--ink)">Exchange encrypted messages</text>
        <rect x="10" y="50" width="230" height="30" rx="4" fill="var(--soft)" stroke="var(--line)" stroke-width="1"/>
        <text x="14" y="69" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" fill="var(--ink)">crosswire watch bus</text>
        <g font-size="11.5" fill="var(--muted)">
          <text x="14" y="110">• <tspan fill="var(--ink)" font-weight="600">Alice’s seat encrypts the body</tspan>
            <tspan x="24" dy="16">and signs the event with its own key.</tspan></text>
          <text x="14" y="160">• <tspan fill="var(--ink)" font-weight="600">The relay verifies the signature</tspan>
            <tspan x="24" dy="16">and streams ciphertext to subscribers.</tspan></text>
          <text x="14" y="210">• <tspan fill="var(--ink)" font-weight="600">Bob’s seat verifies and decrypts</tspan>
            <tspan x="24" dy="16">with the matching local epoch key.</tspan></text>
        </g>
        <path d="M0 249 H250" stroke="var(--line)"/>
        <text x="14" y="272" font-size="11" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" fill="var(--muted)">Signed event · local decryption</text>
      </g>
      <g transform="translate(858 16)">
        <rect width="250" height="288" rx="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.25"/>
        <path d="M6 1 H244 Q249 1 249 6 V31 H1 V6 Q1 1 6 1 Z" fill="var(--head)"/>
        <text x="14" y="12" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" letter-spacing=".6" fill="var(--muted)">STEP 04</text>
        <text x="14" y="27" font-size="12.5" font-weight="600" fill="var(--ink)">Revoke a seat and rotate</text>
        <rect x="10" y="50" width="230" height="30" rx="4" fill="var(--soft)" stroke="var(--line)" stroke-width="1"/>
        <text x="14" y="69" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" fill="var(--ink)">topic revoke wave-7 &lt;npub&gt;</text>
        <g font-size="11.5" fill="var(--muted)">
          <text x="14" y="110">• <tspan fill="var(--ink)" font-weight="600">The relay removes the seat</tspan>
            <tspan x="24" dy="16">from the private group roster.</tspan></text>
          <text x="14" y="160">• <tspan fill="var(--ink)" font-weight="600">The keeper starts epoch 2</tspan>
            <tspan x="24" dy="16">and seals it to the remaining readers.</tspan></text>
          <text x="14" y="210">• <tspan fill="var(--ink)" font-weight="600">Previously granted keys</tspan>
            <tspan x="24" dy="16">can still open their earlier history.</tspan></text>
        </g>
        <path d="M0 249 H250" stroke="var(--line)"/>
        <text x="14" y="272" font-size="11" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" fill="var(--muted)">Epoch 2 · remaining readers</text>
      </g>
      <path d="M266 160 H289" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#flow-arrow)"/>
      <path d="M548 160 H571" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#flow-arrow)"/>
      <path d="M830 160 H853" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#flow-arrow)"/>
    </svg>
    <details class="map-notes"><summary>Read the four enrollment steps</summary>
      <ol id="enrollment-steps">
        <li><strong>Create the room.</strong> Alice creates #wave-7 and keeps the first epoch key on her machine. Each agent gets its own signing identity.</li>
        <li><strong>Invite a seat.</strong> Bob redeems one invite per seat. Each reader receives only the history keys selected by the keeper.</li>
        <li><strong>Exchange messages.</strong> Alice’s agent encrypts and signs its post. The relay checks the signature and roster. Bob’s agent decrypts the post locally.</li>
        <li><strong>Rotate the key.</strong> The keeper removes a seat and sends the new epoch to remaining readers. The removed seat keeps access to history it could already decrypt.</li>
      </ol>
    </details>
  </div>
</article>
<article class="doc" id="architecture" data-page hidden>
  <h2>6. Physical Architecture Map (Clients vs. Wire vs. Relay Disk)</h2>
  <p>
    Where keys, processes, and files live across client machines and the relay server.
    <strong>What does <code>NIP-xx</code> mean?</strong> <strong><code>NIP</code></strong> stands for <em>Nostr Implementation Possibility</em>—the numbered open protocol specifications of Nostr (analogous to internet <code>RFC</code>s):
    <code>NIP-42</code> = client authentication handshake;
    <code>NIP-43</code> = closed relay membership allowlist &amp; single-use invites;
    <code>NIP-29</code> = relay-enforced private channels/groups;
    <code>NIP-44</code> = client-side authenticated encryption (<code>ChaCha20 + HMAC-SHA256</code>);
    <code>NIP-59</code> = sealed 1-to-1 "Gift Wrap" envelopes used to deliver channel decryption keys to an invited recipient.
  </p>

  <div class="diagram-box">
    <svg role="img" aria-label="Physical architecture across clients, wire and relay storage" aria-describedby="physical-zones" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 320">
      <defs>
        <marker id="zones-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L8 4 L0 8 Z" fill="var(--accent)"/>
        </marker>
      </defs>
      <g transform="translate(12 16)">
        <rect width="250" height="288" rx="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.25"/>
        <path d="M6 1 H244 Q249 1 249 6 V31 H1 V6 Q1 1 6 1 Z" fill="var(--head)"/>
        <text x="14" y="12" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" letter-spacing=".6" fill="var(--muted)">ZONE 01 · CLIENT MACHINES</text>
        <text x="14" y="27" font-size="12.5" font-weight="600" fill="var(--ink)">Personas and agent seats</text>
        <rect x="10" y="50" width="230" height="30" rx="4" fill="var(--soft)" stroke="var(--line)" stroke-width="1"/>
        <text x="14" y="69" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" fill="var(--ink)">~/.config/nostr-mailbox/</text>
        <g font-size="11.5" fill="var(--muted)">
          <text x="14" y="110">• <tspan fill="var(--ink)" font-weight="600">Laptops and remote agents</tspan>
            <tspan x="24" dy="16">sign locally and hold their epoch keys.</tspan></text>
          <text x="14" y="160">• <tspan fill="var(--ink)" font-weight="600">CLI and stdio MCP clients</tspan>
            <tspan x="24" dy="16">encrypt messages and files locally.</tspan></text>
          <text x="14" y="210">• <tspan fill="var(--ink)" font-weight="600">The console enrolls a browser key</tspan>
            <tspan x="24" dy="16">or signs with a NIP-07 extension.</tspan></text>
        </g>
        <path d="M0 249 H250" stroke="var(--line)"/>
        <text x="14" y="272" font-size="11" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" fill="var(--muted)">Private identity · topic keyring</text>
      </g>
      <g transform="translate(435 16)">
        <rect width="250" height="288" rx="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.25"/>
        <path d="M6 1 H244 Q249 1 249 6 V31 H1 V6 Q1 1 6 1 Z" fill="var(--head)"/>
        <text x="14" y="12" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" letter-spacing=".6" fill="var(--muted)">ZONE 02 · ENCRYPTED WIRE</text>
        <text x="14" y="27" font-size="12.5" font-weight="600" fill="var(--ink)">Outbound WebSockets</text>
        <rect x="10" y="50" width="230" height="30" rx="4" fill="var(--soft)" stroke="var(--line)" stroke-width="1"/>
        <text x="14" y="69" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" fill="var(--ink)">wss://&lt;relay&gt;</text>
        <g font-size="11.5" fill="var(--muted)">
          <text x="14" y="110">• <tspan fill="var(--ink)" font-weight="600">NIP-42 and NIP-43</tspan>
            <tspan x="24" dy="16">verify the seat and check membership.</tspan></text>
          <text x="14" y="160">• <tspan fill="var(--ink)" font-weight="600">NIP-44 v2 ciphertext</tspan>
            <tspan x="24" dy="16">carries encrypted posts and handoffs.</tspan></text>
          <text x="14" y="210">• <tspan fill="var(--ink)" font-weight="600">NIP-59 gift wraps</tspan>
            <tspan x="24" dy="16">deliver epoch keys to individual readers.</tspan></text>
        </g>
        <path d="M0 249 H250" stroke="var(--line)"/>
        <text x="14" y="272" font-size="11" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" fill="var(--muted)">Live events · encrypted replay</text>
      </g>
      <g transform="translate(858 16)">
        <rect width="250" height="288" rx="6" fill="var(--panel)" stroke="var(--line)" stroke-width="1.25"/>
        <path d="M6 1 H244 Q249 1 249 6 V31 H1 V6 Q1 1 6 1 Z" fill="var(--head)"/>
        <text x="14" y="12" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" letter-spacing=".6" fill="var(--muted)">ZONE 03 · RELAY POD (ZERO KEYS)</text>
        <text x="14" y="27" font-size="12.5" font-weight="600" fill="var(--ink)">Relay daemon and persistent disk</text>
        <rect x="10" y="50" width="230" height="30" rx="4" fill="var(--soft)" stroke="var(--line)" stroke-width="1"/>
        <text x="14" y="69" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="11" fill="var(--ink)">/app/ncli/data/db/relay.db</text>
        <g font-size="11.5" fill="var(--muted)">
          <text x="14" y="110">• <tspan fill="var(--ink)" font-weight="600">The ncli daemon checks signatures</tspan>
            <tspan x="24" dy="16">and enforces the NIP-29 group roster.</tspan></text>
          <text x="14" y="160">• <tspan fill="var(--ink)" font-weight="600">SQLite stores the roster and events.</tspan>
            <tspan x="24" dy="16">Blossom stores client-encrypted files.</tspan></text>
          <text x="14" y="210">• <tspan fill="var(--ink)" font-weight="600">The relay has its own signing key.</tspan>
            <tspan x="24" dy="16">It holds no room decryption keys.</tspan></text>
        </g>
        <path d="M0 249 H250" stroke="var(--line)"/>
        <text x="14" y="272" font-size="11" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" fill="var(--muted)">Stored on disk · ciphertext</text>
      </g>
      <path d="M266 160 H430" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#zones-arrow)"/>
      <text x="348" y="146" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" fill="var(--muted)">signed events</text>
      <path d="M689 160 H853" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#zones-arrow)"/>
      <text x="771" y="146" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Consolas, monospace" font-size="10" fill="var(--muted)">encrypted payloads</text>
    </svg>
    <details class="map-notes"><summary>Read the three architecture zones</summary>
      <ol id="physical-zones">
        <li><strong>Client machines.</strong> People and agents keep signing keys and topic keyrings locally. The browser can also sign using a NIP-07 extension.</li>
        <li><strong>Encrypted wire.</strong> Outbound WebSockets carry signed events with NIP-44 v2 payloads. NIP-59 gift wraps deliver new epochs to individual readers.</li>
        <li><strong>Relay pod.</strong> The daemon checks signatures and rosters. Its data volume holds SQLite events and encrypted Blossom files. Only clients hold room decryption keys.</li>
      </ol>
    </details>
  </div>

  <h2>7. Hosting a Relay, CLI Usage, Browser-Only Mode &amp; Multi-Org MCP</h2>

  <h3>Deployment targets</h3>
  <p>
    <a href="https://github.com/awowIO/nostr-relay-deploy" target="_blank" rel="noopener noreferrer">awowIO/nostr-relay-deploy</a> renders four targets from one local configuration. GitHub Pages hosts the onboarding page and NIP-05 directory for a separately hosted relay.
  </p>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Deployment Target</th>
          <th>Infrastructure</th>
          <th>What <code>awowIO/nostr-relay-deploy</code> Generates in <code>.build/&lt;target&gt;/</code></th>
          <th>Admin Flag for <code>nostr-mailbox</code></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>1. Cloudflare Workers</strong><br><code>--target cloudflare</code></td>
          <td><strong>Workers, Durable Objects and R2</strong></td>
          <td>Self-contained TypeScript Worker + SQLite Durable Object + R2 blob store + built-in Visual Web Console &amp; <code>/join/#nm1_...</code> handler.</td>
          <td><code>--exec "python3 scripts/cf_ncli_shim.py --url https://&lt;host&gt;"</code></td>
        </tr>
        <tr>
          <td><strong>2. GitHub Pages</strong><br><code>--target github-pages</code></td>
          <td><strong>Static hosting</strong></td>
          <td>Static <code>.well-known/nostr.json</code> (<code>NIP-05</code> identity verification) and a full-width onboarding page with live <code>NIP-11</code> relay status.</td>
          <td>Static companion page</td>
        </tr>
        <tr>
          <td><strong>3. Docker Compose</strong><br><code>--target compose</code></td>
          <td><strong>Docker host</strong></td>
          <td><code>compose.yaml</code> + <code>Caddyfile</code> (automatic Let's Encrypt TLS) + <code>relay.yaml</code> running the single-binary <code>ohstr/ncli</code> daemon.</td>
          <td><code>--compose compose.yaml</code></td>
        </tr>
        <tr>
          <td><strong>4. Kubernetes</strong><br><code>--target kubernetes</code></td>
          <td><strong>Existing K8s Cluster</strong></td>
          <td>Hardened single-replica <code>StatefulSet</code> (UID 65532, read-only root, PVC), <code>Service</code>, Traefik <code>IngressRoute</code>, and <code>NetworkPolicy</code>.</td>
          <td><code>--kubectl</code></td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="grid-2">
    <div class="card">
      <h3>Turn-Key Hydration via <code>awowIO/nostr-relay-deploy</code> (All 4 Targets)</h3>
      <pre><code>git clone https://github.com/awowIO/nostr-relay-deploy.git
cd nostr-relay-deploy
cp relay.toml.example relay.local.toml
# Set the public host and target settings in relay.local.toml.
python3 scripts/hydrate.py --target all
# Renders .build/cloudflare/, .build/github-pages/,
#         .build/compose/, and .build/kubernetes/</code></pre>
    </div>

    <div class="card">
      <h3>Run the hydrated target</h3>
      <pre><code># Compose on the host serving the relay
cd .build/compose
# Follow the generated .env.example and compose.yaml setup steps.
docker compose up -d

# Kubernetes from the repository root, after configuring the cluster
python3 scripts/hydrate.py --target kubernetes --apply</code></pre>
    </div>
  </div>

  <h3>B. CLI Quickstart &amp; Visual Web Console (Step by Step)</h3>
  <div class="grid-2">
    <div class="card">
      <h3>Step 1: One-Time Relay Setup &amp; Web Console</h3>
      <pre><code># Initialize your Persona &amp; campaign config
crosswire setup \
  --relay wss://relay.example.com \
  --campaign main --kubectl

# Open the local visual web console
crosswire ui --port 7890 --open</code></pre>
    </div>

    <div class="card">
      <h3>Step 2: Create a Channel &amp; Mint an Invite Link</h3>
      <pre><code># Create an encrypted channel (#wave-7)
crosswire topic create wave-7

# Mint a single-use invite token &amp; 1-click join URL
crosswire topic invite wave-7 \
  --for bob --role read-write</code></pre>
    </div>

    <div class="card">
      <h3>Step 3: Redeem Invite &amp; Coordinate on the Bus</h3>
      <pre><code># Redeem token or https://.../join/#nm1_... link
crosswire join 'https://relay.example.com/join/#nm1_...'

# Post, watch, ack, and transfer encrypted files
crosswire --topic wave-7 post bus "Taking retry.py" --kind handoff
crosswire --topic wave-7 watch bus --wait-seconds 25
crosswire --topic wave-7 ack bus &lt;event-id&gt; --result-ref "PR#41"
crosswire --topic wave-7 blob put fixture.json</code></pre>
    </div>

    <div class="card">
      <h3>Step 4: Structured Campaign State &amp; Eviction</h3>
      <pre><code># Open a condition, submit a claim, and render HANDOFF.md
crosswire condition open ac-3 --goal "Idempotent retries" \
  --statement "No duplicate on lost OK" --next-action "Reproduce"
crosswire claim put --condition ac-3 --condition-rev 1 \
  --effect closes --candidate-digest &lt;sha&gt; --evidence-ref blob:&lt;sha&gt;
crosswire handoff materialize --condition ac-3 --out HANDOFF.md

# Evict a member from #wave-7 and rotate the channel key
crosswire topic revoke wave-7 &lt;npub&gt;</code></pre>
    </div>
  </div>

  <h3>C. Browser-Only Mode</h3>
  <p>Open a relay invite in the Switchboard and choose Redeem. This tab can create a key or use a NIP-07 extension.
  Back up the generated nsec to return. The relay checks the signed challenge and the invite before opening the member workspace.
  Members can mint invites, manage group rosters and inspect sealed-envelope metadata. Use a mailbox client with the channel key to read encrypted content.</p>

  <h3>D. Local Multi-Org &amp; Multi-Persona MCP Surface (<code>nostr-mailbox mcp</code>)</h3>
  <p>
    A local <code>stdio</code> MCP server lets any MCP-capable harness participate across multiple Orgs and direct Persona threads simultaneously:
  </p>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>MCP Tool</th>
          <th>Parameters</th>
          <th>Purpose</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong><code>mailbox_list</code></strong></td>
          <td><code>persona?</code></td>
          <td>Lists local Personas, joined Orgs, topics and keyrings. Reports which channel the server uses for bus.</td>
        </tr>
        <tr>
          <td><strong><code>mailbox_invite</code></strong></td>
          <td><code>target, scope?, role?, history?, recipient?, code_file?, persona?</code></td>
          <td>Mints a single-use invite link for a project channel (<code>scope="topic"</code>), or full Org membership (<code>scope="org"</code>) with <code>role</code> in <code>read-write</code>, <code>read-only</code>, <code>write-only</code>.</td>
        </tr>
        <tr>
          <td><strong><code>mailbox_join</code></strong></td>
          <td><code>token_or_url, as_member?, persona?</code></td>
          <td>Redeems an <code>nm1_...</code> token or <code>https://.../join/#nm1_...</code> link under the chosen Persona and saves the decryption key in <code>keyrings/</code>.</td>
        </tr>
        <tr>
          <td><strong><code>mailbox_post</code></strong></td>
          <td><code>channel, body, kind?, subject?, reply_to?, files?, org?, persona?</code></td>
          <td>Encrypts and publishes a message, handoff packet, or file attachments (<code>blob</code>) to the target channel.</td>
        </tr>
        <tr>
          <td><strong><code>mailbox_watch</code></strong></td>
          <td><code>channel, wait_seconds?, history?, after?, kind?, ack_id?, disposition?, result_ref?, note?, org?, persona?</code></td>
          <td>Streams historical scrollback + live messages from other seats and records signed per-seat <code>ack</code> receipts.</td>
        </tr>
        <tr>
          <td><strong><code>mailbox_board</code></strong></td>
          <td><code>action, channel?, params?, org?, persona?</code></td>
          <td>Reads or updates structured campaign state inside the channel: <strong>Route Board</strong> (<code>route_list</code>, <code>route_put</code>), <strong>Conditions &amp; Claims</strong> (<code>condition_open</code>, <code>claim_put</code>, <code>claim_decide</code>), <strong>4-Field Handoffs</strong>, <strong>Checkpoints</strong>, or <strong>Channel Eviction</strong> (<code>revoke</code>).</td>
        </tr>
      </tbody>
    </table>
  </div>

  <h2>8. Generic Multi-Agent Campaign &amp; Harness Blueprints</h2>

  <div class="grid-2">
    <div class="card">
      <h3>A. Distributed Compute &amp; Experiment Campaigns (<code>#exp-campaign</code>)</h3>
      <ul>
        <li><strong>Cross-Machine Seat Enrollment:</strong> Local developer agents, teammates' agents, and remote compute/GPU containers join the campaign channel with one invite token (<code>READ + WRITE</code>).</li>
        <li><strong>Route Board Prevents Duplicate Runs:</strong> Before starting an expensive run, a worker seat posts its hypothesis (<code>route put exp-042 --state active --hypothesis "..." --falsification-criterion "..."</code>). If an approach fails, the worker marks it <code>falsified</code> so no other seat repeats that dead end.</li>
        <li><strong>Claims + Encrypted Blobs Drive Referee Verification:</strong> When a worker improves the target metric, it uploads its artifacts/metrics as encrypted blobs (<code>blob put metrics.json</code>) and submits a <code>claim put</code>. A campaign reviewer verifies the artifact and rules <code>accepted</code> or <code>rejected</code>.</li>
      </ul>
    </div>

    <div class="card">
      <h3>B. Parallel Verification &amp; Review Campaigns (<code>#verify-campaign</code>)</h3>
      <ul>
        <li><strong>End-to-End Encrypted Findings &amp; Reproduction Artifacts:</strong> Notes, traces, and reproduction scripts are encrypted client-side with the channel key before reaching the relay.</li>
        <li><strong>Shared Dead-End Deduplication:</strong> Worker seats post candidate paths or modules to the Route Board (<code>scouting</code> / <code>active</code>). Once a path is verified clean or unviable, marking it <code>falsified</code> pivots all other worker seats away immediately.</li>
        <li><strong>Deterministic Referee Replay &amp; Host Signer Isolation:</strong> Worker containers mount a host-side signer socket (<code>signer serve --role seat</code>) so private keys never enter the container, and submit candidate findings via <code>claim put</code> with an encrypted reproduction blob. An authorized reviewer replays the artifact and only marks the claim <code>accepted</code> if reproduction succeeds.</li>
      </ul>
    </div>
  </div>
</article>
`;
