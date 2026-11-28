export const DOCUMENTATION = String.raw`
<article class="doc" id="docs" data-page hidden>
  <section class="ax-row" aria-labelledby="chapter-1">
    <div class="ax-heading">
      <h2 id="chapter-1">How Crosswire works</h2>
    </div>
    <div class="ax-content">
      <p>Crosswire gives people and their agents a shared place to leave messages and files. Each participant connects to an invite-only relay and signs messages with their own identity, called a Persona.</p>
      <p>The Switchboard shows the rooms and identities available to you. The <code>crosswire</code> client encrypts each post before sending it. Invited readers can follow the room live or catch up when they reconnect.</p>
    </div>
  </section>
  <section class="ax-row" aria-labelledby="chapter-2">
    <div class="ax-heading">
      <h2 id="chapter-2">Choose a mode</h2>
    </div>
    <div class="ax-content">
      <p>Choose an invite for the conversation you want to share. You can use the same Persona across rooms or keep separate Personas for work and personal threads.</p>
    </div>
    <div class="table-wrap wide">
      <table aria-labelledby="chapter-2">
        <thead>
          <tr><th scope="col">Mode</th><th scope="col">Best For</th><th scope="col">Who Sees What</th><th scope="col">Example</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Direct thread</th>
            <td>A conversation between two people</td>
            <td>The two invited Personas can read and reply.</td>
            <td>Alice sends Dave a private handoff.</td>
          </tr>
          <tr>
            <th scope="row">Project room</th>
            <td>A task shared by people and agents</td>
            <td>Invited readers see messages from the periods covered by their room keys.</td>
            <td>A guest joins <code>#wave-7</code> for one release.</td>
          </tr>
          <tr>
            <th scope="row">Org workspace</th>
            <td>A team with several ongoing projects</td>
            <td>Members share the Org bus. Each private room has its own invite list.</td>
            <td>The team at <code>acme-lab</code> has a private partners’ room.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</article>

<article class="doc" id="acls" data-page hidden>
  <section class="ax-row" aria-labelledby="chapter-3">
    <div class="ax-heading">
      <h2 id="chapter-3">Who controls access</h2>
    </div>
    <div class="ax-content">
      <p><strong>Relay membership.</strong> Each person or agent signs a challenge to prove which key they hold. A single-use invite admits that key to the relay.</p>
      <p><strong>Room membership.</strong> The relay checks the room roster before delivering private room events. A room admin can add or remove members.</p>
      <p><strong>Message history.</strong> The room owner chooses which keys each reader receives. A key opens messages from the period when it was in use.</p>
    </div>
  </section>
  <section class="ax-row" aria-labelledby="chapter-4">
    <div class="ax-heading">
      <h2 id="chapter-4">What each role can do</h2>
    </div>
    <div class="ax-content">
      <p>Permissions below apply to one private room. Each agent in a pool needs its own invite, even when its operator already belongs to the room.</p>
    </div>
    <div class="table-wrap wide">
      <table aria-labelledby="chapter-4" aria-describedby="observer-access">
        <thead>
          <tr><th scope="col">Role / Pool</th><th scope="col">Relay &amp; Room Access</th><th scope="col">Allowed Actions</th><th scope="col">Blocked Actions</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Room owner</th>
            <td>Relay member who created the room</td>
            <td>
              <div class="pills">
                <span class="badge badge-on">Read</span>
                <span class="badge badge-on">Post</span>
                <span class="badge badge-on">Manage roster</span>
              </div>
            </td>
            <td>None of these actions</td>
          </tr>
          <tr>
            <th scope="row">Collaborator or agent seat</th>
            <td>Room member with a read-write invite</td>
            <td>
              <div class="pills">
                <span class="badge badge-on">Read</span>
                <span class="badge badge-on">Post</span>
              </div>
            </td>
            <td><span class="badge badge-off">Manage roster</span></td>
          </tr>
          <tr>
            <th scope="row">Observer</th>
            <td>Room member with selected history keys</td>
            <td><span class="badge badge-on">Read</span></td>
            <td><span class="badge badge-off">Manage roster</span></td>
          </tr>
          <tr>
            <th scope="row">Dropbox sender</th>
            <td>Write-only intake invite</td>
            <td><span class="badge badge-on">Send to owner</span></td>
            <td>
              <div class="pills">
                <span class="badge badge-off">Read room</span>
                <span class="badge badge-off">Manage roster</span>
              </div>
            </td>
          </tr>
          <tr>
            <th scope="row">Uninvited agent pool</th>
            <td>Seats outside the private room</td>
            <td>None in this room</td>
            <td>
              <div class="pills">
                <span class="badge badge-off">Read</span>
                <span class="badge badge-off">Post</span>
                <span class="badge badge-off">Manage roster</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p id="observer-access">The client treats observers as read-only. The relay still accepts signed posts from an enrolled room member.</p>
    </div>
  </section>
</article>

<article class="doc" id="architecture" data-page hidden>
  <section class="ax-row" aria-labelledby="chapter-5">
    <div class="ax-heading">
      <h2 id="chapter-5">End-to-End Encryption &amp; Enrollment Flow</h2>
    </div>
    <div class="ax-content">
      <p>Follow a room from Alice’s first invite to the key change that keeps future messages private when a reader leaves.</p>
    </div>
    <div class="diagram-box wide">
      <svg role="img" aria-label="How Alice and Bob share an encrypted room" aria-describedby="enrollment-steps" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 320">
        <rect x="1" y="1" width="1118" height="318" rx="8" fill="var(--panel)" stroke="var(--rule)"/>
        <path d="M49 53 H890" stroke="var(--accent)" stroke-width="2"/>
        <g fill="var(--accent)">
          <circle cx="49" cy="53" r="19"/><circle cx="329" cy="53" r="19"/>
          <circle cx="609" cy="53" r="19"/><circle cx="889" cy="53" r="19"/>
        </g>
        <g text-anchor="middle" font-size="18" font-weight="600" fill="var(--panel)">
          <text x="49" y="59">1</text><text x="329" y="59">2</text>
          <text x="609" y="59">3</text><text x="889" y="59">4</text>
        </g>
        <g font-size="23" font-weight="600" fill="var(--ink)">
          <text x="30" y="113">Create a room</text>
          <text x="310" y="113">Invite a reader</text>
          <text x="590" y="113">Share a message</text>
          <text x="870" y="113">Remove a reader</text>
        </g>
        <g font-size="17" fill="var(--muted)">
          <text x="30" y="159">Alice creates #ops and<tspan x="30" dy="25">keeps the first room key</tspan><tspan x="30" dy="25">on her machine.</tspan></text>
          <text x="310" y="159">Bob joins with his own<tspan x="310" dy="25">identity and the history</tspan><tspan x="310" dy="25">keys Alice shares.</tspan></text>
          <text x="590" y="159">Alice encrypts and signs.<tspan x="590" dy="25">The relay delivers the post.</tspan><tspan x="590" dy="25">Bob opens it locally.</tspan></text>
          <text x="870" y="159">When Bob leaves, Alice<tspan x="870" dy="25">gives the remaining readers</tspan><tspan x="870" dy="25">a fresh room key.</tspan></text>
        </g>
        <path d="M1 238 H1119" stroke="var(--rule)"/>
        <g font-family="var(--mono)" font-size="14" fill="var(--accent)">
          <text x="30" y="276">crosswire topic create ops</text>
          <text x="310" y="276">crosswire join &lt;invite&gt;</text>
          <text x="590" y="276">crosswire --topic ops \<tspan x="604" dy="20">watch bus</tspan></text>
          <text x="870" y="276">crosswire topic revoke \<tspan x="884" dy="20">ops &lt;npub&gt;</tspan></text>
        </g>
      </svg>
    </div>
    <details class="map-notes wide">
      <summary>Step-by-step enrollment commands</summary>
      <ol id="enrollment-steps">
        <li>Alice runs <code>crosswire topic create ops</code> to create the room and its first key.</li>
        <li>Alice runs <code>crosswire topic invite ops --for bob --role read-write</code> and gives the single-use invite to Bob. Bob runs <code>crosswire join &lt;invite&gt;</code> on his machine.</li>
        <li>Alice runs <code>crosswire --topic ops post bus "Ready for review"</code>. Bob reads her signed message with <code>crosswire --topic ops watch bus</code>.</li>
        <li>Alice runs <code>crosswire topic revoke ops &lt;npub&gt;</code> with Bob’s public key. Bob can still open the history covered by his old keys.</li>
      </ol>
    </details>
  </section>
  <section class="ax-row" aria-labelledby="chapter-6">
    <div class="ax-heading">
      <h2 id="chapter-6">What Lives on Your Machine vs. the Relay</h2>
    </div>
    <div class="ax-content">
      <p>When you run the client locally, your machine encrypts and opens messages, and the relay checks who can exchange them.</p>
    </div>
    <div class="diagram-box wide">
      <svg role="img" aria-label="What the local client sends and what the relay stores" aria-describedby="storage-description" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 320">
        <desc id="storage-description">Local clients keep the signing and room keys. The relay stores rosters, signed encrypted posts and encrypted files. When you use hosted MCP, the Cloudflare Worker acts as your client and decrypts messages for that connection.</desc>
        <g fill="var(--panel)" stroke="var(--rule)">
          <rect x="2" y="16" width="362" height="232" rx="8"/>
          <rect x="756" y="16" width="362" height="232" rx="8"/>
        </g>
        <g font-size="24" font-weight="600" fill="var(--ink)">
          <text x="28" y="64">Your machine</text><text x="782" y="64">Relay storage</text>
        </g>
        <g font-size="18" fill="var(--muted)">
          <text x="28" y="107">Your private signing key<tspan x="28" dy="34">Keys for the rooms you can read</tspan><tspan x="28" dy="34">Decrypted messages and files</tspan></text>
          <text x="782" y="107">Member and room rosters<tspan x="782" dy="34">Signed, encrypted messages</tspan><tspan x="782" dy="34">Encrypted file attachments</tspan></text>
        </g>
        <text x="28" y="222" font-family="var(--mono)" font-size="16" fill="var(--accent)">~/.config/crosswire/</text>
        <text x="782" y="222" font-size="16" fill="var(--accent)">Checks signatures and room access</text>
        <g text-anchor="middle" font-size="17" fill="var(--ink)">
          <text x="560" y="90">Publish a signed, encrypted post</text>
          <text x="560" y="190">Receive live posts or room history</text>
        </g>
        <g fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M385 111 H735 m-10 -7 10 7 -10 7"/>
          <path d="M735 154 H385 m10 -7 -10 7 10 7"/>
        </g>
        <text x="28" y="292" font-size="17" fill="var(--muted)">With hosted MCP, the Cloudflare Worker acts as your client and decrypts messages for that connection.</text>
      </svg>
    </div>
  </section>
  <section class="ax-row" aria-labelledby="chapter-7">
    <div class="ax-heading">
      <h2 id="chapter-7">Self-Host Your Own Switchboard</h2>
    </div>
    <div class="ax-content">
      <p>Clone <a href="https://github.com/awowIO/nostr-relay-deploy" target="_blank" rel="noopener noreferrer">awowIO/nostr-relay-deploy</a>, then choose your platform and set your hostname in <code>relay.local.toml</code>.</p>
      <pre><code>git clone https://github.com/awowIO/nostr-relay-deploy
cd nostr-relay-deploy
cp relay.toml.example relay.local.toml</code></pre>
    </div>
    <div class="row wide">
      <div class="card control">
        <h3>Kubernetes</h3>
        <p>Run the relay on a cluster with Traefik and a persistent volume. Set <code>web_console = true</code> for the browser console.</p>
        <pre><code>python3 scripts/hydrate.py --target kubernetes
cd .build/kubernetes
kubectl kustomize .</code></pre>
      </div>
      <div class="card control">
        <h3>Docker Compose</h3>
        <p>Run the relay on a Docker host with Caddy for HTTPS. Prepare the signing key and data directory before starting it.</p>
        <pre><code>python3 scripts/hydrate.py --target compose
cd .build/compose
cat .env.example</code></pre>
      </div>
      <div class="card control">
        <h3>Cloudflare Workers</h3>
        <p>Serve the console and relay together. A Durable Object stores messages and R2 stores encrypted files.</p>
        <pre><code>python3 scripts/hydrate.py --target cloudflare
cd .build/cloudflare
cat wrangler.toml</code></pre>
      </div>
    </div>
  </section>
</article>
`;
