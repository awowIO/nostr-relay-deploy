// The Visual Web Console: the page a browser gets at https://<relay host>/ from the
// Cloudflare Worker. One self-contained document, served same-origin with the relay, so it
// talks to nothing but this relay's WebSocket and NIP-11 document.
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
// worker.ts serves it with a Content-Security-Policy that admits exactly this script and
// style, by SHA-256, so neither may change without the hashes changing with them. Both are
// String.raw literals: the page's own code uses no backtick and no dollar-brace.

export const CONSOLE_STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #ffffff; --ink: #17191c; --muted: #5b6270; --line: #d9dde3;
  --accent: #2f5bd3; --accent-ink: #ffffff; --good: #1d7a46; --bad: #b3261e; --code: #eef1f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111317; --panel: #1a1d23; --ink: #e8eaee; --muted: #a0a7b4; --line: #2c313a;
    --accent: #7c9cff; --accent-ink: #0d1020; --good: #6fd19a; --bad: #ff8a80; --code: #232731;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.page {
  width: 100%; max-width: none; padding-inline: clamp(20px, 4vw, 64px); padding-block: clamp(20px, 3vw, 48px);
  display: grid; gap: clamp(16px, 2vw, 28px); grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr));
}
.masthead, .wide { grid-column: 1 / -1; }
h1 { margin: 0 0 4px; font-size: clamp(1.6rem, 2.6vw, 2.4rem); }
h2 { margin: 0 0 8px; font-size: 1.15rem; }
h3 { margin: 16px 0 6px; font-size: 1rem; }
p { margin: 0 0 10px; }
.muted { color: var(--muted); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: clamp(16px, 2vw, 24px); }
.facts { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 12px 0 0; }
.facts div { display: flex; gap: 6px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; font-weight: 600; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
code { background: var(--code); padding: 1px 6px; border-radius: 6px; word-break: break-all; }
form, .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
label { display: inline-flex; gap: 6px; align-items: center; }
input[type="text"] {
  flex: 1 1 14rem; min-width: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--bg); color: var(--ink); font: inherit;
}
button {
  padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent);
  color: var(--accent-ink); font: inherit; font-weight: 600; cursor: pointer;
}
button.quiet { background: transparent; color: var(--accent); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.tag { display: inline-block; padding: 0 8px; margin: 0 4px 4px 0; border-radius: 999px; border: 1px solid var(--line); font-size: 0.85em; }
.good { color: var(--good); }
.bad { color: var(--bad); }
.scroll { overflow: auto; max-height: 24rem; }
#log { list-style: none; margin: 0; padding: 0; }
#log li { padding: 2px 0; border-bottom: 1px dashed var(--line); }
[hidden] { display: none !important; }
`;

const BODY = String.raw`
<main class="page">
  <header class="masthead card">
    <h1 id="relay-name">Relay console</h1>
    <p id="relay-about" class="muted">Reading this relay's NIP-11 document.</p>
    <dl class="facts" id="facts"></dl>
  </header>

  <section class="card" aria-labelledby="signin-title">
    <h2 id="signin-title">Sign in</h2>
    <p>This relay is private. A connection reads and writes nothing until it answers the
    relay's NIP-42 challenge, and then only as an enrolled member. The console signs through
    a NIP-07 browser extension: your secret key never reaches this page.</p>
    <div class="row"><button id="signin" type="button">Sign in with a NIP-07 extension</button></div>
    <p id="whoami" class="muted" aria-live="polite">Not signed in.</p>
  </section>

  <section class="card" id="join-card" aria-labelledby="join-title" hidden>
    <h2 id="join-title">Redeem an invite</h2>
    <p>Your key is not enrolled yet. Paste the single-use code a member gave you.</p>
    <form id="join-form">
      <input type="text" id="join-code" required autocomplete="off" spellcheck="false" aria-label="Invite code">
      <button type="submit">Redeem</button>
    </form>
  </section>

  <section class="card" id="invite-card" aria-labelledby="invite-title" hidden>
    <h2 id="invite-title">Invite someone</h2>
    <p>Mint a code for one person. It admits one key, once, and expires after seven days.
    Give it to them over a channel you trust; they redeem it here or with
    <code>nostr-mailbox join</code>.</p>
    <div class="row"><button id="mint" type="button">Mint a single-use invite</button></div>
    <div id="invite-out" class="row" hidden>
      <code id="invite-code"></code>
      <button id="invite-copy" type="button" class="quiet">Copy</button>
    </div>
  </section>

  <section class="card" id="groups-card" aria-labelledby="groups-title" hidden>
    <h2 id="groups-title">Groups</h2>
    <p class="muted">NIP-29 groups on this relay. A new group is private, restricted and
    closed: only its members read and post, and a join waits for an admin.</p>
    <div class="scroll"><table>
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
    <div class="scroll"><table>
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
      <div class="scroll"><table>
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
    <div class="row"><button id="leave" type="button" class="quiet">Leave this group</button></div>
  </section>

  <section class="card" id="mailbox-card" aria-labelledby="mailbox-title" hidden>
    <h2 id="mailbox-title">Your sealed mail</h2>
    <p class="muted">Gift wraps (1059) and mailbox envelopes and receipts (4410, 4411) reach
    only the key they name. This lists what is addressed to you; read them with your
    mailbox client.</p>
    <div class="row"><button id="mail-refresh" type="button" class="quiet">Refresh</button></div>
    <p id="mail-summary"></p>
    <div class="scroll"><table>
      <thead><tr><th>Kind</th><th>From</th><th>When</th></tr></thead>
      <tbody id="mail-rows"></tbody>
    </table></div>
  </section>

  <section class="card wide" aria-labelledby="log-title">
    <h2 id="log-title">What the relay said</h2>
    <ul id="log" aria-live="polite"></ul>
  </section>
</main>
`;

export const CONSOLE_SCRIPT = String.raw`
(function () {
  'use strict';
  var RELAY_URL = 'wss://' + location.host;
  var KIND_NAMES = { 1059: 'gift wrap', 4410: 'envelope', 4411: 'receipt' };
  var state = { ws: null, me: null, member: false, relayKey: null, challenge: null,
                pending: new Map(), subs: new Map(), seq: 0, group: null };

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

  // ------------------------------------------------------------- bech32 npub (BIP-173)
  var CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
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
  function pubkeyHex(text) {
    var s = text.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
    if (s.indexOf('npub1') !== 0) throw new Error('give an npub or a 64-hex public key');
    var data = [];
    for (var i = 5; i < s.length; i++) {
      var v = CHARSET.indexOf(s[i]);
      if (v < 0) throw new Error('that npub has a character bech32 does not use');
      data.push(v);
    }
    var hrp = [3, 3, 3, 3, 0, 14, 16, 21, 2]; // "npub", expanded as BIP-173 says
    if (data.length < 6 || polymod(hrp.concat(data)) !== 1) throw new Error('that npub has a bad checksum');
    var acc = 0, bits = 0, out = [];
    data.slice(0, -6).forEach(function (v) {
      acc = (acc << 5) | v; bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); }
      acc &= (1 << bits) - 1;
    });
    if (out.length !== 32 || bits >= 5 || acc !== 0) throw new Error('that npub is not a 32-byte key');
    return out.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
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
  }
  async function readInfo() {
    var r = await fetch('/', { headers: { Accept: 'application/nostr+json' } });
    if (!r.ok) throw new Error('NIP-11 answered HTTP ' + r.status);
    var info = await r.json();
    state.relayKey = info.self || null;
    $('relay-name').textContent = info.name || 'Relay console';
    $('relay-about').textContent = info.description || '';
    document.title = (info.name || 'Relay') + ' console';
    facts(info);
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
    await probeMembership();
  }
  async function mint() {
    var events = await query({ kinds: [28935], limit: 1 });
    var invite = events[0];
    if (!invite) throw new Error('the relay sent no invite');
    if (state.relayKey && invite.pubkey !== state.relayKey) throw new Error('the invite is not signed by the relay key NIP-11 names');
    var code = tagValue(invite, 'claim');
    if (!code) throw new Error('the invite carries no claim code');
    $('invite-code').textContent = code;
    $('invite-out').hidden = false;
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
  async function loadGroups() {
    var seats = await query({ kinds: [39002], '#p': [state.me] });
    var ids = byD(seats, 39002);
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
      var open = el('button', 'Open', 'quiet'); open.type = 'button';
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
        var remove = el('button', 'Remove', 'quiet'); remove.type = 'button';
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
      var no = el('button', 'Decline', 'quiet'); no.type = 'button';
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
    $('join-card').hidden = !state.me || state.member;
    ['invite-card', 'groups-card', 'mailbox-card'].forEach(function (id) { $(id).hidden = !state.member; });
    if (!state.member) $('group-card').hidden = true;
  }

  $('signin').addEventListener('click', action(signIn));
  $('join-form').addEventListener('submit', action(redeem));
  $('mint').addEventListener('click', action(mint));
  $('invite-copy').addEventListener('click', action(function () { return navigator.clipboard.writeText($('invite-code').textContent); }));
  $('create-form').addEventListener('submit', action(createGroup));
  $('request-form').addEventListener('submit', action(requestJoin));
  $('add-form').addEventListener('submit', action(addMember));
  $('edit-form').addEventListener('submit', action(editMetadata));
  $('leave').addEventListener('click', action(leave));
  $('mail-refresh').addEventListener('click', action(loadMail));
  readInfo().catch(function (err) { log(err.message, 'bad'); });
  render();
})();
`;

export function consoleHtml(): string {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="referrer" content="no-referrer">\n<title>Relay console</title>\n' +
    `<style>${CONSOLE_STYLE}</style>\n</head>\n<body>${BODY}<script>${CONSOLE_SCRIPT}</script>\n</body>\n</html>\n`
  );
}
