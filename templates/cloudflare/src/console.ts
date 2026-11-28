// The Visual Web Console: the page a browser gets at https://<relay host>/, /join and
// /join/ from the Cloudflare Worker. One self-contained document, served same-origin with
// the relay, so it talks to nothing but this relay's WebSocket and NIP-11 document.
//
// It opens nostr-mailbox's invite links (…/join/#nm1_…, …/#join=nm1_…, …/#invite=<code>):
// it reads the fragment once, takes it off the address bar, and fills in the code of a
// relay invite for this relay. A topic invite, whose keys it cannot keep, and an invite
// for another relay are shown but never redeemed here.
//
// Its "Mint invite & magic MCP link" button mints a whole nm1_ token for a member: the
// relay mints a single-use invite code (REQ kind 28935), and the page packs it, as
// nostr-mailbox's `invite` and the Worker's mailbox_invite do, with a cf.transport/1
// declaration of a room: this relay, the room's slug as its campaign, the member's key as
// its operator, and the room's 32-byte NIP-44 campaign_key, made here once and kept in
// this browser's localStorage for that member and room. Every token minted for the room
// carries the same key, so every client paired with one reads the others on its bus.
// Topic tokens (9009 group codes, epoch keys, a redeem secret) stay with the topic's
// keeper's nostr-mailbox CLI: this page holds no topic's keys.
//
// Its "Pair a coding agent" card turns an nm1_ token (one minted here, the one an invite
// link carried, or one pasted in) into the ways a client connects to the relay's MCP
// server (mcp.ts, oauth.ts) without a token pasted into its settings: the OAuth URL,
// /mcp, whose consent page fills the token in from this browser when the user asked the
// card to remember it; the magic URLs /mcp/s/<token> and /mcp/s/<token>/openapi.json; and
// the join link /join/#<token> that nostr-mailbox's CLI redeems. It asks the relay whether
// it honours the token in an Authorization header, never in a URL.
//
// It signs with a NIP-07 browser extension (window.nostr), so no secret key reaches the
// page. Through the relay's own wire protocol, and nothing else, a member:
//   - signs in (NIP-42), and redeems an invite code if not yet enrolled (NIP-43 28934)
//   - mints a single-use invite for someone else (REQ kind 28935)
//   - creates, joins, leaves and runs NIP-29 groups: members, roles, pending join
//     requests and metadata (9000, 9001, 9002, 9007, 9021, 9022)
//   - sees which sealed envelopes are addressed to them (1059, 4410, 4411), never their
//     contents
//
// The look is a minimal, dense design system: 13px type, tabular numerals, one accent,
// a light and a dark theme (the system's, or the one the header's toggle chose), and a
// full-width layout with fluid gutters and no boxed container.
//
// worker.ts serves it with a Content-Security-Policy that admits exactly this script and
// style, by SHA-256, so neither may change without the hashes changing with them. Both are
// String.raw literals: the page's own code uses no backtick and no dollar-brace.

export const CONSOLE_STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #fff; --ink: #18212f; --muted: #596677; --line: #e0e5eb; --soft: #f0f3f7;
  --accent: #335ade; --green: #137657; --red: #b14439; --amber: #956014; --head: #eef1f5; --hover: #f4f7ff;
  --shadow: 0 16px 70px #14243c26;
  --mono: ui-monospace, SFMono-Regular, Consolas, monospace;
}
:root[data-theme=light] { color-scheme: light; }
:root[data-theme=dark] {
  color-scheme: dark;
  --bg: #10151c; --panel: #171e28; --ink: #f0f4fb; --muted: #b5c0d0; --line: #2c3644; --soft: #212b38;
  --accent: #92acff; --green: #78d1aa; --red: #ec9990; --amber: #dfb472; --head: #1d2734; --hover: #243045;
  --shadow: 0 16px 70px #0008;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme=light]) {
    color-scheme: dark;
    --bg: #10151c; --panel: #171e28; --ink: #f0f4fb; --muted: #b5c0d0; --line: #2c3644; --soft: #212b38;
    --accent: #92acff; --green: #78d1aa; --red: #ec9990; --amber: #dfb472; --head: #1d2734; --hover: #243045;
    --shadow: 0 16px 70px #0008;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; border: 1px solid var(--line); background: var(--panel); border-radius: 5px; padding: 6px 10px; }
button:hover { background: var(--soft); border-color: var(--muted); }
button:disabled { opacity: .35; cursor: default; }
button.go { border-color: var(--accent); background: var(--accent); color: var(--panel); font-weight: 600; }
button.go:hover { background: color-mix(in srgb, var(--accent) 86%, var(--ink)); border-color: var(--accent); }
input { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; outline: none; min-width: 0; }
input[type="text"] { flex: 1 1 14rem; }
input[type="checkbox"] { accent-color: var(--accent); margin: 0; }
input:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.top {
  height: 61px; display: flex; justify-content: space-between; align-items: center; gap: 16px;
  padding-inline: clamp(20px, 3vw, 48px); border-bottom: 1px solid var(--line); background: var(--panel);
}
.wordmark {
  margin: 0; min-width: 0; color: var(--ink); font-size: 17px; font-weight: 650; letter-spacing: -.55px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mark { color: var(--accent); margin-right: 9px; font-size: 22px; vertical-align: -1px; }
.header-right { display: flex; gap: 17px; align-items: center; min-width: 0; color: var(--muted); font-size: 12px; white-space: nowrap; }
#theme { font-size: 19px; padding: 1px 9px; }
.dot { color: var(--muted); }
.dot.good { color: var(--green); }
.dot.bad { color: var(--red); }

.page { width: 100%; max-width: none; padding-inline: clamp(20px, 3vw, 48px); padding-block: 0 8px; }
.overview { display: flex; flex-wrap: wrap; gap: 12px 32px; padding: 23px 0 10px; }
.stat { display: flex; align-items: baseline; gap: 8px; }
.stat strong { font-size: 25px; letter-spacing: -.8px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 12px; }
.stat.good strong { color: var(--green); }
.stat.warn strong { color: var(--amber); }
.stat.bad strong { color: var(--red); }
.about { margin: 0 0 6px; color: var(--muted); }
.facts { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 0 0 18px; font-size: 11px; }
.facts div { display: flex; gap: 6px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; font-family: var(--mono); font-variant-numeric: tabular-nums; }

.assumptions {
  display: flex; align-items: flex-start; flex-wrap: wrap; gap: 14px 28px; padding: 12px 16px; margin: 0 0 18px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
}
.control { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 0 1 auto; }
.control.grow { flex: 1 1 18rem; }
.label { font-size: 10px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); font-weight: 500; }
.note { font-size: 11px; color: var(--muted); }
.room { display: flex; align-items: center; gap: 4px; }
.room span { color: var(--muted); font-size: 15px; }
.room input { width: 12rem; font-family: var(--mono); font-size: 12px; }

.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 30rem), 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 13px 14px; min-width: 0; }
.wide { grid-column: 1 / -1; }
.card-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; margin: 0 0 6px; }
h2 { margin: 0; font-size: 14px; font-weight: 600; }
.card > h2 { margin: 0 0 6px; }
h3 { margin: 14px 0 6px; font-size: 10px; font-weight: 550; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); }
p { margin: 0 0 10px; }
.muted { color: var(--muted); }
.good { color: var(--green); }
.bad { color: var(--red); }
code, .mono { font-family: var(--mono); font-size: 12px; }
code { background: var(--soft); padding: 1px 5px; border-radius: 3px; overflow-wrap: anywhere; }
form, .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0; }
label { display: inline-flex; gap: 6px; align-items: center; }
.tag {
  display: inline-flex; align-items: center; padding: 2px 6px; margin: 0 4px 4px 0; border-radius: 3px;
  background: var(--soft); color: var(--muted); font-size: 10px; font-weight: 500; line-height: 1.5;
}

.pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 8px; }
.pills button { border-radius: 13px; padding: 3px 10px; font-size: 12px; }
.pills button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); background: var(--hover); font-weight: 600; }
.howto { margin: 0 0 10px; }
.urls { display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content; gap: 6px 12px; align-items: center; margin: 10px 0; }
.urls code { display: block; padding: 6px 8px; border: 1px solid var(--line); }
.urls button, .snippet button { font-size: 11px; padding: 4px 9px; }
.snippet { position: relative; margin: 0 0 10px; }
.snippet pre {
  margin: 0; padding: 10px 76px 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--soft);
  border: 1px solid var(--line); border-radius: 6px; font: 12px/1.5 var(--mono);
}
.snippet button { position: absolute; top: 6px; right: 6px; }

.table-wrap { overflow: auto; max-height: 24rem; border: 1px solid var(--line); border-radius: 6px; }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; text-align: left; }
th {
  position: sticky; top: 0; background: var(--head); border-bottom: 1px solid var(--line); padding: 8px 12px;
  font-size: 10px; font-weight: 550; text-transform: uppercase; letter-spacing: .6px; color: var(--muted);
}
td { padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--hover); }
#log { list-style: none; margin: 0; padding: 0; font: 11px/1.5 var(--mono); }
#log li { padding: 3px 0; border-bottom: 1px dashed var(--line); overflow-wrap: anywhere; }
footer {
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; margin-top: 18px;
  padding: 13px 0 24px; border-top: 1px solid var(--line); color: var(--muted); font-size: 10px;
}
[hidden] { display: none !important; }

@media (width <= 760px) {
  .top { height: 53px; }
  .wordmark { font-size: 15px; }
  .header-right { gap: 8px; font-size: 10px; }
  #relay-dial { display: none; }
  .overview { gap: 10px 22px; padding-top: 17px; }
  .stat strong { font-size: 21px; }
  .stat span { font-size: 10px; }
  .assumptions { gap: 12px; padding: 10px; }
  .urls { grid-template-columns: minmax(0, 1fr) max-content; }
  .urls .label { grid-column: 1 / -1; }
}
`;

const BODY = String.raw`
<header class="top">
  <h1 class="wordmark"><span class="mark" aria-hidden="true">⨉</span><span id="relay-name">Relay console</span></h1>
  <div class="header-right">
    <span id="relay-dial" class="mono"><span id="relay-dot" class="dot" aria-hidden="true">●</span> <span id="relay-url"></span></span>
    <span id="persona-npub" class="mono" title="The key your NIP-07 extension signs with">not signed in</span>
    <button id="theme" type="button" aria-label="Switch color theme">◐</button>
  </div>
</header>

<main class="page">
  <section class="overview" aria-label="This relay at a glance">
    <div class="stat" id="stat-relay"><strong id="relay-state">…</strong><span>relay</span></div>
    <div class="stat" id="stat-gate"><strong id="gate-state">…</strong><span>NIP-42 auth · NIP-43 members</span></div>
    <div class="stat good"><strong>v2</strong><span>NIP-44 sealed bus</span></div>
    <div class="stat"><strong id="seen-count">–</strong><span>your groups · sealed mail</span></div>
    <div class="stat"><strong class="mono">/mcp</strong><span>MCP · OAuth 2.1 · magic URLs</span></div>
  </section>
  <p id="relay-about" class="about">Reading this relay's NIP-11 document.</p>
  <dl class="facts" id="facts"></dl>

  <section class="assumptions" aria-label="Who you are, the room, and what you mint">
    <div class="control">
      <span class="label">Persona</span>
      <div class="row"><button id="signin" type="button">Sign in with a NIP-07 extension</button></div>
      <span id="whoami" class="note" aria-live="polite">Not signed in.</span>
    </div>
    <div class="control">
      <label class="label" for="room">Room</label>
      <div class="room"><span aria-hidden="true">#</span><input type="text" id="room" value="agents" list="rooms"
        autocomplete="off" spellcheck="false" pattern="#?[a-z0-9][a-z0-9._\-]{0,63}" aria-describedby="room-note"></div>
      <datalist id="rooms"></datalist>
      <span id="room-note" class="note">The campaign a minted token admits to. Its NIP-44 key stays in this browser.</span>
    </div>
    <div class="control grow" id="join-card" hidden>
      <label class="label" for="join-code">Redeem an invite</label>
      <form id="join-form">
        <input type="text" id="join-code" required autocomplete="off" spellcheck="false" placeholder="single-use code a member gave you">
        <button type="submit">Redeem</button>
      </form>
      <span class="note">Your key is not enrolled yet. An invite link fills the code in.</span>
    </div>
    <div class="control grow" id="invite-card">
      <span class="label">Invite</span>
      <div class="row"><button id="mint" type="button" class="go">Mint invite &amp; magic MCP link</button></div>
      <div id="invite-out" class="row" hidden>
        <span class="note">relay code</span><code id="invite-code"></code>
        <button id="invite-copy" type="button">Copy</button>
      </div>
      <span id="mint-status" class="note" aria-live="polite">One key, once, within seven days. Members mint; signing in comes first.</span>
    </div>
  </section>

  <div class="grid">
    <section class="card wide" id="link-card" aria-labelledby="link-title" hidden>
      <h2 id="link-title">Your invite</h2>
      <p id="link-about"></p>
      <p id="link-next" aria-live="polite"></p>
      <div id="link-cli" hidden>
        <p class="muted">Or join with the nostr-mailbox CLI, which makes and keeps a key of its own:</p>
        <div class="row"><code id="link-command"></code>
          <button id="link-copy" type="button">Copy</button></div>
      </div>
      <p class="muted">The token admits one key, once. It reached this page in the link's
      fragment, which a browser never sends to a server, and the page has taken it off the
      address bar.</p>
    </section>

    <section class="card wide" id="pair-card" aria-labelledby="pair-title">
      <div class="card-head">
        <h2 id="pair-title">Pair a coding agent</h2>
        <span class="note">MCP over Streamable HTTP · OAuth 2.1 · magic URL · join link</span>
      </div>
      <p>Put ChatGPT, Claude or a coding agent on this relay's mailbox with an nm1_ token: one minted above, the one
      an invite link carries, or one a topic's keeper mints with <code>nostr-mailbox topic invite</code>. The client
      then posts and watches the same NIP-44 encrypted channel as your local agents, as a persona of the token.</p>
      <div class="pills" id="pair-clients" role="group" aria-label="Your client">
        <button type="button" data-client="chatgpt" aria-pressed="true">ChatGPT (Web / Desktop)</button>
        <button type="button" data-client="claude" aria-pressed="false">Claude.ai / Claude Desktop</button>
        <button type="button" data-client="claude-code" aria-pressed="false">Claude Code</button>
        <button type="button" data-client="codex" aria-pressed="false">Codex</button>
        <button type="button" data-client="antigravity" aria-pressed="false">Antigravity (agy)</button>
        <button type="button" data-client="cursor" aria-pressed="false">Cursor</button>
        <button type="button" data-client="pi-opencode" aria-pressed="false">Pi / OpenCode</button>
      </div>
      <p id="pair-howto" class="howto" aria-live="polite"></p>
      <form id="pair-form">
        <input type="text" id="pair-token" required autocomplete="off" spellcheck="false"
          placeholder="nm1_… token, or …/join/#nm1_… invite link" aria-label="nm1_ token or invite link">
        <button type="submit">Show connection URLs</button>
      </form>
      <p id="pair-status" aria-live="polite"></p>
      <div id="pair-out" hidden>
        <div class="snippet" id="pair-snippet-box" hidden><pre id="pair-snippet"></pre>
          <button id="pair-snippet-copy" type="button">Copy</button></div>
        <div class="urls">
          <span class="label">Magic MCP URL</span><code id="pair-mcp"></code>
          <button id="pair-mcp-copy" type="button">Copy</button>
          <span class="label">Magic OpenAPI URL</span><code id="pair-openapi"></code>
          <button id="pair-openapi-copy" type="button">Copy</button>
          <span class="label">OAuth 2.1 URL</span><code id="pair-oauth"></code>
          <button id="pair-oauth-copy" type="button">Copy</button>
          <span class="label">Join link</span><code id="pair-join"></code>
          <button id="pair-join-copy" type="button">Copy</button>
        </div>
        <label class="note"><input type="checkbox" id="pair-remember"> Remember the token in this browser, for the
          OAuth Authorize page</label>
        <p class="note">The magic URLs carry the token and need no sign-in (Authentication: None); the OAuth URL signs in
        through this relay's Authorize page; the join link is for <code>nostr-mailbox join</code>. The token is a
        password, and so is each URL: whoever holds one acts as the token's persona. Whichever client uses the token
        first spends its invite, so mint one per client. Each mint for the same room carries the same room key, so
        all of them read one channel.</p>
      </div>
    </section>

    <section class="card" id="groups-card" aria-labelledby="groups-title" hidden>
      <h2 id="groups-title">Groups</h2>
      <p class="muted">NIP-29 groups on this relay. A new group is private, restricted and
      closed: only its members read and post, and a join waits for an admin.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Group</th><th>Flags</th><th>You</th><th></th></tr></thead>
        <tbody id="group-rows"></tbody>
      </table></div>
      <h3>Create a group</h3>
      <form id="create-form">
        <input type="text" id="create-id" pattern="[a-z0-9_\-]+" autocomplete="off" spellcheck="false"
          placeholder="group id (a-z, 0-9, - and _); empty for a random one" aria-label="New group id">
        <button type="submit">Create</button>
      </form>
      <h3>Ask to join a group</h3>
      <form id="request-form">
        <input type="text" id="request-id" required pattern="[a-z0-9_\-]+" autocomplete="off" spellcheck="false"
          aria-label="Group id to join">
        <button type="submit">Send join request</button>
      </form>
    </section>

    <section class="card wide" id="group-card" aria-labelledby="group-title" hidden>
      <h2 id="group-title">Group</h2>
      <p id="group-about" class="muted"></p>
      <div id="group-flags"></div>
      <h3>Members</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Key</th><th>Roles</th><th></th></tr></thead>
        <tbody id="member-rows"></tbody>
      </table></div>
      <div id="admin-tools" hidden>
        <h3>Add a member</h3>
        <form id="add-form">
          <input type="text" id="add-key" required autocomplete="off" spellcheck="false" placeholder="npub or 64-hex public key"
            aria-label="Member to add">
          <label><input type="checkbox" id="add-admin"> admin</label>
          <button type="submit">Add</button>
        </form>
        <h3>Pending join requests</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Key</th><th>Asked</th><th>Message</th><th></th></tr></thead>
          <tbody id="pending-rows"></tbody>
        </table></div>
        <h3>Metadata</h3>
        <p class="muted">Saving replaces all of it: a flag left unticked is off.</p>
        <form id="edit-form">
          <input type="text" id="edit-name" autocomplete="off" placeholder="name" aria-label="Group name">
          <input type="text" id="edit-about" autocomplete="off" placeholder="about" aria-label="About the group">
          <label><input type="checkbox" id="flag-private"> private</label>
          <label><input type="checkbox" id="flag-restricted"> restricted</label>
          <label><input type="checkbox" id="flag-closed"> closed</label>
          <label><input type="checkbox" id="flag-hidden"> hidden</label>
          <button type="submit">Save metadata</button>
        </form>
      </div>
      <div class="row"><button id="leave" type="button">Leave this group</button></div>
    </section>

    <section class="card" id="mailbox-card" aria-labelledby="mailbox-title" hidden>
      <h2 id="mailbox-title">Your sealed mail</h2>
      <p class="muted">Gift wraps (1059) and mailbox envelopes and receipts (4410, 4411) reach
      only the key they name. This lists what is addressed to you; read them with your
      mailbox client.</p>
      <div class="row"><button id="mail-refresh" type="button">Refresh</button></div>
      <p id="mail-summary"></p>
      <div class="table-wrap"><table>
        <thead><tr><th>Kind</th><th>From</th><th>When</th></tr></thead>
        <tbody id="mail-rows"></tbody>
      </table></div>
    </section>

    <section class="card wide" aria-labelledby="log-title">
      <h2 id="log-title">What the relay said</h2>
      <ul id="log" aria-live="polite"></ul>
    </section>
  </div>

  <footer>
    <span>Talks to this relay only: its WebSocket and its NIP-11 document. Signs through your NIP-07 extension, so
    no secret key reaches this page.</span>
    <span id="relay-software"></span>
  </footer>
</main>
`;

export const CONSOLE_SCRIPT = String.raw`
(function () {
  'use strict';
  var RELAY_URL = 'wss://' + location.host;
  var KIND_NAMES = { 1059: 'gift wrap', 4410: 'envelope', 4411: 'receipt' };
  var state = { ws: null, me: null, member: false, relayKey: null, challenge: null,
                pending: new Map(), subs: new Map(), seq: 0, group: null, link: null, pairToken: null,
                urls: null, client: 'chatgpt', counts: { groups: null, mail: null } };

  function $(id) { return document.getElementById(id); }
  function now() { return Math.floor(Date.now() / 1000); }
  function short(hex) { return hex.slice(0, 10) + '…' + hex.slice(-6); }
  function when(ts) { return new Date(ts * 1000).toLocaleString(); }
  function tagValue(e, name) { var t = e.tags.find(function (x) { return x[0] === name && x.length > 1; }); return t ? t[1] : null; }
  function tagValues(e, name) { return e.tags.filter(function (x) { return x[0] === name && x.length > 1; }).map(function (x) { return x[1]; }); }
  function el(tag, text, cls) { var n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
  function cell(row, content) { var td = el('td'); if (typeof content === 'string') td.textContent = content; else td.appendChild(content); row.appendChild(td); return td; }
  function log(text, cls) { var li = el('li', new Date().toLocaleTimeString() + '  ' + text, cls); $('log').prepend(li); }
  function action(fn) {
    return function (ev) {
      if (ev) ev.preventDefault();
      Promise.resolve().then(fn).catch(function (err) { log(err && err.message ? err.message : String(err), 'bad'); });
    };
  }

  // BEGIN nm1_ token packer
  // tests/test_hydrate.py runs this block under Node. It packs what a member's console
  // mints, the way nostr-mailbox's cli._encode_invite_token and the Worker's
  // mailbox_invite do: 'nm1_' + unpadded base64url of the JSON, keys sorted and no
  // spaces, of a cf.transport/1 declaration (relay, campaign, operator_pubkeys as npubs,
  // campaign_key) and the relay invite 'code'. bech32 (BIP-173) writes and reads the npubs.
  var CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var ROOM = /^[a-z0-9][a-z0-9._-]{0,63}$/;   // nostr-mailbox's campaign slug
  var HEX64 = /^[0-9a-f]{64}$/;
  function polymod(values) {
    var gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    var chk = 1;
    values.forEach(function (v) {
      var top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (var i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
    });
    return chk;
  }
  function hrpExpand(hrp) {
    var out = [];
    for (var i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
    out.push(0);
    for (var j = 0; j < hrp.length; j++) out.push(hrp.charCodeAt(j) & 31);
    return out;
  }
  function hexOf(bytes) { return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  function npubOf(hex) {
    if (!HEX64.test(hex)) throw new Error('a public key is 64 lowercase hex');
    var data = [], acc = 0, bits = 0;
    for (var i = 0; i < 64; i += 2) {
      acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16); bits += 8;
      while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); }
      acc &= (1 << bits) - 1;
    }
    if (bits > 0) data.push((acc << (5 - bits)) & 31);
    var mod = polymod(hrpExpand('npub').concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
    for (var p = 0; p < 6; p++) data.push((mod >>> (5 * (5 - p))) & 31);
    return 'npub1' + data.map(function (v) { return CHARSET[v]; }).join('');
  }
  function pubkeyHex(text) {
    var s = text.trim().toLowerCase();
    if (HEX64.test(s)) return s;
    if (s.indexOf('npub1') !== 0) throw new Error('give an npub or a 64-hex public key');
    var data = [];
    for (var i = 5; i < s.length; i++) {
      var v = CHARSET.indexOf(s[i]);
      if (v < 0) throw new Error('that npub has a character bech32 does not use');
      data.push(v);
    }
    if (data.length < 6 || polymod(hrpExpand('npub').concat(data)) !== 1) throw new Error('that npub has a bad checksum');
    var acc = 0, bits = 0, out = [];
    data.slice(0, -6).forEach(function (v) {
      acc = (acc << 5) | v; bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); }
      acc &= (1 << bits) - 1;
    });
    if (out.length !== 32 || bits >= 5 || acc !== 0) throw new Error('that npub is not a 32-byte key');
    return hexOf(out);
  }
  function roomSlug(text) {
    var s = String(text || '').trim().replace(/^#/, '').toLowerCase();
    if (!ROOM.test(s)) throw new Error('a room is 1 to 64 of a-z, 0-9, ".", "_" and "-", starting with a letter or digit');
    return s;
  }
  // A room's key: 32 bytes from the browser's CSPRNG, as 'nostr-mailbox setup' makes a
  // campaign_key (os.urandom(32).hex()).
  function freshRoomKey() { return hexOf(crypto.getRandomValues(new Uint8Array(32))); }
  function sortedJson(value) {
    if (Array.isArray(value)) return '[' + value.map(sortedJson).join(',') + ']';
    if (value !== null && typeof value === 'object') {
      return '{' + Object.keys(value).filter(function (k) { return value[k] !== undefined; }).sort()
        .map(function (k) { return JSON.stringify(k) + ':' + sortedJson(value[k]); }).join(',') + '}';
    }
    return JSON.stringify(value);
  }
  // o: { relay, campaign, operator (hex), campaignKey (hex), code, relayAuthUrl? }.
  // relayAuthUrl is for a token whose holder dials the relay by another address; the
  // console never sets it, since it dials the relay by the name it signs NIP-42 with.
  function packInvite(o) {
    if (!/^wss?:\/\/[^/?#]+$/.test(String(o.relay))) throw new Error('a token names its relay as ws:// or wss:// and a host');
    if (!HEX64.test(String(o.campaignKey))) throw new Error('a room key is 64 lowercase hex');
    if (typeof o.code !== 'string' || o.code === '') throw new Error('a token carries the relay invite code');
    var bundle = { schema: 'cf.transport/1', relay: o.relay, campaign: roomSlug(o.campaign),
                   operator_pubkeys: [npubOf(o.operator)], campaign_key: o.campaignKey, code: o.code,
                   relay_auth_url: o.relayAuthUrl || undefined };
    var bytes = new TextEncoder().encode(sortedJson(bundle)), bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return 'nm1_' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // END nm1_ token packer

  // BEGIN invite-link reader
  // The same block runs in the Worker console and on the GitHub Pages page, and
  // tests/test_hydrate.py runs it under Node. It reads what a nostr-mailbox invite link
  // carries in its fragment, which a browser never sends to a server:
  //   #nm1_...[&topic=...&role=...&ticket=...]  the join_url of 'invite' and 'topic invite'
  //   #join=nm1_...[&topic=...]                 the web console's web_link
  //   #invite=<code>                            a bare relay invite code
  // and the nm1_ token itself: base64url of the JSON that 'nostr-mailbox join' reads.
  // It returns null when the fragment holds no invite, and throws when it holds one it
  // cannot read. It never sends, stores or logs the token.
  function readInviteLink(fragment) {
    var frag = String(fragment || '').replace(/^#/, '');
    var token = null;
    if (frag.indexOf('nm1_') === 0) {
      var at = frag.indexOf('&');
      token = at < 0 ? frag : frag.slice(0, at);
      frag = at < 0 ? '' : frag.slice(at + 1);
    }
    var params = new URLSearchParams(frag);
    token = token || params.get('join');
    var hint = { topic: params.get('topic'), role: params.get('role') };
    if (!token) {
      var code = params.get('invite');
      return code ? { token: null, code: code, topic: hint.topic, role: hint.role } : null;
    }
    if (!/^nm1_[A-Za-z0-9_-]+$/.test(token)) throw new Error('the link carries no readable nm1_ token');
    var body = token.slice(4), bundle;
    try {
      var bin = atob(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - body.length % 4) % 4));
      var bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
      bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (err) {
      throw new Error('the nm1_ token is not base64url JSON');
    }
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('the nm1_ token holds no invite');
    if (bundle.schema !== 'cf.transport/1') throw new Error('the nm1_ token is not a cf.transport/1 invite');
    if (typeof bundle.code !== 'string' || bundle.code === '') throw new Error('the nm1_ token carries no invite code');
    // The relay's public name: relay_auth_url when the inviter dials it by another address.
    var named = typeof bundle.relay_auth_url === 'string' ? bundle.relay_auth_url : bundle.relay;
    var relay;
    try { relay = new URL(named); } catch (err) { throw new Error('the nm1_ token names no relay URL'); }
    if (relay.protocol !== 'wss:' && relay.protocol !== 'ws:') throw new Error('the nm1_ token names no ws:// or wss:// relay');
    return {
      token: token, code: bundle.code, relay: named, host: relay.host.toLowerCase(),
      campaign: typeof bundle.campaign === 'string' ? bundle.campaign : null,
      member: typeof bundle.member === 'string' ? bundle.member : null,
      topic: typeof bundle.topic === 'string' ? bundle.topic : hint.topic,
      role: hint.role,
      // A topic invite carries the channel's keys, which only nostr-mailbox keeps.
      channel: typeof bundle.group_code === 'string' || (!!bundle.epochs && typeof bundle.epochs === 'object'),
    };
  }
  // END invite-link reader

  // --------------------------------------------------------------- this browser
  // The consent page (oauth.ts) reads the token from the same key.
  var TOKEN_KEY = 'nostr-relay-deploy/mcp-token';
  var THEME_KEY = 'nostr-relay-deploy/theme';
  // A room's key, for one member: ROOM_KEY_PREFIX + <member's hex key> + '/' + <room>.
  var ROOM_KEY_PREFIX = 'nostr-relay-deploy/room-key/';
  function storage() {
    try { return window.localStorage; } catch (err) { log('this browser keeps nothing for this page: ' + err.message, 'bad'); return null; }
  }
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  function toggleTheme() {
    var set = document.documentElement.dataset.theme;
    var dark = set ? set === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = dark ? 'light' : 'dark';
    applyTheme(next);
    var store = storage();
    if (store) store.setItem(THEME_KEY, next);
  }
  function roomKey(room) {
    var store = storage(), name = ROOM_KEY_PREFIX + state.me + '/' + room;
    var held = store && store.getItem(name);
    if (held !== null && held !== undefined && held !== '') {
      if (!HEX64.test(held)) throw new Error('this browser keeps a key for #' + room + ' that is not 64 hex; nothing was minted. Clear ' + name + ' from its storage to start the room over');
      return { hex: held, fresh: false };
    }
    var hex = freshRoomKey();
    if (store) store.setItem(name, hex);
    else log('the key of #' + room + ' is not kept: the next token minted for it opens another channel', 'bad');
    return { hex: hex, fresh: true };
  }
  function listRooms() {
    var list = $('rooms'), store = storage(), mine = ROOM_KEY_PREFIX + state.me + '/';
    list.textContent = '';
    if (!store || !state.me) return;
    for (var i = 0; i < store.length; i++) {
      var name = store.key(i);
      if (name && name.indexOf(mine) === 0) { var o = el('option'); o.value = name.slice(mine.length); list.appendChild(o); }
    }
  }

  // ------------------------------------------------------------------ invite links
  function takeInviteLink() {
    if (!location.hash) return null;
    var fragment = location.hash;
    // Off the address bar and out of the history: until it is redeemed, the token is a
    // bearer secret.
    history.replaceState(null, '', location.pathname + location.search);
    try { return readInviteLink(fragment); } catch (err) { return { error: err.message }; }
  }
  function forThisRelay(link) { return !link.token || link.host === location.host.toLowerCase(); }
  function usableHere(link) { return !link.error && !link.channel && forThisRelay(link); }
  function renderLink() {
    var link = state.link;
    $('link-card').hidden = !link;
    if (!link) return;
    var about = $('link-about'), next = $('link-next');
    next.className = '';
    $('link-cli').hidden = true;
    if (link.error) {
      about.textContent = 'This invite link could not be read: ' + link.error + '. Nothing was sent; ask for a new link.';
      next.textContent = '';
      return;
    }
    if (!forThisRelay(link)) {
      about.textContent = 'This invite is for ' + link.relay + ', not for this relay (' + RELAY_URL + '). Nothing here uses it.';
      next.textContent = '';
      return;
    }
    if (link.token) {
      $('link-command').textContent = 'nostr-mailbox join ' + link.token;
      $('link-cli').hidden = false;
    }
    var where = link.campaign ? 'campaign ' + link.campaign + ' on this relay' : 'this relay';
    if (link.channel) {
      about.textContent = 'An invite into the channel ' + (link.topic || '(unnamed)') + ' of ' + where +
        (link.member ? ', for ' + link.member : '') + '. It carries the channel keys, which this console cannot keep.';
      next.textContent = 'Redeeming its code here would spend it on your browser key and leave you without the keys: join with the nostr-mailbox CLI below, or pair a coding agent with it.';
      return;
    }
    about.textContent = 'An invite to ' + where + (link.member ? ', for ' + link.member : '') +
      (link.topic ? ', to ask for the channel ' + link.topic + ' next' : '') + '.';
    if (link.spent) { next.textContent = 'Redeemed: ' + short(state.me) + ' is a member now.'; next.className = 'good'; }
    else if (!state.me) next.textContent = 'Sign in with your NIP-07 extension, then press Redeem: the code is filled in, and it admits the key your extension holds.';
    else if (state.member) next.textContent = short(state.me) + ' is already a member; the invite was not used.';
    else next.textContent = 'Press Redeem above to admit ' + short(state.me) + '.';
  }

  // ------------------------------------------------------------ pair a coding agent
  // BEGIN connection URLs
  // tests/test_hydrate.py runs this block under Node: where a client connects with token.
  function connectionUrls(origin, token) {
    return { oauth: origin + '/mcp', mcp: origin + '/mcp/s/' + token, openapi: origin + '/mcp/s/' + token + '/openapi.json',
             join: origin + '/join/#' + token };
  }
  // END connection URLs
  // What each client takes, in words and, where it reads a file or a command, as a
  // snippet with the URLs filled in. The server name is the room's, so two rooms are two
  // servers.
  function serverName(campaign) { return ('mailbox-' + (campaign || 'relay')).replace(/[^a-z0-9_-]/g, '-'); }
  var CLIENTS = {
    'chatgpt': {
      how: 'In ChatGPT, turn on developer mode and create a connector: paste the magic MCP URL with no authentication, or the OAuth 2.1 URL to sign in through this relay’s Authorize page. A Custom GPT instead imports its Action from the magic OpenAPI URL, with Authentication: None.',
      snippet: null },
    'claude': {
      how: 'In Claude.ai or Claude Desktop, open Settings → Connectors and add a custom connector with the OAuth 2.1 URL: Claude opens this relay’s Authorize page, which fills the token in when this browser remembers it (tick the box below). The magic MCP URL works too, with no sign-in.',
      snippet: null },
    'claude-code': {
      how: 'Claude Code adds the magic MCP URL as a Streamable HTTP server. Run this where the agent works:',
      snippet: function (u, name) { return 'claude mcp add --transport http ' + name + " '" + u.mcp + "'"; } },
    'codex': {
      how: 'Codex reads Streamable HTTP servers from ~/.codex/config.toml. Add this table:',
      snippet: function (u, name) { return '[mcp_servers.' + name + ']\nurl = "' + u.mcp + '"'; } },
    'antigravity': {
      how: 'Antigravity (agy) runs nostr-mailbox’s agent skill, so it joins with the CLI: the join link makes its key and redeems the token, and the agent then watches the room’s bus.',
      snippet: function (u) { return "nostr-mailbox join '" + u.join + "'\nnostr-mailbox watch bus --wait-seconds 25"; } },
    'cursor': {
      how: 'Cursor reads remote servers from ~/.cursor/mcp.json, or .cursor/mcp.json in a project:',
      snippet: function (u, name) { return '{\n  "mcpServers": {\n    "' + name + '": { "url": "' + u.mcp + '" }\n  }\n}'; } },
    'pi-opencode': {
      how: 'OpenCode adds the magic MCP URL as a remote server in opencode.json. Pi has no MCP client: it runs the nostr-mailbox CLI, so give it the join link, as for Antigravity.',
      snippet: function (u, name) { return '{\n  "mcp": {\n    "' + name + '": { "type": "remote", "url": "' + u.mcp + '", "enabled": true }\n  }\n}'; } },
  };
  function renderClient() {
    var buttons = document.querySelectorAll('#pair-clients button');
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute('aria-pressed', String(buttons[i].dataset.client === state.client));
    var client = CLIENTS[state.client];
    $('pair-howto').textContent = client.how;
    var snippet = client.snippet && state.urls ? client.snippet(state.urls, serverName(state.urls.campaign)) : '';
    $('pair-snippet').textContent = snippet;
    $('pair-snippet-box').hidden = !snippet;
  }
  function chooseClient(id) {
    if (!CLIENTS[id]) throw new Error('no such client: ' + id);
    state.client = id;
    renderClient();
  }
  function pairStatus(text, cls) { var p = $('pair-status'); p.textContent = text; p.className = cls || ''; }
  async function pair(token) {
    var urls = connectionUrls(location.origin, token);
    urls.campaign = readInviteLink(token).campaign;
    $('pair-oauth').textContent = urls.oauth;
    $('pair-mcp').textContent = urls.mcp;
    $('pair-openapi').textContent = urls.openapi;
    $('pair-join').textContent = urls.join;
    $('pair-out').hidden = false;
    state.pairToken = token;
    state.urls = urls;
    renderClient();
    var store = storage();
    $('pair-remember').checked = !!store && store.getItem(TOKEN_KEY) === token;
    pairStatus('Asking the relay about this token…');
    var answer = await fetch('/openapi.json', { headers: { Authorization: 'Bearer ' + token } });
    if (answer.ok) { pairStatus('This relay honours the token.', 'good'); return; }
    var why = await answer.json();
    pairStatus('This relay refuses the token: ' + why.error, 'bad');
  }
  async function pairGiven() {
    var given = $('pair-token').value.trim();
    var at = given.indexOf('#');
    var link = readInviteLink(at < 0 ? given : given.slice(at + 1));
    if (!link || !link.token) throw new Error('give an nm1_ token, or an invite link that carries one');
    if (!forThisRelay(link)) throw new Error('that token is for ' + link.relay + ', not for this relay');
    $('pair-token').value = link.token;
    await pair(link.token);
  }
  function remember() {
    var store = storage();
    if (!store) throw new Error('this browser keeps nothing for this page');
    if ($('pair-remember').checked) { store.setItem(TOKEN_KEY, state.pairToken); log('the token is kept in this browser', 'good'); }
    else if (store.getItem(TOKEN_KEY) === state.pairToken) { store.removeItem(TOKEN_KEY); log('the token is no longer kept in this browser', 'good'); }
  }
  function copier(id) {
    return function (ev) {
      var button = ev.currentTarget;
      navigator.clipboard.writeText($(id).textContent).then(function () { button.textContent = 'Copied'; },
        function (err) { log('copying failed (' + err.message + '): select the text and copy it', 'bad'); });
    };
  }
  // The label stays until the button loses focus, rather than for a guessed delay.
  function copyButton(button, id) {
    button.addEventListener('click', copier(id));
    button.addEventListener('blur', function () { button.textContent = 'Copy'; });
  }

  // --------------------------------------------------------------------- the wire
  function send(message) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) throw new Error('not connected: sign in first');
    state.ws.send(JSON.stringify(message));
  }
  function onFrame(frame) {
    var verb = frame[0];
    if (verb === 'AUTH') { state.challenge = frame[1]; if (state.onChallenge) { state.onChallenge(frame[1]); state.onChallenge = null; } return; }
    if (verb === 'OK') {
      log((frame[2] ? 'accepted ' : 'refused ') + short(frame[1]) + (frame[3] ? ': ' + frame[3] : ''), frame[2] ? 'good' : 'bad');
      var done = state.pending.get(frame[1]);
      if (done) { state.pending.delete(frame[1]); done({ ok: frame[2], message: frame[3] }); }
      return;
    }
    if (verb === 'EVENT' || verb === 'EOSE' || verb === 'CLOSED') {
      var sub = state.subs.get(frame[1]);
      if (!sub) return;
      if (verb === 'EVENT') { sub.events.push(frame[2]); return; }
      state.subs.delete(frame[1]);
      if (verb === 'EOSE') { send(['CLOSE', frame[1]]); sub.resolve(sub.events); }
      else { log('closed: ' + frame[2], 'bad'); sub.reject(new Error(frame[2])); }
      return;
    }
    if (verb === 'NOTICE') log('notice: ' + frame[1], 'bad');
  }
  function query(filter) {
    var id = 'c' + (++state.seq);
    return new Promise(function (resolve, reject) {
      state.subs.set(id, { events: [], resolve: resolve, reject: reject });
      send(['REQ', id, filter]);
    });
  }
  function signer() {
    if (!window.nostr) throw new Error('no NIP-07 extension in this browser: install one that holds your key');
    return window.nostr;
  }
  async function signed(kind, tags, content) {
    var e = await signer().signEvent({ kind: kind, created_at: now(), tags: tags, content: content || '' });
    if (state.me && e.pubkey !== state.me) throw new Error('the extension signed with a different key than the one signed in');
    return e;
  }
  async function publish(kind, tags, content) {
    var e = await signed(kind, tags, content);
    var answer = await new Promise(function (resolve) { state.pending.set(e.id, resolve); send(['EVENT', e]); });
    if (!answer.ok) throw new Error(answer.message || 'refused');
    return answer;
  }
  function connect() {
    return new Promise(function (resolve, reject) {
      var ws = new WebSocket(RELAY_URL);
      state.ws = ws;
      state.onChallenge = resolve;
      ws.onmessage = function (m) { onFrame(JSON.parse(m.data)); };
      ws.onerror = function () { reject(new Error('cannot reach ' + RELAY_URL)); };
      ws.onclose = function (ev) {
        log('the connection closed (' + ev.code + ')', 'bad');
        state.ws = null; state.me = null; state.member = false; render();
      };
    });
  }

  // ------------------------------------------------------------------------ NIP-11
  function stat(id, text, cls) { var s = $(id); s.textContent = text; s.parentElement.className = 'stat' + (cls ? ' ' + cls : ''); }
  function facts(info) {
    var list = $('facts');
    list.textContent = '';
    var lim = info.limitation || {};
    [['auth required', String(lim.auth_required === true)],
     ['members only', String(lim.membership_required === true)],
     ['NIPs', (info.supported_nips || []).join(', ')],
     ['relay key', info.self ? short(info.self) : 'not advertised']].forEach(function (pair) {
      var d = el('div'); d.appendChild(el('dt', pair[0])); d.appendChild(el('dd', pair[1])); list.appendChild(d);
    });
    var gated = lim.auth_required === true && lim.membership_required === true;
    stat('gate-state', gated ? 'on' : 'off', gated ? 'good' : 'warn');
  }
  async function readInfo() {
    var r = await fetch('/', { headers: { Accept: 'application/nostr+json' } });
    if (!r.ok) throw new Error('NIP-11 answered HTTP ' + r.status);
    var info = await r.json();
    state.relayKey = info.self || null;
    $('relay-name').textContent = info.name || 'Relay console';
    $('relay-about').textContent = info.description || '';
    $('relay-software').textContent = [info.software, info.version].filter(Boolean).join(' ');
    document.title = (info.name || 'Relay') + ' console';
    stat('relay-state', 'online', 'good');
    $('relay-dot').className = 'dot good';
    facts(info);
  }
  function unreachable(err) {
    stat('relay-state', 'unreachable', 'bad');
    $('relay-dot').className = 'dot bad';
    log(err.message, 'bad');
  }

  // --------------------------------------------------------------- sign in, enrol
  async function signIn() {
    var me = await signer().getPublicKey();
    if (!/^[0-9a-f]{64}$/.test(me)) throw new Error('the extension gave no public key');
    if (state.ws) state.ws.close();
    var challenge = await connect();
    var proof = await signed(22242, [['relay', RELAY_URL], ['challenge', challenge]], '');
    if (proof.pubkey !== me) throw new Error('the extension signed with a different key than it reported');
    var answer = await new Promise(function (resolve) { state.pending.set(proof.id, resolve); send(['AUTH', proof]); });
    if (!answer.ok) throw new Error('the relay refused the sign-in: ' + answer.message);
    state.me = me;
    listRooms();
    await probeMembership();
  }
  async function probeMembership() {
    // A REQ for nothing: a member gets EOSE, anyone else CLOSED.
    try { await query({ ids: ['0'.repeat(64)] }); state.member = true; } catch (err) { state.member = false; }
    render();
    if (state.member) { await loadGroups(); await loadMail(); }
  }
  async function redeem() {
    var code = $('join-code').value.trim();
    if (!code) throw new Error('paste the invite code first');
    await publish(28934, [['-'], ['claim', code]], '');
    $('join-code').value = '';
    if (state.link && state.link.code === code) state.link.spent = true;
    await probeMembership();
  }
  // A whole nm1_ token for the room: the relay's single-use code, packed with the
  // room's declaration and key, and at once the URLs that pair a client with it.
  async function mint() {
    var room = roomSlug($('room').value);
    if (!state.me) await signIn();
    if (!state.member) throw new Error('only a member mints an invite: redeem one first');
    var events = await query({ kinds: [28935], limit: 1 });
    var invite = events[0];
    if (!invite) throw new Error('the relay sent no invite');
    if (state.relayKey && invite.pubkey !== state.relayKey) throw new Error('the invite is not signed by the relay key NIP-11 names');
    var code = tagValue(invite, 'claim');
    if (!code) throw new Error('the invite carries no claim code');
    $('invite-code').textContent = code;
    $('invite-out').hidden = false;
    var key = roomKey(room);
    var token = packInvite({ relay: RELAY_URL, campaign: room, operator: state.me, campaignKey: key.hex, code: code });
    $('room').value = room;
    listRooms();
    $('mint-status').textContent = 'Minted a token for #' + room + (key.fresh ? ', under a new room key this browser now keeps.' :
      ', under the room key this browser keeps.') + ' Pair a client with it below.';
    $('mint-status').className = 'note good';
    $('pair-token').value = token;
    await pair(token);
  }

  // ------------------------------------------------------------------------ groups
  function flagsOf(meta) { return ['private', 'restricted', 'closed', 'hidden'].filter(function (f) { return meta && meta.tags.some(function (t) { return t[0] === f; }); }); }
  function rolesOf(admins, pk) {
    if (!admins) return [];
    var t = admins.tags.find(function (x) { return x[0] === 'p' && x[1] === pk; });
    return t ? t.slice(2) : [];
  }
  function byD(events, kind) {
    var out = new Map();
    events.filter(function (e) { return e.kind === kind && e.pubkey === state.relayKey; }).forEach(function (e) { out.set(tagValue(e, 'd'), e); });
    return out;
  }
  function counted() {
    var c = state.counts;
    $('seen-count').textContent = c.groups === null && c.mail === null ? '–' :
      (c.groups === null ? '–' : c.groups) + ' · ' + (c.mail === null ? '–' : c.mail);
  }
  async function loadGroups() {
    var seats = await query({ kinds: [39002], '#p': [state.me] });
    var ids = byD(seats, 39002);
    state.counts.groups = ids.size;
    counted();
    var rows = $('group-rows');
    rows.textContent = '';
    if (ids.size === 0) { var r = el('tr'); var td = cell(r, 'You are in no group yet.'); td.colSpan = 4; rows.appendChild(r); return; }
    var state39 = await query({ kinds: [39000, 39001], '#d': Array.from(ids.keys()) });
    var metas = byD(state39, 39000), admins = byD(state39, 39001);
    ids.forEach(function (_members, id) {
      var meta = metas.get(id), row = el('tr');
      var name = el('span'); name.appendChild(el('strong', (meta && tagValue(meta, 'name')) || id));
      if (meta && tagValue(meta, 'name')) name.appendChild(el('span', '  ' + id, 'muted mono'));
      cell(row, name);
      var flags = el('span'); flagsOf(meta).forEach(function (f) { flags.appendChild(el('span', f, 'tag')); });
      cell(row, flags);
      cell(row, rolesOf(admins.get(id), state.me).join(', ') || 'member');
      var open = el('button', 'Open'); open.type = 'button';
      open.addEventListener('click', action(function () { return openGroup(id); }));
      cell(row, open);
      rows.appendChild(row);
    });
  }
  function randomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  async function createGroup() {
    var id = $('create-id').value.trim() || randomId();
    await publish(9007, [['h', id]], '');
    $('create-id').value = '';
    await loadGroups();
    await openGroup(id);
  }
  async function requestJoin() {
    var id = $('request-id').value.trim();
    var answer = await publish(9021, [['h', id]], '');
    $('request-id').value = '';
    log(answer.message || 'join request sent', 'good');
    await loadGroups();
  }
  async function openGroup(id) {
    var events = await query({ kinds: [39000, 39001, 39002], '#d': [id] });
    var meta = byD(events, 39000).get(id), admins = byD(events, 39001).get(id), members = byD(events, 39002).get(id);
    state.group = { id: id, meta: meta, admins: admins, members: members };
    $('group-card').hidden = false;
    $('group-title').textContent = (meta && tagValue(meta, 'name')) || id;
    $('group-about').textContent = ((meta && tagValue(meta, 'about')) || '') + '  (id ' + id + ')';
    var flags = $('group-flags'); flags.textContent = '';
    flagsOf(meta).forEach(function (f) { flags.appendChild(el('span', f, 'tag')); });
    var isAdmin = rolesOf(admins, state.me).indexOf('admin') >= 0;
    var rows = $('member-rows'); rows.textContent = '';
    (members ? tagValues(members, 'p') : []).forEach(function (pk) {
      var row = el('tr');
      cell(row, el('span', pk === state.me ? short(pk) + ' (you)' : short(pk), 'mono'));
      cell(row, rolesOf(admins, pk).join(', '));
      if (isAdmin && pk !== state.me) {
        var remove = el('button', 'Remove'); remove.type = 'button';
        remove.addEventListener('click', action(function () { return moderate(9001, pk, []); }));
        cell(row, remove);
      } else cell(row, '');
      rows.appendChild(row);
    });
    $('admin-tools').hidden = !isAdmin;
    if (isAdmin) {
      $('edit-name').value = (meta && tagValue(meta, 'name')) || '';
      $('edit-about').value = (meta && tagValue(meta, 'about')) || '';
      ['private', 'restricted', 'closed', 'hidden'].forEach(function (f) { $('flag-' + f).checked = flagsOf(meta).indexOf(f) >= 0; });
      await loadPending(id);
    }
  }
  async function loadPending(id) {
    var asks = await query({ kinds: [9021], '#h': [id] });
    var rows = $('pending-rows'); rows.textContent = '';
    if (asks.length === 0) { var r = el('tr'); var td = cell(r, 'No one is waiting.'); td.colSpan = 4; rows.appendChild(r); return; }
    asks.forEach(function (ask) {
      var row = el('tr');
      cell(row, el('span', short(ask.pubkey), 'mono'));
      cell(row, when(ask.created_at));
      cell(row, ask.content);
      var both = el('span');
      var yes = el('button', 'Accept'); yes.type = 'button';
      yes.addEventListener('click', action(function () { return moderate(9000, ask.pubkey, []); }));
      var no = el('button', 'Decline'); no.type = 'button';
      no.addEventListener('click', action(function () { return moderate(9001, ask.pubkey, []); }));
      both.appendChild(yes); both.appendChild(document.createTextNode(' ')); both.appendChild(no);
      cell(row, both);
      rows.appendChild(row);
    });
  }
  async function moderate(kind, pk, roles) {
    var id = state.group.id;
    await publish(kind, [['h', id], ['p', pk].concat(roles)], '');
    await openGroup(id);
  }
  async function addMember() {
    var pk = pubkeyHex($('add-key').value);
    await moderate(9000, pk, $('add-admin').checked ? ['admin'] : []);
    $('add-key').value = ''; $('add-admin').checked = false;
  }
  async function editMetadata() {
    var id = state.group.id;
    var tags = [['h', id]];
    var name = $('edit-name').value.trim(), about = $('edit-about').value.trim();
    if (name) tags.push(['name', name]);
    if (about) tags.push(['about', about]);
    ['private', 'restricted', 'closed', 'hidden'].forEach(function (f) { if ($('flag-' + f).checked) tags.push([f]); });
    await publish(9002, tags, '');
    await loadGroups();
    await openGroup(id);
  }
  async function leave() {
    var id = state.group.id;
    await publish(9022, [['h', id]], '');
    $('group-card').hidden = true;
    state.group = null;
    await loadGroups();
  }

  // ------------------------------------------------------------------------- mail
  async function loadMail() {
    var mail = await query({ kinds: [1059, 4410, 4411], '#p': [state.me] });
    state.counts.mail = mail.length;
    counted();
    var counts = {};
    mail.forEach(function (e) { counts[e.kind] = (counts[e.kind] || 0) + 1; });
    $('mail-summary').textContent = mail.length === 0 ? 'Nothing is addressed to you.' :
      Object.keys(counts).map(function (k) { return counts[k] + ' ' + (KIND_NAMES[k] || 'kind ' + k) + (counts[k] === 1 ? '' : 's'); }).join(', ');
    var rows = $('mail-rows'); rows.textContent = '';
    mail.forEach(function (e) {
      var row = el('tr');
      cell(row, KIND_NAMES[e.kind] || String(e.kind));
      cell(row, el('span', e.kind === 1059 ? 'sealed sender' : short(e.pubkey), 'mono'));
      cell(row, when(e.created_at));
      rows.appendChild(row);
    });
  }

  // ------------------------------------------------------------------------ render
  function render() {
    $('whoami').textContent = !state.me ? 'Not signed in.' :
      'Signed in as ' + short(state.me) + (state.member ? ', an enrolled member.' : ', not enrolled on this relay.');
    $('signin').textContent = state.me ? 'Sign in again' : 'Sign in with a NIP-07 extension';
    var npub = state.me ? npubOf(state.me) : null;
    $('persona-npub').textContent = npub ? npub.slice(0, 12) + '…' + npub.slice(-6) : 'not signed in';
    $('join-card').hidden = !state.me || state.member;
    ['groups-card', 'mailbox-card'].forEach(function (id) { $(id).hidden = !state.member; });
    if (!state.member) { $('group-card').hidden = true; state.counts = { groups: null, mail: null }; counted(); }
    renderLink();
  }

  var kept = storage();
  applyTheme(kept && kept.getItem(THEME_KEY));
  $('relay-url').textContent = RELAY_URL;
  state.link = takeInviteLink();
  if (state.link && usableHere(state.link)) $('join-code').value = state.link.code;
  var pairWith = state.link && !state.link.error && state.link.token && forThisRelay(state.link) ? state.link.token
    : kept && kept.getItem(TOKEN_KEY);
  renderClient();
  if (pairWith) { $('pair-token').value = pairWith; action(function () { return pair(pairWith); })(); }
  $('theme').addEventListener('click', action(toggleTheme));
  Array.from(document.querySelectorAll('#pair-clients button')).forEach(function (button) {
    button.addEventListener('click', action(function () { chooseClient(button.dataset.client); }));
  });
  $('pair-form').addEventListener('submit', action(pairGiven));
  $('pair-remember').addEventListener('change', action(remember));
  copyButton($('pair-oauth-copy'), 'pair-oauth');
  copyButton($('pair-mcp-copy'), 'pair-mcp');
  copyButton($('pair-openapi-copy'), 'pair-openapi');
  copyButton($('pair-join-copy'), 'pair-join');
  copyButton($('pair-snippet-copy'), 'pair-snippet');
  copyButton($('link-copy'), 'link-command');
  copyButton($('invite-copy'), 'invite-code');
  $('signin').addEventListener('click', action(signIn));
  $('join-form').addEventListener('submit', action(redeem));
  $('mint').addEventListener('click', action(mint));
  $('create-form').addEventListener('submit', action(createGroup));
  $('request-form').addEventListener('submit', action(requestJoin));
  $('add-form').addEventListener('submit', action(addMember));
  $('edit-form').addEventListener('submit', action(editMetadata));
  $('leave').addEventListener('click', action(leave));
  $('mail-refresh').addEventListener('click', action(loadMail));
  readInfo().catch(unreachable);
  render();
})();
`;

export function consoleHtml(): string {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    '<meta name="referrer" content="no-referrer">\n<title>Relay console</title>\n' +
    `<style>${CONSOLE_STYLE}</style>\n</head>\n<body>${BODY}<script>${CONSOLE_SCRIPT}</script>\n</body>\n</html>\n`
  );
}
