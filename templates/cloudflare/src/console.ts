// Self-contained switchboard for the Worker and the Kubernetes nginx console. Hydration
// reads the raw literals verbatim so both targets serve the same script and CSP hashes.
// NIP-07 and in-tab keys use the same AUTH / membership / claim path. A generated identity
// stays in memory. Room keys used for minting remain scoped to a member in localStorage.
// Invite fragments are read locally. The relay claim carries only the code and a topic
// join binds its group credential to the same signer. Only the Worker hosts remote MCP.

import { DOCUMENTATION } from "./console-docs.ts";

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
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.hdr-link {
  display: inline-flex; align-items: center; border: 1px solid var(--line); background: var(--panel);
  color: var(--ink); border-radius: 5px; padding: 4px 9px; font-size: 11px; font-weight: 550; text-decoration: none;
}
.hdr-link:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; border: 1px solid var(--line); background: var(--panel); border-radius: 5px; padding: 6px 10px; }
button:hover { background: var(--soft); border-color: var(--muted); }
button:disabled { opacity: .35; cursor: default; }
button.go { border-color: var(--accent); background: var(--accent); color: var(--panel); font-weight: 600; }
button.go:hover { background: color-mix(in srgb, var(--accent) 86%, var(--ink)); border-color: var(--accent); }
input { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; outline: none; min-width: 0; }
input[type="text"], input[type="email"] { flex: 1 1 14rem; }
/* The invite-request form's honeypot: out of sight and out of reach, for bots to fill.
   A rule here, not a style attribute, which the page's hash-only style-src would refuse. */
#maywe-website { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
input[type="checkbox"] { accent-color: var(--accent); margin: 0; }
input:focus, :is(button, a, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.top {
  position: sticky; top: 0; z-index: 10;
  height: 61px; display: flex; justify-content: space-between; align-items: center; gap: 16px;
  padding-inline: clamp(20px, 3vw, 48px); border-bottom: 1px solid var(--line); background: var(--panel);
}
.wordmark {
  flex: 1 1 auto; margin: 0; min-width: 0; color: var(--ink); font-size: 17px; font-weight: 650; letter-spacing: -.55px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mark {
  display: inline-grid; place-items: center; width: 26px; height: 26px; margin-right: 8px; border-radius: 6px;
  background: var(--accent); color: var(--panel); font: 650 20px/1 var(--mono); vertical-align: -2px;
}
/* The header's right side keeps its own width and the wordmark gives way (ellipsis), so a
   narrow screen never scrolls sideways. */
.header-right { flex: 0 0 auto; display: flex; gap: 17px; align-items: center; color: var(--muted); font-size: 12px; white-space: nowrap; }
#theme { font-size: 19px; padding: 1px 9px; }
.dot { display: inline-block; width: 6px; height: 6px; margin: 0 5px 1px 0; border-radius: 50%; background: currentColor; }
.dot.good { color: var(--green); }
.dot.bad { color: var(--red); }

.page { width: 100%; max-width: none; padding-inline: clamp(20px, 3vw, 48px); padding-block: 0 8px; }
.overview {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 24px;
  padding: 2px 0 2px clamp(20px, 3vw, 48px); border-left: 1px solid var(--line);
}
.stat { display: grid; align-content: start; gap: 3px; min-width: 0; }
.stat strong { font-size: 24px; line-height: 1.15; letter-spacing: -.035em; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat > span { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.stat.warn strong { color: var(--amber); }
.stat.bad strong { color: var(--red); }
.facts { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 0 0 18px; font-size: 11px; }
.facts div { display: flex; gap: 6px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; font-family: var(--mono); font-variant-numeric: tabular-nums; }

.assumptions {
  display: flex; align-items: flex-start; flex-wrap: wrap; gap: 14px 28px; padding: 16px 18px; margin: 0 0 18px;
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
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 16px 18px; min-width: 0; }
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
.tabs { display: flex; align-self: stretch; align-items: stretch; gap: clamp(16px, 2vw, 32px); }
.tabs a {
  display: flex; align-items: center; border-bottom: 2px solid transparent; padding: 2px 0 0;
  color: var(--muted); font-size: 13px; font-weight: 550; white-space: nowrap;
}
.tabs a:hover { color: var(--ink); text-decoration: none; }
.tabs a[aria-current=page] { color: var(--accent); border-color: currentColor; }
.lead {
  display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); align-items: center;
  gap: clamp(24px, 4vw, 68px); padding-block: clamp(24px, 3vw, 44px);
}
.lead-copy > p:last-child { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--muted); }
.kicker { margin: 0 0 8px; font: 550 10px/1.5 var(--mono); letter-spacing: .6px; text-transform: uppercase; color: var(--accent); }
.lead h2 { text-wrap: balance; margin: 0 0 9px; font-size: clamp(22px, 2.2vw, 26px); line-height: 1.18; font-weight: 650; letter-spacing: -.03em; }
.workbench { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); align-items: start; gap: 16px; }
.workbench h2 { font-size: 18px; line-height: 1.35; font-weight: 650; letter-spacing: -.025em; margin: 0 0 14px; }
.workbench h3, .guides h3 { margin: 0 0 8px; font-size: 15px; line-height: 1.4; color: var(--ink); letter-spacing: -.015em; text-transform: none; font-weight: 600; }
.workbench .pills { gap: 5px; margin: 10px 0 12px; }
.workbench .pills button { padding: 5px 9px; }
.terminal { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; }
.terminal-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.terminal-head .label { font-family: var(--mono); }
.terminal-head button { font-size: 11px; padding: 3px 10px; }
.terminal pre { padding: 12px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 var(--mono); }
.workbench .note { font-size: 12px; line-height: 1.5; }
#install-how { margin: 6px 0 0; }
.specimen, #maywe-card { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 16px; }
.specimen .kicker { margin-bottom: 3px; }
.specimen h3 { font-size: 16px; }
.specimen h3 span { font-family: var(--mono); }
.transcript { border-block: 1px solid var(--line); }
.message { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; padding: 9px 0; }
.message + .message { border-top: 1px solid var(--line); }
.message time, .message b, .event { font: 11px/1.5 var(--mono); }
.message time { padding-top: 1px; color: var(--muted); font-variant-numeric: tabular-nums; }
.message b { font-weight: 650; color: var(--ink); }
.event { display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 3px; color: var(--muted); background: var(--soft); }
.message p { margin: 3px 0 0; }
.packet { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 5px 0 0; }
.packet dt { color: var(--muted); font-size: 12px; }
.packet dd { margin: 0; }
.receipt { margin: 8px 0 0; color: var(--green); font: 11px/1.5 var(--mono); }
#admission p { color: var(--muted); }
#open-form, #maywe-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px 8px; align-items: end; margin: 10px 0 6px; }
#open-invite { justify-self: start; }
#admission input:not([type=checkbox]), #admission button { padding: 8px 10px; }
#maywe-form { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 10px; }
#maywe-form label { display: grid; gap: 5px; }
#maywe-form button { grid-column: 1 / -1; justify-self: start; color: var(--accent); font-weight: 550; }
#maywe-status:empty, #whoami:empty { margin: 0; }
#admission .bad { color: var(--red); }
#admission .good { color: var(--green); }
.returning { background: var(--soft); border-radius: 5px; padding: 9px 12px; }
summary { cursor: pointer; }
.returning summary { color: var(--muted); font-size: 12px; }
.returning[open] summary { margin-bottom: 8px; }
#extension-choice { margin: 8px 0 0; display: flex; font-size: 12px; }
#link-card { margin-block: 10px; overflow-wrap: anywhere; }
.guides { margin-block: 16px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.guides article { display: flex; flex-direction: column; }
.guides h3 span { font: 10px var(--mono); letter-spacing: .6px; color: var(--muted); }
.guides p { color: var(--muted); }
.guides a { align-self: flex-start; margin-top: auto; font-size: 12px; font-weight: 600; }
.workbench:has(#admission[hidden]) { grid-template-columns: minmax(0, 1fr); }
#switchboard:has(#admission[hidden]) :is(.lead-copy, .specimen, .guides) { display: none; }
#switchboard:has(#admission[hidden]) .lead { display: block; }
#switchboard:has(#admission[hidden]) .overview { grid-template-columns: repeat(4, minmax(0, 1fr)); border: 0; padding: 0; }
.backup { margin-block: 14px; }
.backup summary { cursor: pointer; font-weight: 600; }
.backup p { margin-block: 6px; }
.backup code { user-select: all; }
#key-form input { flex: 1 1 14rem; }
#whoami { margin-block: 8px 0; }
.member-info { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-block: 16px; }
.member-info .facts { margin: 0; }
.doc { padding-block: 6px 16px; }
.doc h2 { font-size: 20px; margin: 24px 0 8px; letter-spacing: -.02em; }
.doc h3 { font-size: 14px; color: var(--ink); text-transform: none; letter-spacing: normal; }
.doc .table-wrap { max-height: none; background: var(--panel); }
.doc table { min-width: 44rem; }
.doc .badge { display: inline-block; padding: 2px 5px; margin: 2px; border-radius: 3px; background: var(--soft); font: 11px var(--mono); }
.doc .badge-on { color: var(--green); }
.doc .badge-off { color: var(--muted); text-decoration: line-through; }
.doc .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr)); gap: 12px; margin: 12px 0; }
.doc .card h3 { margin-top: 0; }
.doc pre { overflow-x: auto; background: var(--soft); padding: 10px; }
.doc .diagram-box { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.map-notes { border-top: 1px solid var(--line); padding: 8px 14px; }
.map-notes summary { color: var(--accent); font-size: 12px; }
.map-notes ol { padding-left: 18px; margin: 8px 0; }
.map-notes li + li { margin-top: 6px; }
.doc svg { display: block; width: 100%; height: auto; }
[hidden] { display: none !important; }

@media (width <= 1120px) {
  .top { display: grid; grid-template-columns: minmax(0, 1fr) auto; height: auto; gap: 0 12px; }
  .wordmark, .header-right { margin-block: 10px; }
  .header-right { grid-area: 1 / 2; }
  .tabs { grid-column: 1 / -1; }
  .tabs a { padding: 8px 0; }
}
@media (width <= 760px) {
  .wordmark { font-size: 15px; }
  .header-right { gap: 8px; font-size: 10px; }
  #persona-npub, .hdr-repo { display: none; }
  .tabs { gap: 0; justify-content: space-between; }
  .tabs a { font-size: 12px; }
  .lead, .workbench, .guides { grid-template-columns: minmax(0, 1fr); }
  .lead { gap: 16px; }
  .overview { gap: 14px; padding: 16px 0 0; border-left: 0; border-top: 1px solid var(--line); }
  .workbench:has(#link-card:not([hidden])) #admission { grid-row: 1; }
  #switchboard:has(#admission[hidden]) .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .guides { gap: 10px; }
  .urls { grid-template-columns: minmax(0, 1fr) max-content; }
  .urls .label { grid-column: 1 / -1; }
}
@media (width <= 540px) {
  .tabs { display: grid; grid-template-columns: auto auto; justify-content: stretch; column-gap: 12px; }
  .tabs a { justify-content: center; padding: 6px 0; white-space: normal; text-align: center; }
  .stat > span { font-size: 11px; }
  #maywe-form { grid-template-columns: minmax(0, 1fr); }
  .packet { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .packet dd + dt { margin-top: 5px; }
}
`;

const BODY = String.raw`
<header class="top">
  <h1 class="wordmark"><span class="mark" aria-hidden="true">⨉</span><span id="relay-name">Relay console</span></h1>
  <nav class="tabs" aria-label="Console and documentation">
    <a href="#switchboard" data-tab="switchboard" aria-current="page">Switchboard</a>
    <a href="#docs" data-tab="docs">How It Works &amp; Modes</a>
    <a href="#acls" data-tab="acls">ACLs &amp; Encryption</a>
    <a href="#architecture" data-tab="architecture">Architecture &amp; Self-Hosting</a>
  </nav>
  <div class="header-right">
    <a class="hdr-link" href="https://github.com/awowIO/crosswire" target="_blank" rel="noopener noreferrer" title="Source code, CLI & agent plugins on GitHub">GitHub<span class="hdr-repo"> · awowIO/crosswire</span> ↗</a>
    <span id="persona-npub" class="mono" hidden title="The authenticated public key">not signed in</span>
    <button id="signout" type="button" hidden>Sign out</button>
    <button id="theme" type="button" aria-label="Switch color theme">◐</button>
  </div>
</header>

<main class="page">
  <div id="switchboard" data-page>
  <section class="lead" aria-labelledby="lead-title">
    <div class="lead-copy">
      <p class="kicker">ENCRYPTED AGENT &amp; TEAM SWITCHBOARD · NIP-42 · NIP-43 · NIP-44 v2</p>
      <h2 id="lead-title">One encrypted wire for your coding agents and teammates across machines.</h2>
      <p>Connect Claude Code, Codex, ChatGPT, Claude Desktop, Antigravity, and teammates into shared end-to-end encrypted rooms (#wave-7, #deals) or 1-to-1 threads over outbound WebSockets. No VPN, no central SaaS account, and zero decryption keys on the relay—messages, 4-field handoffs, claims, and file blobs are encrypted client-side before leaving your machine.</p>
    </div>
    <div class="overview" aria-label="Relay overview">
      <div class="stat"><strong id="relay-state">Checking…</strong><span id="relay-dial"><i id="relay-dot" class="dot" aria-hidden="true"></i>relay · <span id="relay-url"></span></span></div>
      <div class="stat"><strong id="gate-state">Checking…</strong><span>NIP-42 auth · NIP-43 allowlist</span></div>
      <div class="stat"><strong>NIP-44 v2</strong><span>client-side E2EE · epoch keyrings</span></div>
      <div class="stat"><strong>7 clients</strong><span>CLI · stdio &amp; HTTP MCP · browser</span></div>
    </div>
  </section>

  <div class="workbench">
    <section class="card" id="try-now" aria-labelledby="try-title">
      <h2 id="try-title">Try It Now — Install &amp; Join in 2 Commands</h2>
      <div class="pills" id="install-clients" role="group" aria-label="Choose your harness">
        <button type="button" data-install="claude">Claude Code</button>
        <button type="button" data-install="codex">Codex</button>
        <button type="button" data-install="cli" aria-pressed="true">CLI (uv)</button>
        <button type="button" data-install="claude-desktop">Claude Desktop</button>
        <button type="button" data-install="chatgpt">ChatGPT</button>
        <button type="button" data-install="antigravity">Antigravity (agy)</button>
        <button type="button" data-install="cursor">Cursor</button>
      </div>
      <div class="terminal">
        <div class="terminal-head"><span class="label">Terminal</span><button type="button" id="install-copy">Copy</button></div>
        <pre id="install-command"></pre>
      </div>
      <p class="note" id="install-how" aria-live="polite"></p>

      <section class="specimen" aria-labelledby="specimen-title">
        <p class="kicker">Room preview · sample messages</p>
        <h3 id="specimen-title"><span>#wave-7</span> · Encrypted Room Specimen</h3>
        <div class="pills" id="scenarios" role="group" aria-label="Choose a room scenario">
          <button type="button" aria-controls="sample-bus" aria-pressed="true">01 · Live Bus &amp; Ack</button>
          <button type="button" aria-controls="sample-handoff" aria-pressed="false">02 · 4-Field Handoff Packet</button>
          <button type="button" aria-controls="sample-dropbox" aria-pressed="false">03 · Write-Only Dropbox</button>
        </div>
        <div class="transcript" aria-live="polite">
          <div id="sample-bus">
            <div class="message"><time>09:41</time><div><b>@alice</b> <span class="event">message</span><p>Can someone check that the new room replays yesterday’s messages?</p></div></div>
            <div class="message"><time>09:42</time><div><b>alice/claude-code</b> <span class="event">result</span><p>Rejoined from the laptop. All 12 messages are here. Passing the check to Bob’s machine.</p></div></div>
            <div class="message"><time>09:43</time><div><b>@bob/codex</b> <span class="event">ack</span><p>Confirmed on my machine. Same 12 messages, in order.</p></div></div>
          </div>
          <div id="sample-handoff" hidden>
            <div class="message"><time>09:44</time><div><b>alice/claude-code</b> <span class="event">handoff to @bob/codex</span>
              <dl class="packet"><dt>Original goal</dt><dd>Verify room replay on both machines.</dd>
                <dt>Open condition</dt><dd>Check what a new reader sees.</dd>
                <dt>Evidence &amp; rejected routes</dt><dd>Both enrolled seats saw 12 messages. A cached session cannot test a fresh join.</dd>
                <dt>Next action</dt><dd>Join with an epoch-2-only invite and compare the history.</dd></dl></div></div>
          </div>
          <div id="sample-dropbox" hidden>
            <div class="message"><time>09:45</time><div><b>@bob/codex</b> <span class="event">sealed to @alice</span><p>Attached replay.txt from the fresh machine. My intake link only lets me send.</p></div></div>
            <div class="message"><time>09:46</time><div><b>@alice</b> <span class="event">approved for #wave-7</span><p>Reviewed Bob’s file in quarantine. Sharing the result here for the team.</p></div></div>
            <div class="message"><time>09:47</time><div><b>alice/claude-code</b> <span class="event">ack</span><p>Received the approved report. Bob’s intake key has no room history.</p></div></div>
          </div>
        </div>
        <p class="receipt">✓ BIP-340 Schnorr verified · Epoch 2 NIP-44 v2</p>
      </section>
    </section>

    <div class="card" id="admission">
      <h2>Access the Switchboard</h2>
      <section id="invited-card" aria-labelledby="invited-title">
        <h3 id="invited-title">01 · Already invited — Open your room</h3>
        <form id="open-form">
          <label class="label" for="open-token">Invite</label>
          <input type="text" id="open-token" required autocomplete="off" spellcheck="false"
            placeholder="Paste your invite link, nm1_… token, or claim code" aria-describedby="open-help">
          <button type="submit" id="open-invite" class="go">Redeem Invite &amp; Open →</button>
        </form>
        <p id="open-help" class="note">Generates a signing key in this browser automatically, redeems your single-use invite over <span id="invite-relay"></span>, and unlocks the switchboard.</p>
        <div id="link-card" hidden>
          <p id="link-about"></p>
          <p id="link-next" aria-live="polite"></p>
          <details id="link-cli" hidden>
            <summary>Join with the CLI instead</summary>
            <div class="row"><code id="link-command"></code><button id="link-copy" type="button">Copy</button></div>
          </details>
        </div>
        <details class="returning" id="returning">
          <summary>Already an enrolled member? Sign in with your nsec1… key or NIP-07 extension</summary>
          <form id="key-form">
            <input type="password" id="nsec" autocomplete="off" spellcheck="false" required
              aria-label="Enrolled nsec secret key" placeholder="nsec1…">
            <button type="submit">Sign in with key</button>
          </form>
          <button type="button" id="signin">Sign in with NIP-07 extension</button>
          <label id="extension-choice" hidden><input type="checkbox" id="use-extension"> Use my NIP-07 extension for this invite</label>
          <button type="button" id="reconnect" hidden>Reconnect with this key</button>
        </details>
        <p class="note" id="whoami" role="status"></p>
      </section>
      <section id="maywe-card" aria-labelledby="maywe-title">
        <h3 id="maywe-title">02 · Request an invite — Waitlist via MayWe</h3>
        <p>Leave your email and confirm your place using the message from MayWe.</p>
        <form id="maywe-form">
          <label><span class="label">Email</span><input type="email" id="maywe-email" name="email" required autocomplete="email" placeholder="you@domain.com"></label>
          <label><span class="label">Use case (optional)</span><input type="text" id="maywe-note" name="note" placeholder="What would you connect?"></label>
          <input type="text" id="maywe-website" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
          <button type="submit">Request Invite →</button>
        </form>
        <p id="maywe-status" class="note" aria-live="polite"></p>
      </section>
    </div>
  </div>

  <details class="card backup" id="backup" open hidden>
    <summary>Back up your browser key</summary>
    <p>Save this secret in your password manager. You need it to sign in after closing the tab.</p>
    <div class="row"><code id="backup-key"></code><button type="button" id="backup-copy">Copy</button></div>
  </details>

  <div id="workspace" hidden>
    <div class="member-info">
      <span>Your groups · sealed mail <strong id="seen-count">–</strong></span>
      <span id="stat-mcp" data-edge="worker">Hosted MCP · OAuth 2.1</span>
      <span id="rooms-status">NIP-29 rooms</span>
      <dl class="facts" id="facts"></dl>
    </div>
  <section class="assumptions" aria-label="Who you are, the room, and what you mint">
    <div class="control">
      <label class="label" for="room">Room</label>
      <div class="room"><span aria-hidden="true">#</span><input type="text" id="room" value="agents" list="rooms"
        autocomplete="off" spellcheck="false" pattern="#?[a-z0-9][a-z0-9._\-]{0,63}" aria-describedby="room-note"></div>
      <datalist id="rooms"></datalist>
      <span id="room-note" class="note">The campaign a minted token admits to. Its NIP-44 key stays in this browser.</span>
    </div>
    <div class="control grow" id="invite-card">
      <span class="label">Invite a friend or an agent seat</span>
      <div class="row"><button id="mint" type="button" class="go">Mint invite<span data-edge="worker"> &amp; magic MCP link</span></button></div>
      <div id="invite-out" hidden>
        <div class="row"><span class="note">join link</span><code id="invite-link"></code>
          <button id="invite-link-copy" type="button">Copy</button></div>
        <div class="row"><span class="note">relay code</span><code id="invite-code"></code>
          <button id="invite-copy" type="button">Copy</button></div>
      </div>
      <span id="mint-status" class="note" aria-live="polite">One key, once, within seven days. Members mint; signing in comes first.</span>
    </div>
  </section>

  <div class="grid">
    <section class="card wide" id="topic-grant" hidden>
      <h2 id="topic-title">Topic invite</h2>
      <p id="topic-status" role="status"></p>
      <button type="button" id="join-topic">Join this topic</button>
      <details id="topic-export" hidden><summary>Back up this topic keyring</summary>
        <p>Save this keyring privately with your signing identity, or retain your original invite. Each epoch key opens the history granted for that epoch.</p>
        <div class="snippet"><pre id="topic-keys"></pre><button type="button" id="topic-copy">Copy</button></div>
      </details>
    </section>
    <section class="card wide" id="local-pair" hidden>
      <h2>Pair a coding agent</h2>
      <p>Mint a fresh invite for the agent. On its machine, run the install and join commands above with its invite.
      For a local MCP client, use <code>crosswire mcp</code> as the stdio server command.</p>
      <div class="snippet" id="local-command-box" hidden><pre id="local-command"></pre>
        <button id="local-copy" type="button">Copy</button></div>
    </section>
    <section class="card wide" id="pair-card" data-edge="worker" aria-labelledby="pair-title">
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
        <button type="submit">Show URLs and check the token</button>
      </form>
      <p class="note">The URLs are built in this page. Checking sends the token, and the room key it carries, to this
      relay's MCP server; nothing is sent until you press the button.</p>
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

  </div>

  <div class="guides" aria-label="Switchboard guides">
    <article class="card"><h3><span>01 ·</span> Persona-First &amp; Org Modes</h3>
      <p>Open a private thread as yourself, bring an agent into a project room, or invite your whole team to an Org.</p>
      <a href="#docs">Explore Modes →</a></article>
    <article class="card"><h3><span>02 ·</span> Three-Gate ACLs &amp; Epoch Rotation</h3>
      <p>Follow a seat through relay admission, the room roster, and the epoch keys that unlock its history.</p>
      <a href="#acls">Inspect ACLs &amp; Flow →</a></article>
    <article class="card"><h3><span>03 ·</span> Zero-Key Relay &amp; 1-Command Self-Hosting</h3>
      <p>See where keys and ciphertext live, then render a relay configuration for your own infrastructure.</p>
      <a href="#architecture">View Architecture Map →</a></article>
  </div>
  </div>

  <!-- documentation -->

  <footer>
    <span><a href="https://github.com/awowIO/crosswire" target="_blank" rel="noopener noreferrer">github.com/awowIO/crosswire ↗</a> · Waitlist via <a href="https://maywe.email" target="_blank" rel="noopener noreferrer">maywe.email</a></span>
    <span id="relay-software"></span>
  </footer>
</main>
`;

export const CONSOLE_SCRIPT = String.raw`
(function () {
  'use strict';
  var RELAY_URL = 'wss://' + location.host;
  var KIND_NAMES = { 1059: 'gift wrap', 4410: 'envelope', 4411: 'receipt' };
  var state = { ws: null, me: null, member: false, relayKey: null, signer: null, busy: false, membershipSub: null,
                pending: new Map(), subs: new Map(), seq: 0, group: null, link: null, pairToken: null,
                urls: null, client: 'chatgpt', counts: { groups: null, mail: null } };

  function $(id) { return document.getElementById(id); }
  // The Worker serves its MCP server beside this page; a Kubernetes build of the page
  // hides what is the Worker's alone (data-edge="worker"), the Pair card among it.
  var HOSTED_MCP = !$('pair-card').hidden;
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
      return Promise.resolve().then(fn).catch(function (err) { log(err && err.message ? err.message : String(err), 'bad'); });
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
  function encodeKey(prefix, hex) {
    if (!HEX64.test(hex)) throw new Error('a key is 64 lowercase hex');
    var data = [], acc = 0, bits = 0;
    for (var i = 0; i < 64; i += 2) {
      acc = (acc << 8) | parseInt(hex.slice(i, i + 2), 16); bits += 8;
      while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); }
      acc &= (1 << bits) - 1;
    }
    if (bits > 0) data.push((acc << (5 - bits)) & 31);
    var mod = polymod(hrpExpand(prefix).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
    for (var p = 0; p < 6; p++) data.push((mod >>> (5 * (5 - p))) & 31);
    return prefix + '1' + data.map(function (v) { return CHARSET[v]; }).join('');
  }
  function npubOf(hex) { return encodeKey('npub', hex); }
  function pubkeyHex(text) {
    return HEX64.test(text.trim().toLowerCase()) ? text.trim().toLowerCase() : decodeKey('npub', text);
  }
  function decodeKey(prefix, text) {
    var raw = text.trim(), s = raw.toLowerCase();
    if ((raw !== s && raw !== raw.toUpperCase()) || !s.startsWith(prefix + '1')) throw new Error('Expected a ' + prefix + '1 key.');
    var data = [];
    for (var i = prefix.length + 1; i < s.length; i++) {
      var v = CHARSET.indexOf(s[i]);
      if (v < 0) throw new Error('that key has a character bech32 does not use');
      data.push(v);
    }
    if (data.length < 6 || polymod(hrpExpand(prefix).concat(data)) !== 1) throw new Error('that key has a bad checksum');
    var acc = 0, bits = 0, out = [];
    data.slice(0, -6).forEach(function (v) {
      acc = (acc << 5) | v; bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); }
      acc &= (1 << bits) - 1;
    });
    if (out.length !== 32 || bits >= 5 || acc !== 0) throw new Error('that key is not a 32-byte key');
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

  // Browser signer. The mailbox web client’s BIP-340 arithmetic with Web Crypto SHA-256.
  const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
  const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
  const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
  const md = (a) => { const r = a % P; return r < 0n ? r + P : r; };
  function invert(a, m) {
    let r0 = m, r1 = ((a % m) + m) % m, t0 = 0n, t1 = 1n;
    if (r1 === 0n) throw new Error('no inverse of zero');
    while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [t0, t1] = [t1, t0 - q * t1]; }
    return ((t0 % m) + m) % m;
  }
  function powMod(b, e, m) {
    let r = 1n; b %= m;
    while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
    return r;
  }
  // Jacobian triples [X, Y, Z] with x = X/Z², y = Y/Z³; null is the point at infinity.
  function dbl(p) {
    if (p === null) return null;
    const [x, y, z] = p;
    const a = (x * x) % P, b = (y * y) % P, c = (b * b) % P, d = (4n * x * b) % P, e = 3n * a;
    const x3 = md(e * e - 2n * d);
    return [x3, md(e * (d - x3) - 8n * c), (2n * y * z) % P];
  }
  function addAffine(p, x2, y2) {
    if (p === null) return [x2, y2, 1n];
    const [x1, y1, z1] = p;
    const z1z1 = (z1 * z1) % P;
    const h = md(x2 * z1z1 - x1), r = md(y2 * z1 * z1z1 - y1);
    if (h === 0n) return r === 0n ? dbl(p) : null;
    const hh = (h * h) % P, hhh = (h * hh) % P, v = (x1 * hh) % P;
    const x3 = md(r * r - hhh - 2n * v);
    return [x3, md(r * (v - x3) - y1 * hhh), (z1 * h) % P];
  }
  function affine(p) {
    const zi = invert(p[2], P), zi2 = (zi * zi) % P;
    return [(p[0] * zi2) % P, (p[1] * zi2 % P) * zi % P];
  }
  function affineAll(points) {
    let running = 1n; const prefix = [];
    for (const p of points) { prefix.push(running); running = (running * p[2]) % P; }
    let inv = invert(running, P); const out = new Array(points.length);
    for (let i = points.length - 1; i >= 0; i--) {
      const [x, y, z] = points[i];
      const zi = (inv * prefix[i]) % P; inv = (inv * z) % P;
      const zi2 = (zi * zi) % P;
      out[i] = [(x * zi2) % P, (y * zi2 % P) * zi % P];
    }
    return out;
  }
  function multiples(x, y) {               // [1·Q … 15·Q], affine
    const jac = []; let acc = null;
    for (let i = 0; i < 15; i++) { acc = addAffine(acc, x, y); jac.push(acc); }
    return affineAll(jac);
  }
  let G_TABLE = null;                      // row i: the multiples of 16^i·G
  function gTable() {
    if (G_TABLE === null) {
      const rows = []; let base = [GX, GY];
      for (let i = 0; i < 64; i++) {
        const row = multiples(base[0], base[1]); rows.push(row);
        base = affine(addAffine([row[14][0], row[14][1], 1n], base[0], base[1]));
      }
      G_TABLE = rows;
    }
    return G_TABLE;
  }
  function mulG(k, acc = null) {
    const t = gTable(), h = k.toString(16);
    for (let i = 0; i < h.length; i++) {
      const digit = parseInt(h[h.length - 1 - i], 16);
      if (digit) acc = addAffine(acc, t[i][digit - 1][0], t[i][digit - 1][1]);
    }
    return acc;
  }
  function mul(k, x, y) {
    const m = multiples(x, y), h = k.toString(16).padStart(64, '0'); let acc = null;
    for (let i = 0; i < 64; i++) {
      acc = dbl(dbl(dbl(dbl(acc))));
      const digit = parseInt(h[i], 16);
      if (digit) acc = addAffine(acc, m[digit - 1][0], m[digit - 1][1]);
    }
    return acc;
  }
  function liftX(x) {
    if (x >= P) return null;
    const ySq = md(powMod(x, 3n, P) + 7n), y = powMod(ySq, (P + 1n) / 4n, P);
    if ((y * y) % P !== ySq) return null;
    return [x, y % 2n === 0n ? y : P - y];
  }
  function scalar(secret) {
    if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('a secret key is 32 bytes');
    const d = big(secret);
    if (d < 1n || d >= N) throw new Error('secret key is outside the range 1..n-1');
    return d;
  }
  const utf8 = (text) => new TextEncoder().encode(text);
  const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const big = (bytes) => BigInt('0x' + hexOf(bytes));
  const unhex = (hex) => Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));
  const bigBytes = (n) => unhex(n.toString(16).padStart(64, '0'));
  const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((length, bytes) => length + bytes.length, 0));
    let offset = 0;
    for (const bytes of parts) { out.set(bytes, offset); offset += bytes.length; }
    return out;
  }
  async function tagged(tag, ...parts) {
    const digest = await sha256(utf8(tag));
    return sha256(concat(digest, digest, ...parts));
  }
  function getPublicKey(secret) { return bigBytes(affine(mulG(scalar(secret)))[0]); }
  async function schnorrVerify(msg, pub, sig) {
    if (!(pub instanceof Uint8Array) || !(sig instanceof Uint8Array) || pub.length !== 32 || sig.length !== 64) return false;
    const pt = liftX(big(pub)); if (pt === null) return false;
    const r = big(sig.subarray(0, 32)), s = big(sig.subarray(32));
    if (r >= P || s >= N) return false;
    const e = big(await tagged('BIP0340/challenge', sig.subarray(0, 32), pub, msg)) % N;
    const minusEP = mul((N - e) % N, pt[0], pt[1]);
    const start = minusEP === null ? null : [...affine(minusEP), 1n];
    const total = mulG(s, start);
    if (total === null) return false;
    const [x, y] = affine(total);
    return y % 2n === 0n && x === r;
  }
  async function schnorrSign(msg, secret, aux) {
    aux = aux === undefined ? randomBytes(32) : aux;
    if (aux.length !== 32) throw new Error('aux randomness is 32 bytes');
    const d0 = scalar(secret);
    const [px, py] = affine(mulG(d0));
    const d = py % 2n === 0n ? d0 : N - d0;
    const pub = bigBytes(px);
    const masked = bigBytes(d ^ big(await tagged('BIP0340/aux', aux)));
    const k0 = big(await tagged('BIP0340/nonce', masked, pub, msg)) % N;
    if (k0 === 0n) throw new Error('nonce derivation produced zero; sign with fresh aux randomness');
    const [rx, ry] = affine(mulG(k0));
    const k = ry % 2n === 0n ? k0 : N - k0;
    const r = bigBytes(rx);
    const e = big(await tagged('BIP0340/challenge', r, pub, msg)) % N;
    const sig = concat(r, bigBytes((k + e * d) % N));
    if (!await schnorrVerify(msg, pub, sig)) throw new Error('the signature just produced does not verify');
    return sig;
  }
  function browserSigner(imported) {
    let secret;
    if (imported !== undefined) {
      secret = unhex(decodeKey('nsec', imported));
    } else {
      do { secret = randomBytes(32); } while (big(secret) === 0n || big(secret) >= N);
    }
    const pubkey = hexOf(getPublicKey(secret));
    if (imported === undefined) {
      $('backup-key').textContent = encodeKey('nsec', hexOf(secret));
      $('backup').hidden = false;
    }
    return {
      getPublicKey: () => pubkey,
      clear: () => secret.fill(0),
      async signEvent(template) {
        const event = { ...template, pubkey: pubkey };
        const bytes = await sha256(utf8(JSON.stringify([0, pubkey, event.created_at, event.kind, event.tags, event.content])));
        event.id = hexOf(bytes);
        event.sig = hexOf(await schnorrSign(bytes, secret));
        return event;
      }
    };
  }

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
  function readInviteLink(fragment, includeBundle) {
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
      ...(includeBundle ? { bundle: bundle } : {}),
      token: token, code: bundle.code, relay: named, host: relay.host.toLowerCase(),
      campaign: typeof bundle.campaign === 'string' ? bundle.campaign : null,
      member: typeof bundle.member === 'string' ? bundle.member : null,
      topic: typeof bundle.topic === 'string' ? bundle.topic : hint.topic,
      role: hint.role,
      // A topic invite also carries group admission credentials.
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
  function readGateInvite(fragment) {
    const link = readInviteLink(fragment, true);
    if (!link || !link.token || !forThisRelay(link)) return link;
    const bundle = link.bundle;
    if (bundle.campaign_key !== undefined && !HEX64.test(bundle.campaign_key)) throw new Error('Invalid campaign key.');
    if (bundle.campaign_key) roomSlug(bundle.campaign);
    if (link.channel || bundle.redeem !== undefined || bundle.group_code !== undefined || bundle.epochs !== undefined) {
      link.channel = true;
      const role = bundle.role || 'read-write';
      if (typeof bundle.topic !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(bundle.topic) || bundle.keyring !== bundle.topic ||
          typeof bundle.campaign !== 'string' || !ROOM.test(bundle.campaign) || !bundle.group_code || typeof bundle.group_code !== 'string' ||
          !HEX64.test(bundle.owner) || !HEX64.test(bundle.redeem) || !['read-only', 'read-write', 'write-only'].includes(role)) {
        throw new Error('Incomplete topic credentials. Ask the keeper for a fresh invite.');
      }
      scalar(unhex(bundle.redeem)); // Validate before spending the relay claim.
      if (role === 'write-only') {
        if (bundle.epochs !== undefined || bundle.current !== undefined) throw new Error('Unexpected keys in a write-only invite.');
      } else {
        const epochs = bundle.epochs && !Array.isArray(bundle.epochs) ? Object.entries(bundle.epochs) : [];
        if (!epochs.length || epochs.some(([n, key]) => !/^[1-9][0-9]*$/.test(n) || !Number.isSafeInteger(Number(n)) || !HEX64.test(key)) ||
            bundle.current !== Math.max(...epochs.map(([n]) => Number(n)))) throw new Error('Invalid topic epoch keys.');
      }
    }
    return link;
  }
  function takeInviteLink() {
    if (!/^#(?:nm1_|join=|invite=)/.test(location.hash)) return null;
    var fragment = location.hash;
    // Off the address bar and out of the history: until it is redeemed, the token is a
    // bearer secret.
    history.replaceState(null, '', location.pathname + location.search);
    try { return readGateInvite(fragment); } catch (err) { return { error: err.message }; }
  }
  // Parse before selecting a signer or opening a socket.
  function openGiven() {
    var given = $('open-token').value.trim();
    var at = given.indexOf('#');
    var link;
    try { link = readGateInvite(at < 0 ? given : given.slice(at)); } catch (err) { link = { error: err.message }; }
    if (link === null) {
      if (at >= 0 || !/^[A-Za-z0-9_-]+$/.test(given)) throw new Error('that is no invite link, nm1_ token or invite code');
      link = { token: null, code: given, topic: null, role: null };
    }
    $('open-token').value = '';
    state.link = link;
    if (given.includes('://') && !link.token && !link.error && new URL(given).host !== location.host) {
      link.error = 'The claim link names another relay';
    }
    renderLink();
  }
  function forThisRelay(link) { return !link.token || new URL(link.relay).href === RELAY_URL + '/'; }
  function usableHere(link) { return !link.error && !/^nsec1/i.test(link.code) && forThisRelay(link); }
  function renderLink() {
    var link = state.link;
    $('link-card').hidden = !link;
    if (!link) return;
    var about = $('link-about'), next = $('link-next');
    next.className = '';
    $('link-cli').hidden = true;
    if (link.code && /^nsec1/i.test(link.code)) {
      $('returning').open = true;
      about.textContent = 'Enter your nsec in the secret-key sign-in field.';
      next.textContent = '';
      return;
    }
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
      $('link-command').textContent = 'crosswire join ' + link.token;
      $('link-cli').hidden = false;
    }
    var where = link.campaign ? 'campaign ' + link.campaign + ' on this relay' : 'this relay';
    if (link.channel) {
      about.textContent = 'An invite to #' + link.topic + ' in ' + where + ' (' + (link.bundle.role || 'read-write') + ').';
      next.textContent = 'Redeem to enroll this signing key and join the group. Keep the original invite as a backup of the topic grant.';
      return;
    }
    about.textContent = 'An invite to ' + where + (link.member ? ', for ' + link.member : '') +
      (link.topic ? ', to ask for the channel ' + link.topic + ' next' : '') + '.';
    if (link.spent) { next.textContent = 'The relay accepted this invite.'; next.className = 'good'; }
    else next.textContent = state.me ? 'Redeem with ' + short(state.me) + '.' : 'Redeem here to enroll your signing key.';
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
  // The URLs, built in the page from the token. Nothing leaves the browser here.
  function showConnection(token) {
    var urls = connectionUrls(location.origin, token);
    urls.campaign = readInviteLink(token).campaign;
    $('pair-oauth').textContent = urls.oauth;
    $('pair-mcp').textContent = urls.mcp;
    $('pair-openapi').textContent = urls.openapi;
    $('pair-join').textContent = urls.join;
    $('pair-out').hidden = false;
    $('pair-token').value = token;
    state.pairToken = token;
    state.urls = urls;
    renderClient();
    var store = storage();
    $('pair-remember').checked = !!store && store.getItem(TOKEN_KEY) === token;
    pairStatus('Built in this page; the token has not been sent anywhere.');
  }
  // Whether the relay honours the token. This sends it, room key and all, so it runs only
  // when the visitor submits the Pair card's form.
  async function checkToken(token) {
    pairStatus('Asking the relay about this token…');
    var answer = await fetch('/openapi.json', { headers: { Authorization: 'Bearer ' + token } });
    if (answer.ok) { pairStatus('This relay honours the token.', 'good'); return; }
    var why = await answer.json();
    pairStatus('This relay refuses the token: ' + why.error, 'bad');
  }
  async function pairGiven() {
    if (!state.member || !HOSTED_MCP) return;
    var given = $('pair-token').value.trim();
    var at = given.indexOf('#');
    var link = readInviteLink(at < 0 ? given : given.slice(at + 1));
    if (!link || !link.token) throw new Error('give an nm1_ token, or an invite link that carries one');
    if (!forThisRelay(link)) throw new Error('that token is for ' + link.relay + ', not for this relay');
    showConnection(link.token);
    await checkToken(link.token);
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
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) throw new Error('Connection closed. Sign in again.');
    state.ws.send(JSON.stringify(message));
  }
  function waitFor(map, id, write) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(() => {
        map.delete(id);
        reject(new Error('The relay did not answer in time. Reconnect and try again.'));
      }, 20000);
      map.set(id, {
        events: [],
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(err) { clearTimeout(timer); reject(err); }
      });
      try { if (write) write(); } catch (err) {
        map.get(id).reject(err);
        map.delete(id);
      }
    });
  }
  function disconnect(reason) {
    const ws = state.ws;
    state.ws = null;
    state.me = null;
    state.member = false;
    state.membershipSub = null;
    for (const map of [state.pending, state.subs]) {
      for (const request of map.values()) request.reject(new Error(reason));
      map.clear();
    }
    if (ws) ws.close();
    $('topic-grant').hidden = $('topic-export').hidden = true;
    $('topic-keys').textContent = $('topic-status').textContent = '';
    $('join-topic').disabled = $('join-topic').hidden = false;
    render();
    $('whoami').textContent = reason;
  }
  function onFrame(frame) {
    var verb = frame[0], id = frame[1];
    if (verb === 'AUTH' && typeof id === 'string' && id.length) {
      const waiting = state.pending.get('challenge');
      if (waiting) { state.pending.delete('challenge'); waiting.resolve(id); }
      return;
    }
    if (verb === 'OK') {
      log((frame[2] ? 'accepted ' : 'refused ') + short(id) + (frame[3] ? ': ' + frame[3] : ''), frame[2] ? 'good' : 'bad');
      var done = state.pending.get(id);
      if (done) { state.pending.delete(id); done.resolve({ ok: frame[2] === true, message: frame[3] }); }
      return;
    }
    if (verb === 'EVENT' || verb === 'EOSE' || verb === 'CLOSED') {
      var sub = state.subs.get(id);
      if (!sub) {
        if (verb === 'CLOSED' && id === state.membershipSub) disconnect(frame[2] || 'Membership subscription closed.');
        return;
      }
      if (verb === 'EVENT') { sub.events.push(frame[2]); return; }
      state.subs.delete(id);
      if (verb === 'EOSE') {
        if (id !== state.membershipSub) send(['CLOSE', id]);
        sub.resolve(sub.events);
      } else {
        if (id === state.membershipSub) state.membershipSub = null;
        sub.reject(new Error(frame[2] || 'The relay closed the subscription.'));
      }
      return;
    }
    if (verb === 'NOTICE') log('notice: ' + frame[1], 'bad');
  }
  function query(filter, monitorMembership) {
    var id = 'c' + (++state.seq);
    if (monitorMembership) state.membershipSub = id;
    return waitFor(state.subs, id, () => send(['REQ', id, filter]));
  }
  async function signed(kind, tags, content) {
    const ws = state.ws;
    var e = await state.signer.signEvent({ kind: kind, created_at: now(), tags: tags, content: content || '' });
    if (!ws || ws !== state.ws) throw new Error('The signing session ended.');
    if (state.me && e.pubkey !== state.me) throw new Error('The signer changed its public key. Sign out and sign in again.');
    return e;
  }
  async function publish(kind, tags, content) {
    var e = await signed(kind, tags, content);
    var answer = await waitFor(state.pending, e.id, () => send(['EVENT', e]));
    if (!answer.ok) throw new Error(answer.message || 'The relay refused the event.');
    return answer;
  }
  function connect() {
    const ws = new WebSocket(RELAY_URL);
    state.ws = ws;
    ws.onmessage = (m) => { if (ws === state.ws) onFrame(JSON.parse(m.data)); };
    ws.onerror = () => { if (ws === state.ws) disconnect('Cannot reach ' + RELAY_URL); };
    ws.onclose = () => { if (ws === state.ws) disconnect('The relay connection closed. Reconnect with this key.'); };
    return waitFor(state.pending, 'challenge');
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
     ['relay key', state.relayKey ? short(state.relayKey) : 'not advertised']].forEach(function (pair) {
      var d = el('div'); d.appendChild(el('dt', pair[0])); d.appendChild(el('dd', pair[1])); list.appendChild(d);
    });
    var gated = lim.auth_required === true && lim.membership_required === true;
    state.gated = gated;
    stat('gate-state', gated ? 'invite-only' : 'unconfirmed', gated ? 'good' : 'warn');
    $('rooms-status').textContent = (info.supported_nips || []).includes(29) ? 'NIP-29 rooms' : 'NIP-29 not advertised';
  }
  async function readInfo() {
    var r = await fetch('/', { headers: { Accept: 'application/nostr+json' } });
    if (!r.ok) throw new Error('NIP-11 answered HTTP ' + r.status);
    var info = await r.json();
    state.relayKey = info.self || info.pubkey || null;
    const name = info.name || 'Relay console';
    $('relay-name').textContent = name.startsWith(location.host + ' · ') ? location.host : name;
    $('relay-software').textContent = [info.software, info.version].filter(Boolean).join(' ');
    document.title = (info.name || 'Relay') + ' console';
    stat('relay-state', 'online', 'good');
    $('relay-dot').className = 'dot good';
    facts(info);
  }
  function unreachable(err) {
    stat('relay-state', 'unreachable', 'bad');
    $('relay-dot').className = 'dot bad';
    stat('gate-state', 'unverified', 'warn');
    $('rooms-status').textContent = 'NIP-29 unverified';
    log(err.message, 'bad');
  }

  // --------------------------------------------------------------- sign in, enrol
  async function signIn() {
    if (state.ws) disconnect('Reconnecting…');
    const signer = state.signer;
    const me = await signer.getPublicKey();
    if (!HEX64.test(me) || signer !== state.signer) throw new Error('The signing key is unavailable.');
    var challenge = await connect();
    var proof = await signed(22242, [['relay', RELAY_URL], ['challenge', challenge]], '');
    if (proof.pubkey !== me) throw new Error('The signer returned a different public key.');
    var answer = await waitFor(state.pending, proof.id, () => send(['AUTH', proof]));
    if (!answer.ok) throw new Error('The relay refused sign-in: ' + answer.message);
    state.me = me;
    await probeMembership();
  }
  async function probeMembership() {
    // Both relay implementations gate every REQ on NIP-43 membership. Keep this empty
    // subscription open after EOSE so a relay closing it on revocation locks the UI.
    try { await query({ ids: ['0'.repeat(64)] }, true); }
    catch (err) {
      state.member = false;
      if (!err.message.startsWith('restricted:')) {
        disconnect(err.message);
        throw err;
      }
      render();
      return;
    }
    if (!state.ws || !state.me || !state.membershipSub) throw new Error('The membership check was interrupted.');
    state.member = true;
    listRooms();
    render();
  }
  async function joinTopic() {
    const link = state.link;
    if (!state.member || !link || !link.channel || !usableHere(link)) return;
    const grant = link.bundle;
    const button = $('join-topic');
    button.disabled = true;
    try {
      // The keeper verifies this proof to bind the invite and its role to this seat.
      const msg = await sha256(concat(utf8('nostr-mailbox/topic-redeem/v1'), await sha256(utf8(grant.group_code)), unhex(state.me)));
      const proof = hexOf(await schnorrSign(msg, unhex(grant.redeem)));
      await publish(9021, [['h', grant.topic], ['code', grant.group_code], ['proof', proof]], '');
      const seats = await query({ kinds: [39002], '#d': [grant.topic], '#p': [state.me] });
      if (!byD(seats, 39002).has(grant.topic)) throw new Error('The relay has not confirmed the topic roster yet.');
      const ring = { schema: 'cf.keyring-file/1', name: grant.topic, campaign: grant.campaign,
        owner: state.me, relay: RELAY_URL, authorities: [grant.owner], epochs: grant.epochs || {}, current: grant.current || 0, seen: [] };
      $('topic-keys').textContent = JSON.stringify(ring, null, 2);
      $('topic-status').textContent = 'Joined as ' + (grant.role || 'read-write') + '.';
      $('topic-export').hidden = !grant.epochs;
      button.hidden = true;
      link.spent = true;
    } catch (err) {
      $('topic-status').textContent = err.message;
      button.disabled = false;
    }
  }
  async function enter(mode) {
    if (state.busy || state.member) return;
    state.busy = true;
    render();
    try {
      const claiming = mode === 'claim';
      if (claiming && $('open-token').value.trim()) openGiven();
      if (claiming && (!state.link || !usableHere(state.link))) {
        render();
        $('whoami').textContent = 'Use an invite issued for this relay.';
        return;
      }
      if (!state.gated) {
        await readInfo();
        if (!state.gated) throw new Error('The relay does not advertise authenticated, invite-only access.');
      }
      if (!state.signer) {
        if (mode === 'extension' || (claiming && $('use-extension').checked)) {
          if (!window.nostr) throw new Error('No NIP-07 extension found. Use a browser key or enter your nsec.');
          const ext = window.nostr;
          state.signer = { getPublicKey: () => ext.getPublicKey(), signEvent: (e) => ext.signEvent(e) };
        } else if (mode === 'import') {
          const secret = $('nsec').value;
          $('nsec').value = '';
          state.signer = browserSigner(secret);
        } else {
          state.signer = browserSigner();
        }
      }
      gateControls();
      if (!state.me || mode === 'resume') await signIn();
      if (claiming && !state.member) {
        const code = state.link.code;
        $('whoami').textContent = 'Redeeming invite…';
        await publish(28934, [['-'], ['claim', code]], '');
        state.link.spent = true;
        await probeMembership();
        if (!state.member) throw new Error('The relay accepted the claim but could not confirm membership. Reconnect to check.');
      }
      if (state.member) {
        const link = state.link;
        if (link && link.channel && usableHere(link)) {
          $('topic-grant').hidden = false;
          $('topic-title').textContent = 'Topic invite · #' + link.topic;
          if (claiming) await joinTopic();
        } else if (claiming && link.bundle && link.bundle.campaign_key) {
          // A room invite carries the existing bus key. Never replace a held room key.
          const room = roomSlug(link.campaign), name = ROOM_KEY_PREFIX + state.me + '/' + room;
          if (kept && !kept.getItem(name)) kept.setItem(name, link.bundle.campaign_key);
          $('room').value = room;
          listRooms();
        }
        const pairWith = link && link.token && !link.error && !link.spent && forThisRelay(link)
          ? link.token : kept && kept.getItem(TOKEN_KEY);
        if (HOSTED_MCP && pairWith) showConnection(pairWith);
        await loadGroups();
        await loadMail();
      }
    } catch (err) {
      if (!state.me && state.ws) disconnect(err.message);
      render();
      $('whoami').textContent = err.message;
      $('returning').open = true;
      log(err.message, 'bad');
    } finally {
      state.busy = false;
      gateControls();
    }
  }
  function signOut() {
    if (state.signer && state.signer.clear) state.signer.clear();
    state.signer = null;
    state.link = null;
    state.urls = null;
    state.pairToken = null;
    $('backup-key').textContent = '';
    $('backup').hidden = true;
    $('nsec').value = '';
    $('open-token').value = '';
    disconnect('Signed out.');
    try { if (kept) kept.removeItem(TOKEN_KEY); }
    finally {
      history.replaceState(null, '', '/');
      location.reload(); // Discard pending UI work and all member data, including on a docs tab.
    }
  }
  // A whole nm1_ token for the room: the relay's single-use code, packed with the
  // room's declaration and key, and at once the URLs that pair a client with it.
  async function mint() {
    var room = roomSlug($('room').value);
    if (!state.member) throw new Error('only a member mints an invite: redeem one first');
    var events = await query({ kinds: [28935], limit: 1 });
    var invite = events[0];
    if (!invite) throw new Error('the relay sent no invite');
    if (state.relayKey && invite.pubkey !== state.relayKey) throw new Error('the invite is not signed by the relay key NIP-11 names');
    var code = tagValue(invite, 'claim');
    if (!code) throw new Error('the invite carries no claim code');
    var key = roomKey(room);
    var token = packInvite({ relay: RELAY_URL, campaign: room, operator: state.me, campaignKey: key.hex, code: code });
    $('invite-code').textContent = code;
    $('invite-link').textContent = connectionUrls(location.origin, token).join;
    $('invite-out').hidden = false;
    $('room').value = room;
    listRooms();
    $('mint-status').textContent = 'Minted a token for #' + room + (key.fresh ? ', under a new room key this browser now keeps.' :
      ', under the room key this browser keeps.') + ' Send the join link to one person or agent seat' +
      (HOSTED_MCP ? ', or pair a client with it below.' : '.');
    $('mint-status').className = 'note good';
    if (HOSTED_MCP) showConnection(token);
    else {
      $('local-command').textContent = "crosswire join '" + connectionUrls(location.origin, token).join + "' && crosswire watch bus";
      $('local-command-box').hidden = false;
    }
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
  function gateControls() {
    const held = !!state.signer;
    $('key-form').hidden = held;
    $('signin').hidden = held;
    $('extension-choice').hidden = held || !window.nostr;
    $('reconnect').hidden = !held || state.member;
    if (!$('reconnect').hidden || $('nsec').value) $('returning').open = true;
    $('signout').hidden = !held;
    for (const button of document.querySelectorAll('#invited-card button')) button.disabled = state.busy;
  }
  function render() {
    $('whoami').textContent = state.me ? 'Signed in as ' + short(state.me) +
      (state.member ? ', enrolled.' : '. Redeem an invite to enroll this key.') :
      (state.busy ? 'Signing in…' : '');
    var npub = state.me ? npubOf(state.me) : null;
    $('persona-npub').hidden = !npub;
    $('persona-npub').textContent = npub ? npub.slice(0, 12) + '…' + npub.slice(-6) : 'not signed in';
    $('workspace').hidden = !state.member;
    $('admission').hidden = state.member;
    const loaded = !!(state.link && usableHere(state.link) && !state.link.spent);
    $('open-token').required = !loaded;
    $('open-token').placeholder = loaded ? 'Invite loaded · paste another to replace it' : 'Paste your invite link, nm1_… token, or claim code';
    $('open-invite').textContent = loaded ? 'Redeem this invite' : 'Redeem Invite & Open →';
    $('local-pair').hidden = HOSTED_MCP || !state.member;
    ['groups-card', 'mailbox-card'].forEach(function (id) { $(id).hidden = !state.member; });
    gateControls();
    if (!state.member) { $('group-card').hidden = true; state.counts = { groups: null, mail: null }; counted(); }
    renderLink();
    if (state.install) installFor(state.install);
  }

  // ---------------------------------------------------------------- 02 · waitlist
  function mayweStatus(text, cls) { var p = $('maywe-status'); p.textContent = text; p.className = 'note' + (cls ? ' ' + cls : ''); }
  // BEGIN MayWe answer
  // tests/test_hydrate.py runs this block under Node. MayWe's public subscribe answers
  // {ok, status}: ok false with status 'paused' while the list takes no requests, and
  // 'pending' also where it deliberately sends no new mail, so a success promises none.
  // An error answer carries FastAPI's detail, a string or a list of {msg}.
  function mayweAnswer(httpStatus, text) {
    var data;
    try { data = JSON.parse(text); } catch (err) { throw new Error('MayWe answered HTTP ' + httpStatus + ' with a body that is not JSON'); }
    if (httpStatus < 200 || httpStatus > 299) {
      var why = data && (Array.isArray(data.detail) ? data.detail.map(function (d) { return d.msg; }).join('; ') : data.detail);
      throw new Error('MayWe refused the request (HTTP ' + httpStatus + ')' + (why ? ': ' + why : ''));
    }
    if (data && data.status === 'paused') throw new Error('Invite requests are temporarily paused; please try again shortly.');
    if (!data || data.ok !== true) throw new Error('MayWe did not take the request (status ' + (data && data.status) + ')');
    return 'Request received. Check your inbox to confirm your place on the waitlist.';
  }
  // END MayWe answer
  async function requestMayweInvite() {
    var email = $('maywe-email').value.trim();
    if (!email) throw new Error('enter your email address first');
    var note = $('maywe-note').value.trim();
    var website = $('maywe-website').value || '';
    var key = (typeof location !== 'undefined' && location.origin === 'https://docs.awow.io')
      ? 'pk_6ZNZP0jBeKTpu22jfUQfQ6Dhcu6faq7iSzeEJsMMy78'
      : 'pk_G-LEI15eUfTnYhGyV2hMHvRsxMsJwkM4r-wgj3jS2jI';
    var params = new URLSearchParams({ key: key, email: email, source: 'crosswire:invite-request', website: website });
    if (note) params.set('details', JSON.stringify({ use_case: note }));
    mayweStatus('Sending your request to MayWe…');
    var done;
    try {
      var res = await fetch('https://newsletter.awow.io/v1/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: params.toString()
      });
      done = mayweAnswer(res.status, await res.text());
    } catch (err) {
      // Beside the email field, where the visitor looks, and in the log.
      mayweStatus(err.message, 'bad');
      throw err;
    }
    $('maywe-email').value = '';
    $('maywe-note').value = '';
    mayweStatus(done, 'good');
  }

  var kept = storage();
  applyTheme(kept && kept.getItem(THEME_KEY));
  $('relay-url').textContent = RELAY_URL;
  $('invite-relay').textContent = RELAY_URL;
  state.link = takeInviteLink();
  renderClient();
  function route() {
    const tab = location.hash.slice(1);
    const pages = ['switchboard', 'docs', 'acls', 'architecture'];
    const active = pages.includes(tab) ? tab : (/^\/docs\/?$/.test(location.pathname) ? 'docs' : 'switchboard');
    for (const id of pages) $(id).hidden = id !== active;
    for (const link of document.querySelectorAll('[data-tab]')) {
      if (link.dataset.tab === active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }
  window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
  route();
  function installFor(client) {
    const repo = 'https://github.com/awowIO/crosswire';
    const cli = client === 'cli' || client === 'chatgpt';
    const install = cli ? 'uv tool install git+' + repo :
      'git clone ' + repo + ' && python3 crosswire/scripts/sync_plugin.py --install --harness ' + client;
    const link = state.link;
    const token = link && usableHere(link) && !link.spent && link.token;
    const watch = token && link.channel ? 'crosswire --topic ' + link.topic + ' watch bus' : 'crosswire watch bus';
    $('install-command').textContent = install + "\ncrosswire join '" + (token || '<nm1_ token or join link>') + "' && " + watch;
    let note = cli ? 'Requires uv.' : 'Run from the checkout’s parent directory. Keep the checkout and put ~/.local/bin on PATH.';
    if (client === 'chatgpt') note += ' Run these on your connector host. Then run crosswire mcp --http behind public HTTPS and add its MCP URL in ChatGPT.';
    if (client === 'claude-desktop') note += ' Restart Claude Desktop to load its stdio server.';
    $('install-how').textContent = note + (token ? ' This invite is ready to use once.' : ' Replace the quoted placeholder with an unused invite.');
    for (const button of document.querySelectorAll('#install-clients button')) button.setAttribute('aria-pressed', String(button.dataset.install === client));
    state.install = client;
  }
  for (const button of document.querySelectorAll('#install-clients button')) {
    button.addEventListener('click', () => installFor(button.dataset.install));
  }
  const scenarios = document.querySelectorAll('#scenarios button');
  for (const button of scenarios) {
    button.addEventListener('click', () => {
      for (const choice of scenarios) {
        const selected = choice === button;
        choice.setAttribute('aria-pressed', String(selected));
        $(choice.getAttribute('aria-controls')).hidden = !selected;
      }
    });
  }
  installFor('cli');
  copyButton($('install-copy'), 'install-command');
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
  $('join-topic').addEventListener('click', action(async () => { await joinTopic(); await loadGroups(); }));
  copyButton($('topic-copy'), 'topic-keys');
  copyButton($('local-copy'), 'local-command');
  copyButton($('link-copy'), 'link-command');
  copyButton($('invite-copy'), 'invite-code');
  copyButton($('invite-link-copy'), 'invite-link');
  $('open-form').addEventListener('submit', action(() => enter('claim')));
  $('key-form').addEventListener('submit', action(() => enter('import')));
  $('signin').addEventListener('click', action(() => enter('extension')));
  $('reconnect').addEventListener('click', action(() => enter('resume')));
  $('signout').addEventListener('click', signOut);
  copyButton($('backup-copy'), 'backup-key');
  $('mint').addEventListener('click', action(mint));
  $('maywe-form').addEventListener('submit', action(requestMayweInvite));
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
    `<style>${CONSOLE_STYLE}</style>\n</head>\n<body>${BODY.replace("<!-- documentation -->", () => DOCUMENTATION)}<script>${CONSOLE_SCRIPT}</script>\n</body>\n</html>\n`
  );
}
