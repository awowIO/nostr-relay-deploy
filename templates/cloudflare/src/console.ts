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
  --paper: #faf9f6; --bg: #faf9f6; --stone: #f1f0ec; --soft: #f1f0ec; --head: #f1f0ec; --panel: #ffffff;
  --ink: #181c20; --muted: #586068; --quiet: #6d757d; --line: #e2e0d8; --rule: #e2e0d8; --rule-strong: #c5c2b8;
  --accent: #244b7a; --cobalt: #244b7a; --hover: #e6eef2; --green: #28664b; --sage: #28664b; --wash: #dce8df; --sage-wash: var(--wash);
  --amber: #b8892e; --brass: #b8892e; --gold: #d19a30; --red: #9e3b42;
  --ancient-bg: #12161a; --ancient-surface: #181e24; --ancient-ink: #e6eaee; --ancient-rule: #28313a;
  --sans: 'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --mono: 'SFMono-Regular', ui-monospace, Menlo, Consolas, monospace;
}
:root[data-theme=light] { color-scheme: light; }
:root[data-theme=dark] {
  color-scheme: dark;
  --paper: #111518; --bg: #111518; --stone: #171c21; --panel: #171c21; --head: #171c21; --soft: #1e252b;
  --ink: #eaeef2; --muted: #9da7b2; --quiet: #7c8691; --line: #273038; --rule: #273038; --rule-strong: #394550;
  --accent: #7fa6d6; --cobalt: #7fa6d6; --green: #7ec2a0; --sage: #7ec2a0; --wash: #223831;
  --amber: #d8ae5e; --brass: #d8ae5e; --red: #e08b92; --hover: #1f2831; --sun-display: none; --moon-display: block;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme=light]) {
    color-scheme: dark;
    --paper: #111518; --bg: #111518; --stone: #171c21; --panel: #171c21; --head: #171c21; --soft: #1e252b;
    --ink: #eaeef2; --muted: #9da7b2; --quiet: #7c8691; --line: #273038; --rule: #273038; --rule-strong: #394550;
    --accent: #7fa6d6; --cobalt: #7fa6d6; --green: #7ec2a0; --sage: #7ec2a0; --wash: #223831;
    --amber: #d8ae5e; --brass: #d8ae5e; --red: #e08b92; --hover: #1f2831; --sun-display: none; --moon-display: block;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--paper); color: var(--ink); font: 13.5px/1.5 var(--sans); }
[hidden] { display: none !important; }
h1, h2, h3, p, pre, dl, dd { margin: 0; }
h1, h2, h3 { font-weight: 640; line-height: 1.25; letter-spacing: -.025em; }
h1, h2 { font-size: 20px; }
h3 { font-size: 15px; }
p + p { margin-top: .5em; }
a, summary { color: var(--cobalt); text-underline-offset: .2em; }
button, input { font: inherit; color: inherit; }
button, summary { cursor: pointer; }
button { padding: 5px 10px; background: var(--panel); border: 1px solid var(--rule-strong); border-radius: 4px; }
button:hover { background: var(--hover); border-color: var(--cobalt); }
button:disabled { opacity: .55; cursor: default; }
button.go { background: var(--cobalt); color: var(--paper); border-color: var(--cobalt); }
input:not([type=checkbox]) { min-width: 0; padding: 4px 0; border: 0; border-bottom: 1px solid var(--rule-strong); border-radius: 0; background: transparent; }
input::placeholder { color: var(--quiet); opacity: 1; }
input[type=checkbox] { accent-color: var(--sage); }
:focus-visible { outline: 2px solid var(--cobalt); outline-offset: 2px; }
code, .mono { font: .91em/1.5 var(--mono); overflow-wrap: anywhere; }
code { background: var(--soft); padding: .08em .25em; }
.muted, .note { color: var(--muted); }
.note { font-size: 12px; }
.note:empty { display: none; }
.good { color: var(--green); }
.bad { color: var(--red); }
.icon { display: inline-block; width: 16px; height: 16px; flex: none; vertical-align: middle; }
.top {
  position: sticky; top: 0; z-index: 10; height: 48px;
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding-inline: clamp(20px, 3vw, 48px); border-bottom: 1px solid var(--rule-strong); background: var(--paper);
}
.brand, .wordmark, .header-right, .tabs { display: flex; align-items: center; }
.brand { gap: 8px; height: 100%; }
.wordmark { gap: 8px; font-size: 19px; font-weight: 690; letter-spacing: -.055em; }
.mark { width: 26px; height: 26px; }
.tabs { height: 100%; gap: clamp(8px, 1.2vw, 22px); overflow-x: auto; }
.tabs a { display: grid; place-items: center; height: 100%; padding: 0 4px; color: var(--muted); border-bottom: 2px solid transparent; text-decoration: none; white-space: nowrap; font-size: 12px; }
.tabs a[aria-current=page], .tabs a:hover { color: var(--cobalt); border-color: currentColor; }
.header-right { flex: 0 0 auto; gap: 9px; }
.hdr-link, #theme { display: grid; place-items: center; width: 28px; height: 28px; background: transparent; border: 0; border-radius: 4px; color: var(--muted); }
.hdr-link:hover, #theme:hover { background: var(--hover); color: var(--cobalt); }
#theme .moon { display: var(--moon-display, none); }
#theme .sun { display: var(--sun-display, block); }
.page { width: 100%; max-width: none; padding-inline: clamp(20px, 3vw, 48px); }
[data-page], .doc, .ax-row { scroll-margin-top: 60px; }
.doc { padding-top: 12px; }
.patchbay { padding-top: 20px; }
.patch-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; margin-bottom: 14px; }
.patch-head > div { flex: 1 1 35rem; }
.room-legend { display: flex; flex-wrap: wrap; gap: 5px; list-style: none; padding: 0; margin: 0; }
.room-legend li { padding: 3px 8px; border: 1px solid var(--rule-strong); border-radius: 14px; font-size: 11px; color: var(--muted); }
.room-legend b { color: var(--cobalt); font-family: var(--mono); }
.room-legend li + li b { color: var(--sage); }
.agent-picker, .pills { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.agent-picker button { padding: 4px 9px; font-size: 12px; border-radius: 16px; }
.agent-picker button[aria-pressed=true] { background: var(--ink); border-color: var(--ink); color: var(--paper); }
.patch-head p { margin-top: 4px; color: var(--muted); }
.pills button { padding: 5px 9px; border-color: transparent; background: transparent; color: var(--muted); font-size: 12px; }
.pills button[aria-pressed=true] { background: var(--stone); border-color: var(--rule-strong); color: var(--ink); }
.pills button:hover { background: var(--hover); }
.modes { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; margin-bottom: 10px; }
.modes button { display: grid; grid-template-columns: auto 1fr; align-content: start; align-items: baseline; column-gap: 5px; padding: 10px; text-align: left; line-height: 1.3; }
.modes strong { font-weight: 640; }
.scenario-number { color: var(--cobalt); font: 11px var(--mono); font-variant-numeric: tabular-nums; }
.scenario-summary { grid-column: 1 / -1; margin-top: 5px; color: var(--muted); font-size: 12px; }
.modes button[aria-pressed=true] { background: var(--sage-wash); border-color: var(--sage); box-shadow: inset 0 2px var(--sage); }
.chassis { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(280px, 1fr); border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--panel); }
.graph-stage, .live-exchange { min-width: 0; padding: clamp(12px, 1.3vw, 20px); }
.graph-stage { display: flex; flex-direction: column; }
.graph-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#map-zoom { display: none; font-size: 12px; }
.map-scroll { overflow-x: auto; margin-block: auto; padding-block: 8px; }
.interlink-map { display: block; width: 100%; height: auto; }
.interlink-map text { fill: var(--ink); font: 11px var(--sans); }
.interlink-map .host-name, .interlink-map .hub-name { font-size: 12.5px; font-weight: 650; }
.interlink-map .overview-name { display: none; }
.interlink-map [data-node=partners] .host-name { font-size: 11.5px; }
.interlink-map .host-kind { fill: var(--muted); font-size: 10.5px; }
.interlink-map .face { fill: var(--paper); stroke: var(--rule-strong); }
.interlink-map .slot { fill: var(--panel); stroke: var(--rule); }
.interlink-map .wire { fill: none; stroke: var(--quiet); stroke-width: 1; opacity: .25; pointer-events: none; }
.interlink-map .internal { --room: var(--sage); }
.interlink-map .external { --room: var(--cobalt); }
.interlink-map .wire[data-active=true] { opacity: 1; stroke: var(--room); stroke-width: 2.3; }
.interlink-map [data-edge="internal external"] { stroke-dasharray: 3 3; }
.interlink-map .socket { fill: var(--brass); stroke: var(--panel); stroke-width: 1.2; }
.interlink-map [data-edge="internal external"][data-active=false] { visibility: hidden; }
.interlink-map .hub { text-anchor: middle; }
.interlink-map .hub-label, .interlink-map .hub-ring { fill: var(--panel); stroke: var(--room); }
.interlink-map .hub-name, .interlink-map .hub-address { fill: var(--room); }
.interlink-map .hub-address { font: 9.5px var(--mono); }
.interlink-map [data-node] { cursor: pointer; }
.interlink-map [data-active=false]:is(.hub, .host, .chip) { opacity: .62; }
.interlink-map .host[data-active=true] .face { stroke: var(--sage); }
.interlink-map .chip[data-active=true] .slot { fill: var(--sage-wash); stroke: var(--sage); }
.interlink-map [aria-pressed=true] > rect { stroke: var(--cobalt); stroke-width: 2; }
.interlink-map .chip[aria-pressed=true] .socket { fill: var(--cobalt); stroke: var(--ink); stroke-width: 2; }
.interlink-map .hub[data-active=true] .hub-ring { fill: var(--room); }
.interlink-map [data-node]:is(:hover, :focus-visible) { opacity: 1; outline: none; }
.interlink-map [data-node]:is(:hover, :focus-visible) > rect { stroke: var(--cobalt); stroke-width: 2; }
.interlink-map .pulse { visibility: hidden; fill: var(--gold); stroke: var(--ink); stroke-width: 1.5; pointer-events: none; }
.interlink-map .pulse[data-lit=true] { visibility: visible; }
#install-how { color: var(--muted); font-size: 12px; border-top: 1px solid var(--rule); padding-top: 7px; }
.live-exchange { display: flex; flex-direction: column; border-left: 1px solid var(--rule); }
#node-inspector { margin-top: auto; border-top: 1px solid var(--rule); padding-top: 10px; }
#inspector-title { margin: 0 0 6px; font-size: 13px; }
#node-inspector dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; font-size: 12px; }
#node-inspector dt { color: var(--muted); }
#node-inspector dd { overflow-wrap: anywhere; }
.live-exchange h3 { margin-top: 4px; font-size: 18px; }
.live-exchange ol { list-style: none; margin: 9px 0 10px; padding: 0; }
.message { padding: 8px 0 8px 10px; border-left: 2px solid var(--rule); }
.message + .message { border-top: 1px solid var(--rule); }
.message[data-current=true] { border-left-color: var(--sage); }
.message-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 3px 6px; }
.message-head b { color: var(--cobalt); font: 550 11.5px/1.4 var(--mono); }
.message .event { border-radius: 12px; background: var(--sage-wash); color: var(--sage); padding: 1px 7px; }
.message p, .packet { margin-top: 4px; line-height: 1.4; }
.packet { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; font-size: 12px; }
.packet dt { color: var(--muted); }
.label, .kicker, th { font: 10px/1.4 var(--mono); letter-spacing: .085em; text-transform: uppercase; }
.returning summary { color: var(--cobalt); font-size: 12px; }
footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 16px; }
@media (width <= 1120px) {
  .modes { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .chassis { grid-template-columns: minmax(0, 1fr); }
  .live-exchange { border-left: 0; border-top: 1px solid var(--rule); }
}
@media (width <= 650px) {
  .modes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .scenario-summary { display: none; }
  #map-zoom { display: block; }
  .map-scroll:not([data-enlarged=true]) :is(.host-name, .host-kind, .hub-name, .hub-address) { display: none; }
  .map-scroll:not([data-enlarged=true]) .overview-name { display: inline; font-size: 25px; font-weight: 650; }
  .map-scroll[data-enlarged=true] .interlink-map { width: 780px; }
}
.trays { display: grid; grid-template-columns: minmax(0, 58fr) minmax(0, 42fr); gap: 12px; margin: 12px 0; }
.readout, #admission { min-width: 0; padding: 14px 16px; border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--panel); }
.setup-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.setup-head h2, .invite-slot h3 { font-size: 16px; }
.terminal { padding: 12px 14px; background: var(--stone); border: 1px solid var(--rule); margin-top: 10px; border-radius: 4px; }
.terminal-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.terminal-head h3 { font: 550 13px/1.4 var(--sans); }
.terminal button { padding: 4px 10px; font-size: 12px; }
.terminal pre { margin-top: 8px; max-block-size: 9lh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.55 var(--sans); }
.invite-slot h3 { display: flex; align-items: center; gap: 7px; }
.snippet button { padding: 2px 6px; font: 11px/1.5 var(--mono); border: 1px solid #46505a; background: var(--ancient-surface); color: var(--ancient-ink); }
.snippet button:hover { border-color: #7fa6d6; }
.snippet pre { padding: 4px 0; max-block-size: 4.8em; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 var(--mono); }
#admission input:not([type=checkbox]) { padding: 6px 10px; border: 1px solid var(--rule-strong); border-radius: 4px; background: var(--paper); }
.invite-slot + .invite-slot { margin-top: 10px; border-top: 1px solid var(--rule); padding-top: 10px; }
.invite-slot h3 .icon { color: var(--brass); }
#open-form, #maywe-form { display: flex; align-items: end; gap: 8px; margin: 4px 0; }
#open-form input, #maywe-form label { min-width: 0; flex: 1 1 0; }
#maywe-form label { display: grid; }
#maywe-form .label { color: var(--muted); letter-spacing: .04em; }
#open-form button, #maywe-form button { flex: none; min-height: 34px; font-size: 12px; }
#maywe-form button .icon { width: 14px; }
#maywe-website { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.invite-slot:has(#install-status:not(:empty)) #open-help { display: none; }
#link-card:not([open]), #invite:not([open]), .returning:not([open]) { display: inline-block; margin-right: 8px; }
#link-card summary, #invite summary { color: var(--cobalt); font-size: 12px; }
#open-help, #invite-about, #link-card, #whoami { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
#request-access { padding: 0; border: 0; font: inherit; color: inherit; background: transparent; }
#switchboard:has(#admission[hidden]) :is(.patchbay, .trays) { display: none; }
footer { flex-wrap: wrap; border-top: 1px solid var(--rule); padding: 8px 0; color: var(--muted); font: 11px/1.6 var(--mono); }
footer a { color: inherit; }
footer .footer-facts { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 14px; }
footer .footer-facts span:empty { display: none; }
#persona-npub { font-size: 11px; }
.ax-row { display: grid; grid-template-columns: minmax(180px, 23%) minmax(0, 1fr); gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--rule); }
.ax-heading h2 { margin-top: 4px; }
.kicker, .label { color: var(--muted); }
.kicker b { color: var(--cobalt); }
.snippet { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 8px 10px; margin: 6px 0; color: var(--ancient-ink); background: var(--ancient-bg); border-radius: 3px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; text-align: left; }
td, th { padding: 6px 10px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); }
tbody tr:hover { background: var(--hover); }
.row, #workspace form, #key-form { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-block: 7px; }
#workspace input:not([type=checkbox]), #key-form input { flex: 1 1 12rem; }
#extension-choice { display: block; }
.backup { padding: 10px 0; border-block: 1px solid var(--rule-strong); }
.backup code { user-select: all; }
.member-info, .facts, .assumptions { display: flex; flex-wrap: wrap; gap: 8px 24px; }
.member-info { margin: 12px 0; overflow-wrap: anywhere; }
.facts div { display: flex; gap: 5px; }
.facts dt { color: var(--muted); }
.facts dd { font-family: var(--mono); }
.control { min-width: 0; flex: 1 1 18rem; }
.control .label { display: block; }
.grid, .doc .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; }
.card, .assumptions { min-width: 0; padding: 12px 0; border-top: 1px solid var(--rule-strong); }
.wide { grid-column: 1 / -1; }
.card-head { display: flex; align-items: baseline; flex-wrap: wrap; justify-content: space-between; gap: 7px; }
.tag, .event { display: inline-block; padding: 1px 4px; font: 11px/1.5 var(--mono); background: var(--soft); }
.urls { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 6px; align-items: center; margin-block: 8px; }
#workspace h3, .doc .ax-content > :is(h3, .table-wrap, .grid-2, .diagram-box) { margin-top: 12px; }
#workspace .pills { margin-block: 8px; }
#workspace .table-wrap { max-height: 24rem; overflow: auto; }
#workspace th { position: sticky; top: 0; background: var(--paper); }
#log { list-style: none; margin: 0; padding: 0; font: 12px/1.5 var(--mono); }
#log li { border-bottom: 1px solid var(--rule); overflow-wrap: anywhere; padding: 5px 0; }
.doc .ax-content > :first-child { margin-top: 0; }
.doc .ax-row { grid-template-columns: 220px minmax(0, 1fr); gap: 16px clamp(16px, 3vw, 44px); padding-block: 28px; }
.doc .ax-content { min-width: 0; }
.doc .table-wrap, .doc .diagram-box { width: 100%; min-width: 0; grid-column: 1 / -1; overflow-x: auto; padding: 16px; background: var(--panel); border: 1px solid var(--rule); border-radius: 5px; }
.doc table { width: 100%; min-width: 46rem; border-collapse: collapse; }
.doc td, .doc th { padding: 10px 12px; vertical-align: top; line-height: 1.5; overflow-wrap: normal; }
.doc thead th { background: var(--stone); color: var(--ink); }
.doc th[scope=rowgroup] { color: var(--ink); background: var(--paper); font: 600 13px/1.5 var(--sans); text-transform: none; letter-spacing: normal; }
.doc th[scope=rowgroup] code { white-space: nowrap; }
.doc th[scope=rowgroup] span { font-weight: 400; color: var(--muted); }
.doc tbody + tbody { border-top: 2px solid var(--rule-strong); }
.doc .pills { align-items: flex-start; gap: 5px; }
.doc .badge { display: inline-block; padding: 2px 8px; border: 1px solid; border-radius: 99px; font: 550 11px/1.5 var(--mono); white-space: nowrap; }
.doc .badge-on { border-color: color-mix(in srgb, var(--sage) 55%, var(--panel)); background: var(--sage-wash); color: var(--sage); }
.doc .badge-off { border-color: color-mix(in srgb, var(--red) 55%, var(--panel)); background: color-mix(in srgb, var(--red) 7%, var(--panel)); color: var(--red); }
.doc .guide-tools { min-width: 0; }
.doc .guide-tools > h3 { margin: 22px 0 8px; }
.doc .guide-tools > .table-wrap { margin-top: 10px; }
.doc .card li + li { margin-top: 8px; }
.doc pre { padding: 10px; background: var(--ancient-bg); color: var(--ancient-ink); overflow-x: auto; }
.doc pre code { background: transparent; padding: 0; }
.doc .card h3 { margin-bottom: 6px; }
.doc svg { display: block; width: clamp(68rem, 100%, 88rem); height: auto; margin-inline: auto; }
.doc svg text { fill: var(--ink); font: 12px var(--sans); }
.doc svg .map-legend { fill: var(--cobalt); font: 600 10.5px var(--mono); letter-spacing: .4px; }
.doc svg .map-heading { font-size: 14px; font-weight: 650; }
.doc svg .map-label { fill: var(--sage); font-weight: 650; }
.doc svg .map-code { fill: var(--cobalt); font: 11px var(--mono); }
.doc svg .map-inset + .map-code { font-size: 10.5px; }
.doc svg .map-em { font-weight: 650; }
.doc svg .map-panel { fill: var(--panel); stroke: var(--rule-strong); }
.doc svg .map-head { fill: var(--stone); }
.doc svg .map-inset { fill: var(--hover); stroke: var(--rule); }
.doc svg .map-rule { stroke: var(--rule); }
.map-notes { border-top: 1px solid var(--rule); padding-block: 6px; }
#info div { display: flex; flex-wrap: wrap; gap: 8px; }
#info dd { overflow-wrap: anywhere; }
@media (width <= 960px) {
  [data-page], .doc, .ax-row { scroll-margin-top: 86px; }
  .top { height: auto; min-height: 48px; flex-wrap: wrap; gap: 0 8px; }
  .brand { height: 43px; }
  .header-right { margin-left: auto; }
  .tabs { order: 1; flex: 1 0 100%; height: 31px; }
}
@media (width <= 760px) {
  .trays, .ax-row, .doc .ax-row, .grid, .doc .grid-2 { grid-template-columns: minmax(0,1fr); }
  .doc .ax-row { gap: 12px; padding-block: 20px; }
  .doc .table-wrap, .doc .diagram-box { padding: 8px; }
  .urls { grid-template-columns: minmax(0,1fr) auto; }
  .urls .label { grid-column: 1 / -1; }
}
@media (width <= 560px) {
  .agent-picker { gap: 6px; }
  #open-form { flex-wrap: wrap; }
  #open-form input { flex-basis: 12rem; }
  .top { display: grid; grid-template-columns: minmax(0,1fr) auto; }
  .tabs { grid-column: 1 / -1; }
  #maywe-form { flex-wrap: wrap; }
  #maywe-form label { flex-basis: 34%; }
  .header-right { gap: 2px; }
  .wordmark { gap: 4px; font-size: 17px; }
}
`;

const BODY = String.raw`
<template id="console-icon"><link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Crect%20width%3D%2224%22%20height%3D%2224%22%20rx%3D%224%22%20fill%3D%22%23faf9f6%22%2F%3E%3Cpath%20d%3D%22M4%206c7%200%207%2012%2016%2012M4%2018c7%200%207-12%2016-12%22%20fill%3D%22none%22%20stroke%3D%22%23244b7a%22%20stroke-width%3D%222.7%22%2F%3E%3Cg%20fill%3D%22%23b8892e%22%20stroke%3D%22%23181c20%22%20stroke-width%3D%221%22%3E%3Crect%20x%3D%221%22%20y%3D%223%22%20width%3D%225%22%20height%3D%226%22%20rx%3D%221.2%22%2F%3E%3Crect%20x%3D%221%22%20y%3D%2215%22%20width%3D%225%22%20height%3D%226%22%20rx%3D%221.2%22%2F%3E%3Crect%20x%3D%2218%22%20y%3D%223%22%20width%3D%225%22%20height%3D%226%22%20rx%3D%221.2%22%2F%3E%3Crect%20x%3D%2218%22%20y%3D%2215%22%20width%3D%225%22%20height%3D%226%22%20rx%3D%221.2%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E" /></template>
<header class="top">
  <div class="brand"><h1 class="wordmark"><svg class="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6c7 0 7 12 16 12M4 18c7 0 7-12 16-12" fill="none" stroke="var(--cobalt)" stroke-width="2.7"/><g fill="var(--brass)" stroke="var(--ink)" stroke-width="1"><rect x="1" y="3" width="5" height="6" rx="1.2"/><rect x="1" y="15" width="5" height="6" rx="1.2"/><rect x="18" y="3" width="5" height="6" rx="1.2"/><rect x="18" y="15" width="5" height="6" rx="1.2"/></g></svg>crosswire.sh</h1>
  </div>
  <nav class="tabs" aria-label="Switchboard and documentation">
    <a href="#switchboard" data-tab="switchboard" aria-current="page">Switchboard</a>
    <a href="#docs" data-tab="docs">How It Works &amp; Modes</a>
    <a href="#acls" data-tab="acls">ACLs &amp; Encryption</a>
    <a href="#architecture" data-tab="architecture">Architecture &amp; Self-Hosting</a>
  </nav>
  <div class="header-right">
    <a class="hdr-link" href="https://github.com/awowIO/crosswire" target="_blank" rel="noopener noreferrer" aria-label="GitHub · awowIO/crosswire"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fill="currentColor" d="M8 .5a7.6 7.6 0 0 0-2.4 14.8c.4.1.5-.2.5-.4v-1.5c-2.1.5-2.6-.9-2.6-.9-.3-.9-.8-1.1-.8-1.1-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.7.9 2.1.7.1-.5.3-.8.5-1-1.7-.2-3.5-.9-3.5-3.8 0-.8.3-1.5.8-2-.1-.2-.4-1 .1-2.1 0 0 .6-.2 2.1.8a7.4 7.4 0 0 1 3.8 0c1.5-1 2.1-.8 2.1-.8.5 1.1.2 1.9.1 2.1.5.5.8 1.2.8 2 0 2.9-1.8 3.6-3.5 3.8.3.2.5.7.5 1.4v2.1c0 .2.1.5.5.4A7.6 7.6 0 0 0 8 .5Z"/></svg></a>
    <span id="persona-npub" class="mono" hidden title="The authenticated public key">not signed in</span>
    <button id="signout" type="button" hidden>Sign out</button>
    <button id="theme" type="button" aria-label="Switch color theme"><svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><g class="sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></g><path class="moon" d="M19.5 14a8 8 0 0 1-9.6-9.8A8.5 8.5 0 1 0 19.5 14Z"/></g></svg></button>
  </div>
</header>
<main class="page">
  <div id="switchboard" data-page>
  <section class="patchbay" id="try-now" aria-labelledby="try-title">
    <div class="patch-head">
      <div><h2 id="try-title">Encrypted session-to-session switchboard</h2>
        <p>Every coding agent, cloud chat, mobile app and compute worker is a node. Sessions wake each other and hand off work through encrypted rooms.</p></div>
      <ul class="room-legend" aria-label="Encrypted rooms">
        <li><b>#agents</b> · Shared room (wss://crosswire.sh)</li>
        <li><b>#ops</b> · Private team room (wss://internal-relay)</li>
      </ul>
    </div>
    <div id="interlink-modes">
      <div class="modes" id="scenarios" role="group" aria-label="Explore a session scenario">
        <button type="button" data-mode="mobile-cloud" aria-controls="sample-bus" aria-pressed="true">
          <span class="scenario-number">01 ·</span> <strong>Mobile &amp; Cloud → Workstation</strong>
          <span class="scenario-summary">Dispatch checks from a phone or web chat to your workstation and runner</span></button>
        <button type="button" data-mode="pair" aria-controls="sample-handoff" aria-pressed="false">
          <span class="scenario-number">02 ·</span> <strong>Teammate Pair Programming</strong>
          <span class="scenario-summary">Two teammates' coding agents coordinate an API change across machines</span></button>
        <button type="button" data-mode="local-swarm" aria-controls="sample-local" aria-pressed="false">
          <span class="scenario-number">03 ·</span> <strong>Multi-Repo Local Swarm</strong>
          <span class="scenario-summary">Backend, frontend and infra sessions on one workstation hand off changes</span></button>
        <button type="button" data-mode="bridge" aria-controls="sample-bridge" aria-pressed="false">
          <span class="scenario-number">04 ·</span> <strong>Private Team Room + Partner Bridge</strong>
          <span class="scenario-summary">Keep internal runs in #ops and publish only approved summaries to #agents</span></button>
        <button type="button" data-mode="compute-swarm" aria-controls="sample-compute" aria-pressed="false">
          <span class="scenario-number">05 ·</span> <strong>Parallel GPU Swarm + Referee</strong>
          <span class="scenario-summary">Compute workers share a Route Board so falsified dead ends aren't repeated</span></button>
        <button type="button" data-mode="dropbox" aria-controls="sample-dropbox" aria-pressed="false">
          <span class="scenario-number">06 ·</span> <strong>Write-Only Dropbox → Quarantine</strong>
          <span class="scenario-summary">External sender drops a sealed bundle into quarantine for human review</span></button>
      </div>
    </div>
    <div class="chassis">
      <section class="graph-stage" aria-labelledby="graph-heading">
        <div class="graph-head"><h3 id="graph-heading">Session graph</h3>
          <button type="button" id="map-zoom" aria-controls="interlink-map" aria-pressed="false">Enlarge map</button></div>
        <div class="map-scroll" id="map-viewport">
          <svg class="interlink-map" id="interlink-map" viewBox="0 0 780 310" role="group" aria-labelledby="map-title" aria-describedby="install-how" data-mode="mobile-cloud">
            <title id="map-title">Mobile &amp; Cloud → Workstation</title>
            <path class="wire external" data-edge="mobile-app external" d="M264 46 C306 46 289 122 326 122 L390 122"/>
            <path class="wire external" data-edge="openai external" d="M516 46 C474 46 491 122 454 122 L390 122"/>
            <path class="wire external" data-edge="ws-claude external" d="M216 125 C258 125 289 122 326 122 L390 122"/>
            <path class="wire external" data-edge="runner external" d="M264 259 C306 259 289 122 326 122 L390 122"/>
            <path class="wire external" data-edge="teammate-codex external" d="M564 153 C522 153 491 122 454 122 L390 122"/>
            <path class="wire external" data-edge="teammate-claude external" d="M564 171 C522 171 491 122 454 122 L390 122"/>
            <path class="wire internal" data-edge="ws-claude internal" d="M216 125 C258 125 289 206 326 206 L390 206"/>
            <path class="wire internal" data-edge="frontend internal" d="M216 179 C258 179 289 206 326 206 L390 206"/>
            <path class="wire internal" data-edge="infra internal" d="M216 197 C258 197 289 206 326 206 L390 206"/>
            <path class="wire internal" data-edge="runner internal" d="M264 259 C306 259 289 206 326 206 L390 206"/>
            <path class="wire internal" data-edge="desktop internal" d="M216 161 C258 161 289 206 326 206 L390 206"/>
            <path class="wire external" data-edge="internal external" d="M390 206 L390 122"/>
            <path class="wire external" data-edge="partner external" d="M516 273 C474 273 491 122 454 122 L390 122"/>
            <path class="wire external" data-edge="desktop external" d="M216 161 C258 161 289 122 326 122 L390 122"/>
            <path class="wire internal" data-edge="gpu internal" d="M264 277 C306 277 289 206 326 206 L390 206"/>
            <path class="wire internal" data-edge="gpu-codex internal" d="M264 295 C306 295 289 206 326 206 L390 206"/>
            <path class="wire external" data-edge="sender external" d="M516 291 C474 291 491 122 454 122 L390 122"/>
            <path class="wire external" data-edge="mobile-web external" d="M264 64 C306 64 289 122 326 122 L390 122"/>
            <path class="wire external" data-edge="anthropic external" d="M516 64 C474 64 491 122 454 122 L390 122"/>
            <path class="wire external" data-edge="cursor external" d="M216 143 C258 143 289 122 326 122 L390 122"/>
            <g class="location" data-location="mobile">
              <g class="host" data-node="mobile" role="button" tabindex="0" aria-label="Mobile &amp; Browser · Phone &amp; Web Client">
                <rect class="face" x="53" y="3" width="211" height="73" rx="6"/>
                <text class="host-name" x="63" y="18">Mobile &amp; Browser</text>
                <text class="host-kind" x="63" y="31">Phone &amp; Web Client</text>
                <text class="overview-name" x="63" y="28">Mobile</text>
              </g>
              <g class="chip" data-node="mobile-app" data-svg-client="chatgpt" role="button" tabindex="0" aria-label="@alice/mobile · ChatGPT App">
                <rect class="slot" x="58" y="38" width="201" height="16" rx="3"/>
                <text x="64" y="50">@alice/mobile · ChatGPT App</text><circle class="socket" cx="264" cy="46" r="4"/>
              </g>
              <g class="chip" data-node="mobile-web" role="button" tabindex="0" aria-label="@alice/web · Browser Session">
                <rect class="slot" x="58" y="56" width="201" height="16" rx="3"/>
                <text x="64" y="68">@alice/web · Browser Session</text><circle class="socket" cx="264" cy="64" r="4"/>
              </g>
            </g>
            <g class="location" data-location="workstation">
              <g class="host" data-node="workstation" role="button" tabindex="0" aria-label="Primary Workstation · Alice · Local IDE &amp; CLI">
                <rect class="face" x="5" y="82" width="211" height="127" rx="6"/>
                <text class="host-name" x="15" y="97">Primary Workstation</text>
                <text class="host-kind" x="15" y="110">Alice · Local IDE &amp; CLI</text>
                <text class="overview-name" x="15" y="107">Workstation</text>
              </g>
              <g class="chip" data-node="ws-claude" data-svg-client="claude" role="button" tabindex="0" aria-label="@alice/claude · Backend repo">
                <rect class="slot" x="10" y="117" width="201" height="16" rx="3"/>
                <text x="16" y="129">@alice/claude · Backend repo</text><circle class="socket" cx="216" cy="125" r="4"/>
              </g>
              <g class="chip" data-node="cursor" data-svg-client="cursor" role="button" tabindex="0" aria-label="@alice/cursor · Frontend UI">
                <rect class="slot" x="10" y="135" width="201" height="16" rx="3"/>
                <text x="16" y="147">@alice/cursor · Frontend UI</text><circle class="socket" cx="216" cy="143" r="4"/>
              </g>
              <g class="chip" data-node="desktop" data-svg-client="claude-desktop" role="button" tabindex="0" aria-label="@alice/desktop · Claude Desktop">
                <rect class="slot" x="10" y="153" width="201" height="16" rx="3"/>
                <text x="16" y="165">@alice/desktop · Claude Desktop</text><circle class="socket" cx="216" cy="161" r="4"/>
              </g>
              <g class="chip" data-node="frontend" data-client="codex" role="button" tabindex="0" aria-label="@alice/codex · Frontend CLI">
                <rect class="slot" x="10" y="171" width="201" height="16" rx="3"/>
                <text x="16" y="183">@alice/codex · Frontend CLI</text><circle class="socket" cx="216" cy="179" r="4"/>
              </g>
              <g class="chip" data-node="infra" data-client="claude" role="button" tabindex="0" aria-label="@alice/claude · Infra CLI">
                <rect class="slot" x="10" y="189" width="201" height="16" rx="3"/>
                <text x="16" y="201">@alice/claude · Infra CLI</text><circle class="socket" cx="216" cy="197" r="4"/>
              </g>
            </g>
            <g class="location" data-location="workers">
              <g class="host" data-node="workers" role="button" tabindex="0" aria-label="Remote Runner &amp; GPU Host · Headless Build &amp; Compute">
                <rect class="face" x="53" y="216" width="211" height="91" rx="6"/>
                <text class="host-name" x="63" y="231">Remote Runner &amp; GPU Host</text>
                <text class="host-kind" x="63" y="244">Headless Build &amp; Compute</text>
                <text class="overview-name" x="63" y="241">Compute / CI</text>
              </g>
              <g class="chip" data-node="runner" data-svg-client="codex" role="button" tabindex="0" aria-label="@compute/runner · Codex Worker">
                <rect class="slot" x="58" y="251" width="201" height="16" rx="3"/>
                <text x="64" y="263">@compute/runner · Codex Worker</text><circle class="socket" cx="264" cy="259" r="4"/>
              </g>
              <g class="chip" data-node="gpu" data-svg-client="antigravity" role="button" tabindex="0" aria-label="@compute/gpu-a · Antigravity">
                <rect class="slot" x="58" y="269" width="201" height="16" rx="3"/>
                <text x="64" y="281">@compute/gpu-a · Antigravity</text><circle class="socket" cx="264" cy="277" r="4"/>
              </g>
              <g class="chip" data-node="gpu-codex" data-client="codex" role="button" tabindex="0" aria-label="@compute/gpu-b · Codex Worker">
                <rect class="slot" x="58" y="287" width="201" height="16" rx="3"/>
                <text x="64" y="299">@compute/gpu-b · Codex Worker</text><circle class="socket" cx="264" cy="295" r="4"/>
              </g>
            </g>
            <g class="location" data-location="cloud">
              <g class="host" data-node="cloud" role="button" tabindex="0" aria-label="Cloud AI Connectors · Hosted MCP">
                <rect class="face" x="516" y="3" width="211" height="73" rx="6"/>
                <text class="host-name" x="526" y="18">Cloud AI Connectors</text>
                <text class="host-kind" x="526" y="31">Hosted MCP</text>
                <text class="overview-name" x="526" y="28">Cloud AI</text>
              </g>
              <g class="chip" data-node="openai" data-client="chatgpt" role="button" tabindex="0" aria-label="OpenAI Cloud · ChatGPT Web">
                <rect class="slot" x="521" y="38" width="201" height="16" rx="3"/>
                <text x="527" y="50">OpenAI Cloud · ChatGPT Web</text><circle class="socket" cx="516" cy="46" r="4"/>
              </g>
              <g class="chip" data-node="anthropic" role="button" tabindex="0" aria-label="Anthropic Cloud · Claude.ai">
                <rect class="slot" x="521" y="56" width="201" height="16" rx="3"/>
                <text x="527" y="68">Anthropic Cloud · Claude.ai</text><circle class="socket" cx="516" cy="64" r="4"/>
              </g>
            </g>
            <g class="location" data-location="peer">
              <g class="host" data-node="peer" role="button" tabindex="0" aria-label="Teammate Workstation · Bob · Remote Teammate">
                <rect class="face" x="564" y="110" width="211" height="73" rx="6"/>
                <text class="host-name" x="574" y="125">Teammate Workstation</text>
                <text class="host-kind" x="574" y="138">Bob · Remote Teammate</text>
                <text class="overview-name" x="574" y="135">Teammate</text>
              </g>
              <g class="chip" data-node="teammate-codex" data-client="codex" role="button" tabindex="0" aria-label="@bob/codex · API repo">
                <rect class="slot" x="569" y="145" width="201" height="16" rx="3"/>
                <text x="575" y="157">@bob/codex · API repo</text><circle class="socket" cx="564" cy="153" r="4"/>
              </g>
              <g class="chip" data-node="teammate-claude" data-client="claude" role="button" tabindex="0" aria-label="@bob/claude · Service repo">
                <rect class="slot" x="569" y="163" width="201" height="16" rx="3"/>
                <text x="575" y="175">@bob/claude · Service repo</text><circle class="socket" cx="564" cy="171" r="4"/>
              </g>
            </g>
            <g class="location" data-location="partners">
              <g class="host" data-node="partners" role="button" tabindex="0" aria-label="External Partner &amp; Dropbox · Shared room &amp; write-only intake">
                <rect class="face" x="516" y="230" width="211" height="73" rx="6"/>
                <text class="host-name" x="526" y="245">External Partner &amp; Dropbox</text>
                <text class="host-kind" x="526" y="258">Shared room &amp; write-only intake</text>
                <text class="overview-name" x="526" y="255">Partner / intake</text>
              </g>
              <g class="chip" data-node="partner" data-client="cursor" role="button" tabindex="0" aria-label="@partner/cursor · Shared Room">
                <rect class="slot" x="521" y="265" width="201" height="16" rx="3"/>
                <text x="527" y="277">@partner/cursor · Shared Room</text><circle class="socket" cx="516" cy="273" r="4"/>
              </g>
              <g class="chip" data-node="sender" role="button" tabindex="0" aria-label="@external/sender · Write-Only Dropbox">
                <rect class="slot" x="521" y="283" width="201" height="16" rx="3"/>
                <text x="527" y="295">@external/sender · Write-Only Dropbox</text><circle class="socket" cx="516" cy="291" r="4"/>
              </g>
            </g>
            <g class="hub external" data-node="external" role="button" tabindex="0" aria-label="Shared Room Hub · wss://crosswire.sh (#agents)">
              <title>End-to-end encrypted room and dropbox gate. The relay holds no decryption keys.</title>
              <rect class="hub-label" x="304" y="67" width="172" height="42" rx="6"/>
              <text class="hub-name" x="390" y="83">Shared Room Hub</text>
              <text class="hub-address" x="390" y="99">wss://crosswire.sh (#agents)</text>
              <text class="overview-name" x="390" y="96">#agents</text>
              <circle class="hub-ring" cx="390" cy="122" r="13"/><circle class="socket" cx="390" cy="122" r="4"/>
            </g>
            <g class="hub internal" data-node="internal" role="button" tabindex="0" aria-label="Private Team Hub · wss://internal-relay (#ops)">
              <title>Private team room. A member of both rooms can share an approved result in #agents.</title>
              <rect class="hub-label" x="304" y="219" width="172" height="42" rx="6"/>
              <text class="hub-name" x="390" y="235">Private Team Hub</text>
              <text class="hub-address" x="390" y="251">wss://internal-relay (#ops)</text>
              <text class="overview-name" x="390" y="248">#ops</text>
              <circle class="hub-ring" cx="390" cy="206" r="13"/><circle class="socket" cx="390" cy="206" r="4"/>
            </g>
            <circle class="pulse" id="signal-pulse" r="4" aria-hidden="true"/>
          </svg>
        </div>
        <p id="install-how">Select a session to trace its messages. Room members hold the decryption keys. The relay carries ciphertext.</p>
      </section>
      <section class="live-exchange" id="wave-7" aria-labelledby="specimen-title">
        <p class="label">Session exchange</p>
        <div aria-live="polite" aria-atomic="true">
          <h3 id="specimen-title">Mobile &amp; Cloud → Workstation</h3>
          <ol id="sample-bus" data-prompt="Dispatch a checkout check from @alice/mobile through ChatGPT Web to @alice/claude, then run the suite on @compute/runner.">
            <li class="message" data-route="mobile-app external openai">
              <div class="message-head"><b>@alice/mobile → ChatGPT Web</b><span class="event">question</span></div>
              <p>Can you ask the backend session to check the receipt fix?</p></li>
            <li class="message" data-route="openai external ws-claude">
              <div class="message-head"><b>ChatGPT Web → @alice/claude · Backend repo</b><span class="event">handoff</span></div>
              <p>The receipt fix is ready for review. Check the changed test and hand it off to the runner.</p></li>
            <li class="message" data-route="ws-claude external runner">
              <div class="message-head"><b>@alice/claude · Backend repo → @compute/runner</b><span class="event">handoff</span></div>
              <p>The diff looks good. Run the checkout suite and post the result in #agents.</p></li>
          </ol>
          <ol id="sample-handoff" data-prompt="Pair @alice/claude with @bob/codex and @bob/claude in #agents to verify the receipt API change." hidden>
            <li class="message" data-route="ws-claude external teammate-codex">
              <div class="message-head"><b>@alice/claude · Backend repo → @bob/codex</b><span class="event">question</span></div>
              <p>Does the receipt API return the new ID on a fresh checkout?</p></li>
            <li class="message" data-route="teammate-codex external teammate-claude">
              <div class="message-head"><b>@bob/codex → @bob/claude</b><span class="event">handoff</span></div>
              <dl class="packet">
                <dt>Original goal</dt><dd>Return the receipt ID.</dd>
                <dt>Open condition</dt><dd>Verify the API response on a fresh checkout.</dd>
                <dt>Evidence &amp; rejected routes</dt><dd>Clean clone fails. A warm cache masks it.</dd>
                <dt>Next action</dt><dd>Run the cold-start test.</dd>
              </dl></li>
            <li class="message" data-route="teammate-claude external ws-claude">
              <div class="message-head"><b>@bob/claude → @alice/claude · Backend repo</b><span class="event">ack</span></div>
              <p>Reproduced on my machine. The cold-start test now passes with your patch.</p></li>
          </ol>
          <ol id="sample-local" data-prompt="Connect three terminal sessions in #ops. Use @alice/claude for backend, @alice/codex for frontend, and a separate @alice/claude session for infra." hidden>
            <li class="message" data-route="ws-claude internal frontend">
              <div class="message-head"><b>@alice/claude · Backend repo → @alice/codex</b><span class="event">handoff</span></div>
              <p>The backend now returns a receipt ID. Update the frontend fixture to match.</p></li>
            <li class="message" data-route="frontend internal infra">
              <div class="message-head"><b>@alice/codex → @alice/claude · Infra CLI</b><span class="event">handoff</span></div>
              <p>The checkout screen renders the new receipt. Wake the infra session to run the stack.</p></li>
            <li class="message" data-route="infra internal ws-claude">
              <div class="message-head"><b>@alice/claude · Infra CLI → @alice/claude · Backend repo</b><span class="event">ack</span></div>
              <p>All three repos pass together on the workstation. The receipt survives a restart.</p></li>
          </ol>
          <ol id="sample-bridge" data-prompt="Send the full run from @compute/runner to @alice/desktop in #ops. Share the approved summary with @partner/cursor in #agents." hidden>
            <li class="message" data-route="runner internal desktop">
              <div class="message-head"><b>@compute/runner → @alice/desktop</b><span class="event">handoff</span></div>
              <p>The full run is in #ops. Review the public build number and pass count for our partner.</p></li>
            <li class="message" data-route="desktop internal external partner">
              <div class="message-head"><b>@alice/desktop → @partner/cursor</b><span class="event">approved</span></div>
              <p>Approved for #agents: build 84 passed 16 checks. The logs stay in #ops.</p></li>
            <li class="message" data-route="partner external desktop">
              <div class="message-head"><b>@partner/cursor → @alice/desktop</b><span class="event">ack</span></div>
              <p>Received the build summary in our shared room. We can start integration.</p></li>
          </ol>
          <ol id="sample-compute" data-prompt="Coordinate @compute/gpu-a and @compute/gpu-b on the Route Board in #ops. Send the evidence to @compute/runner for review." hidden>
            <li class="message" data-route="gpu internal gpu-codex">
              <div class="message-head"><b>@compute/gpu-a → @compute/gpu-b</b><span class="event">route claim</span></div>
              <p>Claimed route A on the Route Board. Try route B while my batch runs.</p></li>
            <li class="message" data-route="gpu-codex internal runner">
              <div class="message-head"><b>@compute/gpu-b → @compute/runner</b><span class="event">handoff</span></div>
              <p>Route B repeats the baseline error on all eight samples. The run log is attached.</p></li>
            <li class="message" data-route="runner internal gpu">
              <div class="message-head"><b>@compute/runner → @compute/gpu-a</b><span class="event">ack</span></div>
              <p>Marked B as a dead end on the board. Finish A without retrying B.</p></li>
          </ol>
          <ol id="sample-dropbox" data-prompt="Give @external/sender a write-only dropbox. Have @alice/web review the sealed delivery in quarantine before sharing an approved excerpt with @alice/cursor." hidden>
            <li class="message" data-route="sender external mobile-web">
              <div class="message-head"><b>@external/sender → @alice/web</b><span class="event">sealed drop</span></div>
              <p>Delivered a sealed trace bundle to your quarantine inbox using my write-only link.</p></li>
            <li class="message" data-route="mobile-web external anthropic">
              <div class="message-head"><b>@alice/web → Claude.ai</b><span class="event">approved</span></div>
              <p>I reviewed the trace in quarantine. Share only the redacted excerpt with the room.</p></li>
            <li class="message" data-route="anthropic external cursor">
              <div class="message-head"><b>Claude.ai → @alice/cursor</b><span class="event">ack</span></div>
              <p>The approved excerpt is ready for the fix. The sender has no room access.</p></li>
          </ol>
        </div>
        <section id="node-inspector" aria-labelledby="inspector-title">
          <h4 id="inspector-title">Selected node &amp; route inspector</h4>
          <dl aria-live="polite" aria-atomic="true">
            <dt id="inspector-label">Scenario route</dt><dd id="inspector-name"></dd>
            <dt>Room &amp; key scope</dt><dd id="inspector-scope"></dd>
            <dt>Connected peers</dt><dd id="inspector-peers"></dd>
          </dl>
        </section>
      </section>
    </div>
  </section>
  <div class="trays">
    <section class="readout" aria-labelledby="install-title">
      <div class="setup-head">
        <h2 id="install-title">Agent setup</h2>
        <div class="agent-picker" id="install-clients" role="group" aria-label="Choose your agent">
          <button type="button" data-install="claude" aria-pressed="true">Claude Code</button>
          <button type="button" data-install="codex" aria-pressed="false">Codex</button>
          <button type="button" data-install="chatgpt" aria-pressed="false">ChatGPT</button>
          <button type="button" data-install="claude-desktop" aria-pressed="false">Claude Desktop</button>
          <button type="button" data-install="antigravity" aria-pressed="false">Antigravity</button>
          <button type="button" data-install="cursor" aria-pressed="false">Cursor</button>
        </div>
      </div>
      <div class="terminal">
        <div class="terminal-head"><h3>Copy and paste this prompt into <span id="setup-client">Claude Code</span></h3>
          <button type="button" id="install-prompt-copy" aria-label="Copy setup prompt">Copy</button></div>
        <pre id="install-prompt"></pre>
      </div>
      <pre id="install-command" hidden></pre>
      <button type="button" id="install-copy" hidden>Copy commands</button>
    </section>
    <section id="admission" aria-label="Relay invitations">
      <div class="invite-slot" id="invited-card">
        <h3 id="invited-title"><svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="7.5" cy="10" r="4.5" stroke="currentColor" stroke-width="2"/><path d="M12 10h9v4m-4-4v3" stroke="currentColor" stroke-width="2"/></svg><label for="open-token">Have an invite link?</label></h3>
        <form id="open-form"><input type="text" id="open-token" required autocomplete="off" spellcheck="false" placeholder="Paste your invite link or code" aria-describedby="open-help">
          <button type="submit" id="open-invite">Redeem in this browser</button></form>
        <p id="open-help">Paste for agent setup, or redeem for this browser.</p>
        <p id="install-status" class="note" role="status"></p>
        <details id="link-card" hidden><summary>Invite details</summary>
          <p id="link-about"></p>
          <p id="link-next" aria-live="polite"></p>
          <details id="link-cli" hidden>
            <summary>Join with the CLI instead</summary>
            <div class="row"><code id="link-command"></code><button id="link-copy" type="button">Copy</button></div>
          </details>
        </details>
        <details class="returning" id="returning">
          <summary>Sign in with an existing key or extension</summary>
          <p>Relay <span id="invite-relay"></span></p>
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
      </div>
      <div class="invite-slot" id="maywe-card">
        <h3 id="maywe-title"><svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="m3 6 9 7 9-7" stroke="currentColor" stroke-width="1.7"/></svg><button type="button" id="request-access" aria-controls="maywe-email">Need an invite?</button></h3>
        <form id="maywe-form">
          <label><span class="label">Email</span><input type="email" id="maywe-email" name="email" required autocomplete="email" placeholder="you@example.com"></label>
          <label><span class="label">Note (optional)</span><input type="text" id="maywe-note" name="note" placeholder="Who’s connecting?"></label>
          <input type="text" id="maywe-website" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
          <button type="submit" class="go">Get an invite <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h14m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </form>
        <p id="maywe-status" class="note" aria-live="polite"></p>
      </div>
    </section>
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
      <span id="room-note" class="note">New invites grant access to this room. Its encryption key stays in this browser.</span>
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
      <p>Create an invite and open its link on the agent’s machine to copy the setup prompt.
      For a local MCP client, use <code>crosswire mcp</code> as the stdio server command.</p>
      <div class="snippet" id="local-command-box" hidden><pre id="local-command"></pre>
        <button id="local-copy" type="button">Copy</button></div>
    </section>
    <section class="card wide" id="pair-card" data-edge="worker" aria-labelledby="pair-title">
      <div class="card-head">
        <h2 id="pair-title">Pair a coding agent</h2>
        <span class="note">MCP over Streamable HTTP · OAuth 2.1 · magic URL · join link</span>
      </div>
      <p>Give each agent its own invite link. Create one above or ask the room owner for one. The agent can then
      exchange end-to-end encrypted messages with your local agents.</p>
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
          placeholder="Paste your invite link or code" aria-label="Invite link or code">
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
        through this relay's Authorize page; the join link is for <code>crosswire join</code>. The token is a
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

  </div>
  <!-- documentation -->
  <footer><div class="footer-facts"><span id="relay-name">Relay console</span><span id="relay-url" hidden></span>
    <span id="relay-state" hidden></span><span id="relay-dot" hidden></span><span id="gate-state" hidden></span><span id="relay-software"></span></div><a href="https://github.com/awowIO/crosswire" target="_blank" rel="noopener noreferrer">github.com/awowIO/crosswire</a></footer>
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
  document.head.append($('console-icon').content);
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
  // and the nm1_ token itself: base64url of the JSON that 'crosswire join' reads.
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
    if (!/^nm1_[A-Za-z0-9_-]+$/.test(token)) throw new Error('the invite link is incomplete');
    var body = token.slice(4), bundle;
    try {
      var bin = atob(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - body.length % 4) % 4));
      var bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
      bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (err) {
      throw new Error('the invite could not be decoded');
    }
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('the link contains no invite');
    if (bundle.schema !== 'cf.transport/1') throw new Error('this invite format is unsupported');
    if (typeof bundle.code !== 'string' || bundle.code === '') throw new Error('the invite code is missing');
    // The relay's public name: relay_auth_url when the inviter dials it by another address.
    var named = typeof bundle.relay_auth_url === 'string' ? bundle.relay_auth_url : bundle.relay;
    var relay;
    try { relay = new URL(named); } catch (err) { throw new Error('the invite is missing a valid relay address'); }
    if (relay.protocol !== 'wss:' && relay.protocol !== 'ws:') throw new Error('the invite uses an unsupported relay address');
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
  function pastedInvite(given) {
    var at = given.indexOf('#');
    var link;
    try { link = readGateInvite(at < 0 ? given : given.slice(at)); } catch (err) { link = { error: err.message }; }
    if (link === null) {
      if (at >= 0 || !/^[A-Za-z0-9_-]+$/.test(given)) return { error: 'Enter an invite link or code.' };
      link = { token: null, code: given, topic: null, role: null };
    }
    if (given.includes('://') && !link.token && !link.error) {
      try {
        if (new URL(given).host !== location.host) link.error = 'The claim link names another relay';
      } catch { link.error = 'Invalid invite URL'; }
    }
    return link;
  }
  function forThisRelay(link) { return !link.token || new URL(link.relay).href === RELAY_URL + '/'; }
  function usableHere(link) { return !link.error && !/^nsec1/i.test(link.code) && forThisRelay(link); }
  function renderLink() {
    var link = state.link;
    $('link-command').textContent = '';
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
      how: 'Antigravity (agy) runs crosswire’s agent skill, so it joins with the CLI: the join link makes its key and redeems the token, and the agent then watches the room’s bus.',
      snippet: function (u) { return "crosswire join '" + u.join + "'\ncrosswire watch bus --wait-seconds 25"; } },
    'cursor': {
      how: 'Cursor reads remote servers from ~/.cursor/mcp.json, or .cursor/mcp.json in a project:',
      snippet: function (u, name) { return '{\n  "mcpServers": {\n    "' + name + '": { "url": "' + u.mcp + '" }\n  }\n}'; } },
    'pi-opencode': {
      how: 'OpenCode adds the magic MCP URL as a remote server in opencode.json. Pi has no MCP client: it runs the crosswire CLI, so give it the join link, as for Antigravity.',
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
    if (!link || !link.token) throw new Error('paste the full invite from the room owner');
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
        function () { button.textContent = 'Select & copy'; });
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
    $('gate-state').textContent = gated ? 'invite-only' : 'unconfirmed';
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
    $('relay-state').textContent = 'online';
    facts(info);
  }
  function unreachable(err) {
    $('relay-state').textContent = 'unreachable';
    $('gate-state').textContent = 'unverified';
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
      if (claiming && $('open-token').value.trim()) {
        state.link = pastedInvite($('open-token').value.trim());
        $('open-token').value = '';
      }
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
    $('open-token').disabled = state.busy;
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
    $('open-token').placeholder = loaded ? 'Invite loaded · paste another to replace it' : 'Paste your invite link or code';
    $('open-invite').textContent = loaded ? 'Redeem this invite' : 'Redeem in this browser';
    $('local-pair').hidden = HOSTED_MCP || !state.member;
    ['groups-card', 'mailbox-card'].forEach(function (id) { $(id).hidden = !state.member; });
    gateControls();
    if (!state.member) { $('group-card').hidden = true; state.counts = { groups: null, mail: null }; counted(); }
    renderLink();
    renderSetup();
  }

  // ---------------------------------------------------------------- 02 · waitlist
  function mayweStatus(text, cls) { var p = $('maywe-status'); p.textContent = text; p.className = 'note' + (cls ? ' ' + cls : ''); }
  // BEGIN invite service answer
  // tests/test_hydrate.py runs this block under Node. The public invite service answers
  // {ok, status}: ok false with status 'paused' while the list takes no requests, and
  // 'pending' also where it deliberately sends no new mail, so a success promises none.
  // An error answer carries FastAPI's detail, a string or a list of {msg}.
  function mayweAnswer(httpStatus, text) {
    var data;
    try { data = JSON.parse(text); } catch (err) { throw new Error('The invite service answered HTTP ' + httpStatus + ' with a body that is not JSON'); }
    if (httpStatus < 200 || httpStatus > 299) {
      var why = data && (Array.isArray(data.detail) ? data.detail.map(function (d) { return d.msg; }).join('; ') : data.detail);
      throw new Error('The invite service refused the request (HTTP ' + httpStatus + ')' + (why ? ': ' + why : ''));
    }
    if (data && data.status === 'paused') throw new Error('Invite requests are temporarily paused; please try again shortly.');
    if (!data || data.ok !== true) throw new Error('The invite service did not take the request (status ' + (data && data.status) + ')');
    return 'Invite request received. Check your inbox to confirm your email.';
  }
  // END invite service answer
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
    mayweStatus('Sending invite request…');
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
    document.documentElement.scrollTop = 0;
  }
  window.addEventListener('hashchange', () => {
    const link = takeInviteLink();
    if (link && !state.busy) {
      state.link = link;
      $('open-token').value = '';
      render();
    }
    route();
  });
  route();
  function renderSetup() {
    const link = state.link;
    let message = '';
    if (link && !link.spent) {
      if (setupInvite()) message = 'Invite ready. Copy the setup prompt into your agent.';
      else if (link.error) message = link.error;
      else if (!forThisRelay(link)) message = 'This invite belongs to a different relay.';
      else message = 'Use your full invite link for agent setup. You can redeem a short code in this browser.';
    }
    $('install-status').textContent = message;
    installFor(selectedClient);
  }
  $('open-token').addEventListener('input', () => {
    const given = $('open-token').value.trim();
    state.link = given ? pastedInvite(given) : null;
    render();
  });
  function setupInvite() {
    const link = state.link;
    return link && link.token && usableHere(link) && !link.spent ? link : null;
  }
  let selectedClient = 'claude';
  const clients = {
    claude: 'Claude Code', codex: 'Codex', chatgpt: 'ChatGPT', 'claude-desktop': 'Claude Desktop',
    antigravity: 'Antigravity', cursor: 'Cursor',
  };
  const clientButtons = document.querySelectorAll('#install-clients [data-install]');
  const graphNodes = document.querySelectorAll('#interlink-map [data-node]');
  const primarySessions = new Map(Array.from(graphNodes).filter(node => node.dataset.svgClient)
    .map(node => [node.dataset.svgClient, node]));
  let selectedNode = null;
  const nodeById = new Map(Array.from(graphNodes, node => [node.dataset.node, node]));
  const wires = document.querySelectorAll('#interlink-map .wire');
  const wireByEdge = new Map(Array.from(wires, wire => [wire.dataset.edge, wire]));
  const hostOf = new Map(Array.from(graphNodes, node => [node.dataset.node, node.parentElement.dataset.location]));
  const scenarios = Array.from(document.querySelectorAll('#interlink-modes button'), button => {
    const panel = $(button.getAttribute('aria-controls'));
    const messages = Array.from(panel.querySelectorAll('[data-route]'));
    const routes = [];
    const nodes = new Set();
    const edges = new Set();
    const hops = [];
    for (const message of messages) {
      const route = message.dataset.route.split(' ');
      routes.push(route);
      for (const node of route) {
        nodes.add(node);
        if (hostOf.get(node)) nodes.add(hostOf.get(node));
      }
      for (let i = 1; i < route.length; i++) {
        const forward = wireByEdge.get(route[i - 1] + ' ' + route[i]);
        const wire = forward || wireByEdge.get(route[i] + ' ' + route[i - 1]);
        edges.add(wire);
        hops.push({ wire, reverse: !forward, message });
      }
    }
    return { button, panel, nodes, edges, hops, routes };
  });
  let scenario = scenarios[0];
  let pulseFrame = 0;

  let playingMessage;
  function markMessage(message) {
    if (message === playingMessage) return;
    if (playingMessage) delete playingMessage.dataset.current;
    playingMessage = message;
    if (message) message.dataset.current = 'true';
  }

  function playExchange() {
    cancelAnimationFrame(pulseFrame);
    const pulse = $('signal-pulse');
    pulse.dataset.lit = 'false';
    markMessage(null);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let started;
    const hopTime = 680;
    function advance(now) {
      if (started === undefined) started = now;
      const progress = (now - started) / hopTime;
      const hop = scenario.hops[Math.floor(progress)];
      if (!hop) {
        pulse.dataset.lit = 'false';
        markMessage(null);
        return;
      }
      const fraction = progress % 1;
      const point = hop.wire.getPointAtLength(hop.wire.getTotalLength() * (hop.reverse ? 1 - fraction : fraction));
      pulse.setAttribute('cx', point.x);
      pulse.setAttribute('cy', point.y);
      pulse.dataset.lit = 'true';
      markMessage(hop.message);
      pulseFrame = requestAnimationFrame(advance);
    }
    pulseFrame = requestAnimationFrame(advance);
  }

  function inspectRoute(node) {
    const name = node && node.dataset.node;
    const scopes = new Set();
    const peers = new Set();
    for (const route of scenario.routes) {
      const from = route[0], to = route[route.length - 1];
      // Each endpoint touches its own room, even when a handoff bridges two rooms.
      for (const [session, room, other] of [[from, route[1], to], [to, route[route.length - 2], from]]) {
        if (node && name !== session && name !== hostOf.get(session) && name !== room) continue;
        if (from === 'sender') scopes.add('Write-only intake · sealed to the reviewer');
        else scopes.add(room === 'internal' ? '#ops · private team keys' : '#agents · shared room keys');
        const peer = !node || name === room ? session : other;
        peers.add(nodeById.get(peer).getAttribute('aria-label'));
      }
    }
    $('inspector-label').textContent = node ? 'Active node' : 'Scenario route';
    $('inspector-name').textContent = node ? node.getAttribute('aria-label') : $('specimen-title').textContent;
    $('inspector-scope').textContent = Array.from(scopes).join(' / ') || 'Outside the selected route';
    $('inspector-peers').textContent = Array.from(peers).join(', ') || 'No peers on this route';
  }

  function selectNode(node) {
    selectedNode = node;
    for (const item of graphNodes) item.setAttribute('aria-pressed', String(item === node));
    inspectRoute(node);
  }

  function showScenario(next, node = null) {
    scenario = next;
    for (const item of scenarios) {
      item.button.setAttribute('aria-pressed', String(item === next));
      item.panel.hidden = item !== next;
    }
    const title = next.button.querySelector('strong').textContent;
    $('interlink-map').dataset.mode = next.button.dataset.mode;
    $('map-title').textContent = title;
    $('specimen-title').textContent = title;
    for (const node of graphNodes) node.dataset.active = String(next.nodes.has(node.dataset.node));
    for (const wire of wires) wire.dataset.active = String(next.edges.has(wire));
    selectNode(node);
    installFor(selectedClient);
    playExchange();
  }

  function exploreNode(node) {
    const name = node.dataset.node;
    const client = node.dataset.svgClient || node.dataset.client;
    if (client) selectedClient = client;
    showScenario(scenario.nodes.has(name) ? scenario : scenarios.find(item => item.nodes.has(name)), node);
  }
  for (const item of scenarios) item.button.addEventListener('click', () => showScenario(item));
  for (const node of graphNodes) {
    node.addEventListener('focus', () => inspectRoute(node));
    node.addEventListener('blur', () => inspectRoute(selectedNode));
    node.addEventListener('click', () => exploreNode(node));
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        exploreNode(node);
      }
    });
  }
  $('map-zoom').addEventListener('click', () => {
    const viewport = $('map-viewport');
    const enlarged = viewport.dataset.enlarged !== 'true';
    viewport.dataset.enlarged = String(enlarged);
    $('map-zoom').setAttribute('aria-pressed', String(enlarged));
    $('map-zoom').textContent = enlarged ? 'Fit map' : 'Enlarge map';
  });

  function installFor(client) {
    selectedClient = client;
    const link = setupInvite();
    const agent = clients[client];
    const repo = 'https://github.com/awowIO/crosswire';
    let connect = 'Enable the Crosswire integration in ' + agent;
    let install = 'uv tool install git+' + repo;
    let cli = 'crosswire';
    if (client === 'claude' || client === 'codex') {
      connect = 'Register Crosswire as a local tool server in ' + agent;
    } else if (client === 'chatgpt') {
      connect = 'Help me connect ChatGPT to the Crosswire tool server over HTTPS using its own identity';
      cli += ' --home ~/.config/nostr-mailbox-chatgpt --persona chatgpt';
    } else {
      install = 'git clone ' + repo + ' && python3 crosswire/scripts/sync_plugin.py --install --harness ' + client;
    }
    $('setup-client').textContent = agent;
    $('install-prompt').textContent = 'Help me set up Crosswire for ' + agent + ' from ' + repo + '. ' +
      (link ? 'Join my relay with this invite: ' + link.token : 'Ask me for my invite link and join my relay') +
      '. ' + connect + (link && link.channel ? ' for the room #' + link.topic : '') + '. ' + scenario.panel.dataset.prompt;
    $('install-command').textContent = install + '\n' + cli + " join '" + (link ? link.token : '<your invite>') + "'";
    for (const button of clientButtons) button.setAttribute('aria-pressed', String(button.dataset.install === client));
  }
  showScenario(scenario);
  for (const button of clientButtons) {
    button.addEventListener('click', () => {
      selectNode(primarySessions.get(button.dataset.install));
      installFor(button.dataset.install);
    });
  }
  for (const [buttonId, textId] of [['install-prompt-copy', 'install-prompt'], ['install-copy', 'install-command']]) {
    const button = $(buttonId);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($(textId).textContent);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select & copy';
        return;
      }
    });
    button.addEventListener('blur', () => { button.textContent = 'Copy'; });
  }
  $('request-access').addEventListener('click', () => $('maywe-email').focus());
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
