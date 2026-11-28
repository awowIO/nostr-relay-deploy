// A private, invite-gated Nostr + Blossom relay for nostr-mailbox on Cloudflare Workers.
//
//   Worker          the edge filter: the same public routes as the Caddyfile and the
//                   Traefik IngressRoute, 404 for everything else. It answers NIP-11 and
//                   the Visual Web Console page (src/console.ts) itself.
//   Durable Object  one instance holds every socket, the event store, the member list
//                   and the NIP-29 groups in its SQLite storage (ctx.storage.sql)
//   R2              Blossom blobs, addressed by SHA-256 (binding BLOSSOM_BUCKET)
//
// The three gates of the ncli deployments hold here too:
//   1. auth_required        nothing is read or written before the NIP-42 AUTH answer
//   2. membership_required  an authenticated key that is not enrolled gets nothing
//   3. single-use invites   NIP-43 kind 28934 redeems an invite. The admin API mints
//                           them, and so may any member, with REQ {"kinds": [28935]}
//                           (memberClaims): one use, seven days, as relay.yaml says
//
// And so does the rest of templates/shared/relay.yaml, with the ncli relay's answers:
//   recipientOnlyKinds  kinds 1059, 4410 and 4411 reach only a reader named in their `p`
//                       tags, over REQ and live subscriptions alike
//   groups              NIP-29: members create groups (9007), which start private,
//                       restricted and closed with the creator as admin. Admins add
//                       (9000), remove (9001) and edit (9002), and mint single-use group
//                       invite codes (9009); a join (9021) carrying one is admitted at once,
//                       any other waits for them (pendingJoins); accepted moderation is
//                       kept (moderationLog). What carries a private group's `h` tag, and
//                       its state (39000-39003), reaches its members only; a 9009, which
//                       carries a code, reaches the group's admins only.
//
// And the remote MCP server (src/mcp.ts, src/mailbox.ts) at /mcp, /openapi.json and
// /tools/<name>, and under a magic URL /mcp/s/<token>: a ChatGPT or Claude.ai session that
// holds a nostr-mailbox nm1_ token acts as a persona derived from it. Its events go
// through publish() and its reads through read(), the very gates an authenticated socket
// meets. A client that has no token signs in with OAuth 2.1 (src/oauth.ts: /.well-known/*
// and /oauth/*), and its user hands the token over once, on this relay's consent page.
//
// The relay signs its invites and group state with RELAY_SIGNING_KEY (a 64-hex secret:
// `wrangler secret put RELAY_SIGNING_KEY`), the key NIP-11 names as `self`, as the ncli
// targets sign with theirs. Without it the relay does not start.
//
// Membership is managed over /_admin/ with ADMIN_TOKEN (`wrangler secret put ADMIN_TOKEN`)
// by scripts/cf_ncli_shim.py, which speaks the `ncli relay ...` argv nostr-mailbox's
// `--exec` sends. Without ADMIN_TOKEN, /_admin/ answers 404 like any other path.

import { CONSOLE_SCRIPT, CONSOLE_STYLE, consoleHtml } from "./console.ts";
import { RelayRefusal } from "./mailbox.ts";
import { serveMcp } from "./mcp.ts";
import { serveOauth } from "./oauth.ts";
import type { OauthPort } from "./oauth.ts";
import {
  AUTH_KIND,
  BLOB_PATH,
  BLOSSOM_AUTH_KIND,
  GROUP_ID,
  GROUP_KINDS,
  INVITE_CLAIM_KIND,
  INVITE_KIND,
  RECIPIENT_ONLY_KINDS,
  VERSION,
  dTag,
  edgeRoute,
  eventError,
  expirationOf,
  isGroupRequestKind,
  isGroupStateKind,
  isHex64,
  isProtected,
  kindClass,
  matchesFilter,
  parseFilter,
  randomHex,
  sameRelayUrl,
  secretKey,
  sha256,
  signEvent,
  tagValue,
  tagValues,
  utf8,
  wireEvent,
} from "./nostr.ts";
import type { Filter, KindClass, NostrEvent, SecretKey } from "./nostr.ts";

// ----------------------------------------------------------- runtime types (minimal)
// Structural types for the parts of the Workers runtime this file uses, so it needs no
// dependency to build.
interface SqlCursor<T> extends Iterable<T> {
  toArray(): T[];
}
interface SqlStorage {
  exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}
type SqlValue = string | number | null;
interface DurableObjectState {
  storage: { sql: SqlStorage; transactionSync<T>(fn: () => T): T };
  acceptWebSocket(ws: RelaySocket): void;
  getWebSockets(): RelaySocket[];
}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
interface R2Object {
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
}
interface R2ObjectBody extends R2Object {
  body: ReadableStream;
}
interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | null,
    options: { sha256: string; httpMetadata: { contentType: string } },
  ): Promise<R2Object>;
}
interface RelaySocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
declare const WebSocketPair: { new (): { 0: RelaySocket; 1: RelaySocket } };

interface Env {
  RELAY: DurableObjectNamespace;
  BLOSSOM_BUCKET: R2Bucket;
  RELAY_HOST: string;
  RELAY_NAME: string;
  EVENTS_PER_MINUTE: string;
  MAX_BLOB_BYTES: string;
  MAX_UPLOADS_PER_SIGNER: string;
  ADMIN_TOKEN?: string;
  RELAY_SIGNING_KEY?: string;
}

// ------------------------------------------------------------------------ constants
const ADMIN_PREFIX = "/_admin/";
// NIP-42: a relay should accept an AUTH event whose created_at is within about ten
// minutes of its own clock. The same window bounds a Blossom authorization's created_at.
const CLOCK_WINDOW_S = 600;
// The ceiling the pinned ncli release advertises in its NIP-11 document, so a client sees
// one contract on every target (nostr-mailbox pages with 1,024).
const MAX_LIMIT = 555_555;
// Cloudflare's own limit on one received WebSocket message: 1 MiB.
const MAX_MESSAGE_LENGTH = 1_048_576;
// NIP-01: a subscription id is at most 64 characters.
const MAX_SUBID_LENGTH = 64;
// What R2's checksum refusal says when the bytes do not hash to the `sha256` put option.
const CHECKSUM_REFUSAL = /sha-?256|checksum|digest/i;
const MS_PER_MINUTE = 60_000;
// The longest delay setTimeout honours (2^31 - 1 ms, about 24.8 days); a longer one fires
// at once, which would turn a long MCP watch into a busy loop.
const MAX_TIMER_MS = 2 ** 31 - 1;
// membership.inviteTTL and inviteMaxUses in templates/shared/relay.yaml: what an invite a
// member mints over REQ kind 28935 gets. tests/test_hydrate.py reads them from there.
const MEMBER_INVITE_TTL_S = 168 * 3600;
const MEMBER_INVITE_MAX_USES = 1;

interface Config {
  relayHost: string;
  relayName: string;
  eventsPerMinute: number;
  maxBlobBytes: number;
  maxUploadsPerSigner: number;
  relayKey: SecretKey;
}

function positiveInt(env: Env, name: keyof Env): number {
  const raw = env[name];
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer in wrangler.toml [vars], got ${JSON.stringify(raw)}`);
  }
  return n;
}

// Deriving the public key is a scalar multiplication: once per key and isolate.
let derivedKey: { raw: string; key: SecretKey } | null = null;

function relayKey(env: Env): SecretKey {
  const raw = env.RELAY_SIGNING_KEY;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("RELAY_SIGNING_KEY is not set: openssl rand -hex 32 | npx wrangler secret put RELAY_SIGNING_KEY");
  }
  if (derivedKey === null || derivedKey.raw !== raw) {
    try {
      derivedKey = { raw, key: secretKey(raw.trim()) };
    } catch (err) {
      if (err instanceof RangeError) throw new Error(`RELAY_SIGNING_KEY is not a secp256k1 secret key: ${err.message}`);
      throw err;
    }
  }
  return derivedKey.key;
}

function readConfig(env: Env): Config {
  if (typeof env.RELAY_HOST !== "string" || env.RELAY_HOST === "") {
    throw new Error("RELAY_HOST is not set in wrangler.toml [vars]");
  }
  return {
    relayHost: env.RELAY_HOST,
    relayName: env.RELAY_NAME,
    eventsPerMinute: positiveInt(env, "EVENTS_PER_MINUTE"),
    maxBlobBytes: positiveInt(env, "MAX_BLOB_BYTES"),
    maxUploadsPerSigner: positiveInt(env, "MAX_UPLOADS_PER_SIGNER"),
    relayKey: relayKey(env),
  };
}

const nowS = (): number => Math.floor(Date.now() / 1000);

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A Blossom refusal: the reason goes in X-Reason (BUD-01) and in the body. */
function refuse(status: number, reason: string): Response {
  return new Response(reason, {
    status,
    headers: { "X-Reason": reason, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function nip11(cfg: Config, method: string): Response {
  const document = {
    name: cfg.relayName,
    description: "Private, invite-gated Nostr + Blossom relay for nostr-mailbox.",
    // The relay's own key, which signs its invites (28935) and group state (39000-39003).
    // As on ncli, `pubkey` is that key too.
    pubkey: cfg.relayKey.pubkey,
    self: cfg.relayKey.pubkey,
    supported_nips: [1, 11, 29, 40, 42, 43, 70],
    software: "nostr-relay-deploy/cloudflare-worker",
    version: VERSION,
    limitation: {
      auth_required: true,
      membership_required: true,
      restricted_writes: true,
      max_message_length: MAX_MESSAGE_LENGTH,
      max_limit: MAX_LIMIT,
      max_subid_length: MAX_SUBID_LENGTH,
    },
  };
  return new Response(method === "HEAD" ? null : JSON.stringify(document), {
    headers: {
      "Content-Type": "application/nostr+json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET",
    },
  });
}

async function base64Sha256(text: string): Promise<string> {
  return btoa(String.fromCharCode(...(await sha256(utf8(text)))));
}

// The page runs only its own inline script and style, by hash, and talks only to this
// origin (the relay's WebSocket and its NIP-11 document) and, when a visitor requests an
// invite, to MayWe's subscribe endpoint.
let consoleHashes: Promise<[string, string]> | null = null;

async function consolePage(cfg: Config, method: string): Promise<Response> {
  consoleHashes ??= Promise.all([base64Sha256(CONSOLE_SCRIPT), base64Sha256(CONSOLE_STYLE)]);
  const [script, style] = await consoleHashes;
  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${script}'`,
    `style-src 'sha256-${style}'`,
    `connect-src 'self' wss://${cfg.relayHost} https://newsletter.awow.io`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return new Response(method === "HEAD" ? null : consoleHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": policy,
      "Cache-Control": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

/** Constant-time comparison of the bearer token with ADMIN_TOKEN, via their digests. */
async function adminAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected === "") return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const [given, wanted] = await Promise.all([sha256(utf8(header.slice(7))), sha256(utf8(expected))]);
  let diff = 0;
  for (let i = 0; i < wanted.length; i++) diff |= given[i] ^ wanted[i];
  return diff === 0;
}

function relayStub(env: Env): DurableObjectStub {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== env.RELAY_HOST) return notFound();
    if (url.pathname.startsWith(ADMIN_PREFIX)) {
      return (await adminAuthorized(request, env)) ? relayStub(env).fetch(request) : notFound();
    }
    switch (edgeRoute(request.method, url.pathname, request.headers)) {
      case null:
        return notFound();
      case "info":
        return nip11(readConfig(env), request.method);
      case "page":
        return consolePage(readConfig(env), request.method);
      case "unacceptable":
        return new Response("ask for exactly Accept: application/nostr+json (NIP-11), or for the page\n", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      default:
        return relayStub(env).fetch(request);
    }
  },
};

// --------------------------------------------------------------------- the relay DO
interface Attachment {
  conn: string;
  challenge: string;
  pubkey: string | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
     kind INTEGER NOT NULL, tags TEXT NOT NULL, content TEXT NOT NULL, sig TEXT NOT NULL,
     d_tag TEXT, expires_at INTEGER)`,
  "CREATE INDEX IF NOT EXISTS events_by_time ON events (created_at DESC, id)",
  "CREATE INDEX IF NOT EXISTS events_by_address ON events (pubkey, kind, d_tag)",
  "CREATE INDEX IF NOT EXISTS events_by_kind ON events (kind, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS event_tags (
     event_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS event_tags_lookup ON event_tags (name, value, event_id)",
  "CREATE INDEX IF NOT EXISTS event_tags_by_event ON event_tags (event_id)",
  `CREATE TABLE IF NOT EXISTS members (
     pubkey TEXT PRIMARY KEY, added_at INTEGER NOT NULL, via TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invites (
     code TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
     max_uses INTEGER NOT NULL, uses INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
     conn TEXT NOT NULL, sub_id TEXT NOT NULL, filters TEXT NOT NULL,
     PRIMARY KEY (conn, sub_id))`,
  `CREATE TABLE IF NOT EXISTS rate (
     pubkey TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_ms INTEGER NOT NULL)`,
  // NIP-29. `metadata` holds the tags of the group's kind 39000 after its `d` tag, as the
  // group's 9007 or its latest 9002 left them; its flags (private, restricted, hidden,
  // closed) are what the relay enforces. `roles` is a JSON array of role names.
  `CREATE TABLE IF NOT EXISTS groups (
     id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, metadata TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS group_members (
     group_id TEXT NOT NULL, pubkey TEXT NOT NULL, roles TEXT NOT NULL, added_at INTEGER NOT NULL,
     PRIMARY KEY (group_id, pubkey))`,
  // NIP-29 group invite codes (9009). One use each, as on the ncli relay: `used_by` is the
  // key whose join request (9021) spent it.
  `CREATE TABLE IF NOT EXISTS group_invites (
     code TEXT PRIMARY KEY, group_id TEXT NOT NULL, created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER)`,
  // MCP Streamable HTTP sessions (mcp.ts): an Mcp-Session-Id, bound to the token that
  // opened it by digest. DELETE /mcp ends one.
  `CREATE TABLE IF NOT EXISTS mcp_sessions (
     id TEXT PRIMARY KEY, token_digest TEXT NOT NULL, protocol TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  // OAuth authorization codes already traded for an access token (oauth.ts), so none is
  // traded twice. A code carries everything else itself; its row goes once it expires.
  `CREATE TABLE IF NOT EXISTS oauth_spent_codes (
     id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
];

// ------------------------------------------------------------------------- NIP-29
const GROUP_FLAGS: readonly string[] = ["private", "restricted", "hidden", "closed"];
const GROUP_VALUE_TAGS: readonly string[] = ["name", "about", "picture"];
// A new group: members alone read it (private) and post to it (restricted), and a join
// waits for an admin (closed). The ncli relay starts a group private and closed, and takes
// posts from members only in either case.
const NEW_GROUP_METADATA: string[][] = [["private"], ["restricted"], ["closed"]];
const ADMIN_ROLE = "admin";
// groups.roles.admin in relay.yaml also lists 9005, 9008 and 9010 for the ncli targets.
// This relay implements the four below and refuses the others by name.
const ADMIN_ROLE_DESCRIPTION = "may put-user, remove-user, edit-metadata, create-invite";
const IMPLEMENTED_GROUP_REQUESTS = "9000, 9001, 9002, 9007, 9009, 9021, 9022";

interface Group {
  id: string;
  metadata: string[][];
  flags: Set<string>;
}

function loadGroup(sql: SqlStorage, id: string): Group | null {
  const [row] = sql.exec<{ metadata: string }>("SELECT metadata FROM groups WHERE id = ?", id).toArray();
  if (row === undefined) return null;
  const metadata = JSON.parse(row.metadata) as string[][];
  return { id, metadata, flags: new Set(metadata.filter((t) => GROUP_FLAGS.includes(t[0])).map((t) => t[0])) };
}

/** The 39000 tags a kind 9002 asks for. It replaces the metadata whole, as on the ncli
 * relay: a flag it leaves out is off. */
function requestedMetadata(e: NostrEvent): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const t of e.tags) {
    if (seen.has(t[0])) continue;
    if (GROUP_FLAGS.includes(t[0])) out.push([t[0]]);
    else if (GROUP_VALUE_TAGS.includes(t[0]) && t.length > 1) out.push([t[0], t[1]]);
    else continue;
    seen.add(t[0]);
  }
  return out;
}

/** What one authenticated member may see, with the groups looked up once per message.
 * The single rule both stored reads (REQ) and live delivery apply. */
class Access {
  sql: SqlStorage;
  reader: string;
  relayPubkey: string;
  groups = new Map<string, Group | null>();
  roles = new Map<string, string[] | null>();

  constructor(sql: SqlStorage, reader: string, relayPubkey: string) {
    this.sql = sql;
    this.reader = reader;
    this.relayPubkey = relayPubkey;
  }

  group(id: string): Group | null {
    if (!this.groups.has(id)) this.groups.set(id, loadGroup(this.sql, id));
    return this.groups.get(id) as Group | null;
  }

  /** The reader's roles in group `id`, or null when it is not a member. */
  rolesIn(id: string): string[] | null {
    if (!this.roles.has(id)) {
      const [row] = this.sql
        .exec<{ roles: string }>("SELECT roles FROM group_members WHERE group_id = ? AND pubkey = ?", id, this.reader)
        .toArray();
      this.roles.set(id, row === undefined ? null : (JSON.parse(row.roles) as string[]));
    }
    return this.roles.get(id) as string[] | null;
  }

  isMember(id: string): boolean {
    return this.rolesIn(id) !== null;
  }

  isAdmin(id: string): boolean {
    return this.rolesIn(id)?.includes(ADMIN_ROLE) ?? false;
  }

  /** What carries group `id`'s `h` tag: a private group's members only. A group that does
   * not exist reads as one the reader may not see, as on the ncli relay. */
  readsGroup(id: string): boolean {
    const g = this.group(id);
    return g !== null && (!g.flags.has("private") || this.isMember(id));
  }

  /** The group's own state (39000-39003): hidden from non-members when private or hidden. */
  readsGroupState(id: string): boolean {
    const g = this.group(id);
    return g !== null && (!(g.flags.has("private") || g.flags.has("hidden")) || this.isMember(id));
  }

  visible(e: NostrEvent): boolean {
    if (RECIPIENT_ONLY_KINDS.includes(e.kind) && !tagValues(e, "p").includes(this.reader)) return false;
    for (const id of tagValues(e, "h")) {
      const g = this.group(id);
      if (g !== null && g.flags.has("private") && !this.isMember(id)) return false;
      // A pending join request is for the group's admins, and its author; so is an invite
      // code (9009), which would admit whoever read it.
      const forAdmins = e.kind === GROUP_KINDS.joinRequest || e.kind === GROUP_KINDS.createInvite;
      if (forAdmins && e.pubkey !== this.reader && !this.isAdmin(id)) return false;
    }
    if (isGroupStateKind(e.kind) && e.pubkey === this.relayPubkey) {
      const g = this.group(dTag(e));
      if (g !== null && !this.readsGroupState(g.id)) return false;
    }
    return true;
  }
}

/** Why a REQ names a group the reader may not read, or null. Like the ncli relay, a REQ
 * naming a private group (its `#h`, or its `#d` among group-state kinds) is refused
 * whole, and one naming a group that does not exist is refused the same way. */
function readRefusal(filters: Filter[], access: Access): string | null {
  for (const f of filters) {
    const stateOnly = f.kinds !== undefined && f.kinds.length > 0 && f.kinds.every(isGroupStateKind);
    for (const [name, values] of f.tags) {
      for (const id of values) {
        const denied = (name === "h" && !access.readsGroup(id)) || (name === "d" && stateOnly && !access.readsGroupState(id));
        if (denied) return `restricted: valid membership in group ${id} is required`;
      }
    }
  }
  return null;
}

interface EventRow {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string;
  content: string;
  sig: string;
}

function rowToEvent(row: EventRow): NostrEvent {
  return wireEvent({ ...row, tags: JSON.parse(row.tags) as string[][] });
}

function send(ws: RelaySocket, message: unknown[]): void {
  ws.send(JSON.stringify(message));
}

function attachmentOf(ws: RelaySocket): Attachment {
  const att = ws.deserializeAttachment() as Attachment | null;
  if (att === null || typeof att !== "object" || typeof att.conn !== "string") {
    throw new Error("a WebSocket without a relay attachment reached the relay");
  }
  return att;
}

function idOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

/** What the relay says to one EVENT: OK's flag and message, and the event to deliver to
 * live subscriptions once the author has its answer. */
interface Verdict {
  ok: boolean;
  message: string;
  deliver?: NostrEvent;
}

const refused = (message: string): Verdict => ({ ok: false, message });

function decodeAuthorization(token: string): unknown {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export class RelayDurableObject implements OauthPort {
  ctx: DurableObjectState;
  env: Env;
  sql: SqlStorage;
  cfg: Config;
  // In memory only, and that is enough: an upload holds the object awake while it runs,
  // and per-connection queues are empty whenever the object may hibernate.
  uploadsInFlight = new Map<string, number>();
  queues = new Map<string, Promise<void>>();
  // MCP watches waiting for an event (waitFor); each holds its request, and so the
  // object, awake until it is woken or its deadline passes.
  waiters = new Set<{ filter: Filter; wake: () => void }>();
  // Group state is signed (an await) after the change it reflects is committed. One chain
  // for the whole object, so the newest 39000-39003 always describe the newest state.
  stateChain: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.cfg = readConfig(env);
    for (const statement of SCHEMA) this.sql.exec(statement);
    // Subscriptions of sockets that did not survive a restart of the object.
    const open = this.ctx.getWebSockets().map((ws) => attachmentOf(ws).conn);
    this.sql.exec("DELETE FROM subscriptions WHERE conn NOT IN (SELECT value FROM json_each(?))", JSON.stringify(open));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(ADMIN_PREFIX)) return this.admin(request, url);
    const route = edgeRoute(request.method, url.pathname, request.headers);
    switch (route) {
      case "wire":
        return this.accept();
      case "upload":
        return this.upload(request);
      case "blob":
        return this.blob(request, url.pathname);
      case "mcp":
      case "openapi":
      case "tool":
        return serveMcp(route, request, url, this);
      case "protected-resource":
      case "authorization-server":
      case "register":
      case "authorize":
      case "token":
        return serveOauth(route, request, url, this);
      default:
        return notFound();
    }
  }

  // ------------------------------------------------------------------- WebSockets
  accept(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const att: Attachment = { conn: crypto.randomUUID(), challenge: randomHex(32), pubkey: null };
    server.serializeAttachment(att);
    send(server, ["AUTH", att.challenge]);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  /** Messages of one connection are handled strictly in order, whatever the runtime
   * interleaves at an await. A failure is reported through the returned promise. */
  webSocketMessage(ws: RelaySocket, message: string | ArrayBuffer): Promise<void> {
    const conn = attachmentOf(ws).conn;
    const previous = this.queues.get(conn) ?? Promise.resolve();
    const next = previous.then(() => this.handle(ws, message));
    const tail = next.then(
      () => undefined,
      (err: unknown) => console.error(`relay: message on connection ${conn} failed`, err),
    );
    this.queues.set(conn, tail);
    void tail.then(() => {
      if (this.queues.get(conn) === tail) this.queues.delete(conn);
    });
    return next;
  }

  webSocketClose(ws: RelaySocket, code: number, reason: string): void {
    const conn = attachmentOf(ws).conn;
    this.sql.exec("DELETE FROM subscriptions WHERE conn = ?", conn);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch (err) {
      console.warn(`relay: answering the close of connection ${conn} failed`, err);
    }
  }

  webSocketError(ws: RelaySocket, error: unknown): void {
    const conn = attachmentOf(ws).conn;
    console.warn(`relay: connection ${conn} failed`, error);
    this.sql.exec("DELETE FROM subscriptions WHERE conn = ?", conn);
  }

  async handle(ws: RelaySocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return send(ws, ["NOTICE", "invalid: binary frames are not Nostr messages"]);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch (err) {
      if (err instanceof SyntaxError) return send(ws, ["NOTICE", `invalid: not JSON (${err.message})`]);
      throw err;
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
      return send(ws, ["NOTICE", "invalid: a message is a JSON array that starts with its verb"]);
    }
    switch (parsed[0]) {
      case "AUTH":
        return this.onAuth(ws, parsed[1]);
      case "EVENT":
        return this.onEvent(ws, parsed[1]);
      case "REQ":
        return this.onReq(ws, parsed[1], parsed.slice(2));
      case "CLOSE":
        return this.onClose(ws, parsed[1]);
      default:
        return send(ws, ["NOTICE", `invalid: unsupported verb ${JSON.stringify(parsed[0])}`]);
    }
  }

  async onAuth(ws: RelaySocket, raw: unknown): Promise<void> {
    const id = idOf(raw);
    if (id === null) return send(ws, ["NOTICE", "invalid: AUTH carries no event"]);
    const problem = await eventError(raw);
    if (problem !== null) return send(ws, ["OK", id, false, `invalid: ${problem}`]);
    const e = raw as NostrEvent;
    const att = attachmentOf(ws);
    if (e.kind !== AUTH_KIND) return send(ws, ["OK", id, false, `invalid: an AUTH event is kind ${AUTH_KIND}`]);
    if (tagValue(e, "challenge") !== att.challenge) {
      return send(ws, ["OK", id, false, "invalid: the challenge is not this connection's"]);
    }
    if (!sameRelayUrl(tagValue(e, "relay"), this.cfg.relayHost)) {
      return send(ws, ["OK", id, false, `invalid: the relay tag must be wss://${this.cfg.relayHost}`]);
    }
    if (Math.abs(nowS() - e.created_at) > CLOCK_WINDOW_S) {
      return send(ws, ["OK", id, false, `invalid: created_at is more than ${CLOCK_WINDOW_S}s from the relay's clock`]);
    }
    att.pubkey = e.pubkey;
    ws.serializeAttachment(att);
    send(ws, ["OK", id, true, ""]);
  }

  async onEvent(ws: RelaySocket, raw: unknown): Promise<void> {
    const id = idOf(raw);
    if (id === null) return send(ws, ["NOTICE", "invalid: EVENT carries no event"]);
    const me = attachmentOf(ws).pubkey;
    if (me === null) return send(ws, ["OK", id, false, "auth-required: answer the AUTH challenge first"]);
    const verdict = await this.verdict(raw, me);
    send(ws, ["OK", id, verdict.ok, verdict.message]);
    if (verdict.deliver !== undefined) this.broadcast(verdict.deliver);
  }

  /** What the relay does with an EVENT from a connection authenticated as `me`: every
   * gate in order, the change it makes, and what it answers. The one door for a socket's
   * EVENT and an MCP persona's (publish), so neither meets a gate the other does not. */
  async verdict(raw: unknown, me: string): Promise<Verdict> {
    const problem = await eventError(raw);
    if (problem !== null) return refused(`invalid: ${problem}`);
    const e = wireEvent(raw as NostrEvent);
    if (e.kind === AUTH_KIND) return refused("invalid: AUTH events go in an AUTH message");
    if (!this.takeToken(me)) return refused(`rate-limited: at most ${this.cfg.eventsPerMinute} events a minute per key`);
    if (e.kind === INVITE_CLAIM_KIND) return this.redeem(e, me);
    if (!this.isMember(me)) return refused("restricted: this key is not a member of the relay");
    if (e.pubkey !== me) {
      if (isProtected(e)) return refused("restricted: a protected event is accepted only from its author");
      if (!this.isMember(e.pubkey)) return refused("restricted: the event's author is not a member of the relay");
    }
    const expiration = expirationOf(e);
    if (expiration === "invalid") return refused("invalid: the expiration tag is not a timestamp");
    if (expiration !== null && expiration <= nowS()) return refused("invalid: the event has already expired");
    if (e.kind === INVITE_KIND || isGroupStateKind(e.kind)) {
      return refused(`restricted: kind ${e.kind} is signed by the relay alone`);
    }
    if (isGroupRequestKind(e.kind)) return this.onGroupRequest(e, me, expiration);
    // Posting into a group that is private, restricted or closed takes a member of it: the
    // key that authenticated, and the author when that is someone else.
    for (const group of tagValues(e, "h")) {
      const g = this.access(me).group(group);
      if (g === null || !["private", "restricted", "closed"].some((flag) => g.flags.has(flag))) continue;
      const members = e.pubkey === me ? [me] : [me, e.pubkey];
      if (!members.every((pk) => this.access(pk).isMember(group))) {
        return refused(`restricted: only members may post in group ${group}`);
      }
    }
    const cls = kindClass(e.kind);
    if (cls === "ephemeral") return { ok: true, message: "", deliver: e };
    const outcome = this.store(e, cls, expiration);
    if (outcome === "duplicate") return { ok: true, message: "duplicate: already have this event" };
    if (outcome === "superseded") return { ok: true, message: "duplicate: a newer version is stored" };
    return { ok: true, message: "", deliver: e };
  }

  redeem(e: NostrEvent, me: string): Verdict {
    if (e.pubkey !== me) return refused("restricted: an invite claim is accepted only from the key that authenticated");
    const code = tagValue(e, "claim");
    if (code === null || code === "") return refused("invalid: the claim tag carries no invite code");
    if (this.isMember(me)) return { ok: true, message: "duplicate: already a member" };
    const now = nowS();
    const redeemed = this.ctx.storage.transactionSync(() => {
      const [invite] = this.sql
        .exec<{ expires_at: number; max_uses: number; uses: number }>(
          "SELECT expires_at, max_uses, uses FROM invites WHERE code = ?",
          code,
        )
        .toArray();
      if (invite === undefined || invite.expires_at <= now || invite.uses >= invite.max_uses) return false;
      this.sql.exec("UPDATE invites SET uses = uses + 1 WHERE code = ?", code);
      this.sql.exec("INSERT INTO members (pubkey, added_at, via) VALUES (?, ?, 'invite') ON CONFLICT DO NOTHING", me, now);
      return true;
    });
    if (!redeemed) return refused("restricted: the invite is unknown, spent or expired");
    return { ok: true, message: "" };
  }

  // ----------------------------------------------------------------------- NIP-29
  /** A group request (9000-9022). Answers in the ncli relay's words. */
  async onGroupRequest(e: NostrEvent, me: string, expiration: number | null): Promise<Verdict> {
    const reply = (ok: boolean, message: string): Verdict => ({ ok, message });
    if (e.pubkey !== me) {
      return reply(false, "restricted: a group request is accepted only from the key that authenticated");
    }
    const id = tagValue(e, "h");
    if (id === null || id === "") return reply(false, "invalid: nip29: missing h tag (group id)");
    if (!GROUP_ID.test(id)) return reply(false, "invalid: a group id is made of a-z, 0-9, '-' and '_' (NIP-29)");
    // A request already applied is not applied again: a replayed put-user re-adds no one.
    if (this.sql.exec("SELECT 1 AS hit FROM events WHERE id = ?", e.id).toArray().length > 0) {
      return reply(true, "duplicate: already have this event");
    }
    const access = this.access(me);
    const group = access.group(id);
    const now = nowS();
    const { admins, members, metadata, roles } = GROUP_KINDS;

    if (e.kind === GROUP_KINDS.createGroup) {
      // groups.create: [members]. Every key that gets this far is an enrolled member.
      if (group !== null) return reply(access.isAdmin(id), "duplicate: a group with that id already exists.");
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "INSERT INTO groups (id, created_at, created_by, metadata) VALUES (?, ?, ?, ?)",
          id,
          now,
          me,
          JSON.stringify(NEW_GROUP_METADATA),
        );
        this.sql.exec(
          "INSERT INTO group_members (group_id, pubkey, roles, added_at) VALUES (?, ?, ?, ?)",
          id,
          me,
          JSON.stringify([ADMIN_ROLE]),
          now,
        );
      });
      this.keepModeration(e, expiration);
      await this.publishGroupState(id, [metadata, admins, members, roles]);
      return reply(true, `info: group ${id} created.`);
    }
    if (group === null) return reply(false, "restricted: no such group.");

    if (e.kind === GROUP_KINDS.putUser || e.kind === GROUP_KINDS.removeUser) {
      const adding = e.kind === GROUP_KINDS.putUser;
      if (!access.isAdmin(id)) {
        return reply(false, `restricted: you may not ${adding ? "add members to" : "remove members from"} this group.`);
      }
      const target = e.tags.find((t) => t[0] === "p" && t.length > 1);
      if (target === undefined) return reply(false, "invalid: nip29: missing p tag");
      if (!isHex64(target[1])) return reply(false, "invalid: the p tag is not a 64-hex public key");
      const pk = target[1];
      const granted = [...new Set(target.slice(2).map((r) => r.trim().toLowerCase()).filter((r) => r !== ""))];
      if ((!adding || !granted.includes(ADMIN_ROLE)) && this.isLastAdmin(id, pk)) {
        return reply(false, `restricted: the group's last admin cannot be ${adding ? "demoted" : "removed"}.`);
      }
      this.ctx.storage.transactionSync(() => {
        if (adding) {
          this.sql.exec(
            `INSERT INTO group_members (group_id, pubkey, roles, added_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (group_id, pubkey) DO UPDATE SET roles = excluded.roles`,
            id,
            pk,
            JSON.stringify(granted),
            now,
          );
        } else {
          this.sql.exec("DELETE FROM group_members WHERE group_id = ? AND pubkey = ?", id, pk);
        }
        // An accepted or declined join request is no longer pending.
        this.dropJoinRequests(id, pk);
      });
      this.keepModeration(e, expiration);
      await this.publishGroupState(id, [admins, members]);
      return reply(true, adding ? "info: member added." : "info: member removed.");
    }

    if (e.kind === GROUP_KINDS.editMetadata) {
      if (!access.isAdmin(id)) return reply(false, "restricted: only a group admin may edit this group's metadata.");
      this.sql.exec("UPDATE groups SET metadata = ? WHERE id = ?", JSON.stringify(requestedMetadata(e)), id);
      this.keepModeration(e, expiration);
      await this.publishGroupState(id, [metadata]);
      return reply(true, "info: group metadata updated.");
    }

    if (e.kind === GROUP_KINDS.createInvite) {
      if (!access.isAdmin(id)) return reply(false, "restricted: only a group admin may create invites.");
      const codes = [...new Set(tagValues(e, "code").filter((c) => c !== ""))];
      if (codes.length === 0) return reply(false, "invalid: nip29: missing code tag (invite code)");
      const elsewhere = this.sql
        .exec<{ code: string }>(
          "SELECT code FROM group_invites WHERE code IN (SELECT value FROM json_each(?)) AND group_id != ?",
          JSON.stringify(codes),
          id,
        )
        .toArray();
      if (elsewhere.length > 0) return reply(false, "invalid: that invite code already belongs to another group");
      // A code registered again stays as it was, spent or not: on the ncli relay too, one
      // code admits one key however many 9009s name it.
      this.ctx.storage.transactionSync(() => {
        for (const code of codes) {
          this.sql.exec(
            "INSERT INTO group_invites (code, group_id, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING",
            code,
            id,
            me,
            now,
          );
        }
      });
      this.keepModeration(e, expiration);
      return reply(true, "info: invite created.");
    }

    if (e.kind === GROUP_KINDS.joinRequest) {
      if (access.isMember(id)) return reply(true, "duplicate: you are already a member of this group.");
      const code = tagValue(e, "code");
      if (code !== null) {
        // A code from a 9009 admits at once, one key, once. As on the ncli relay, the
        // request itself is not kept: it did its work, and it carries the code.
        const admitted = this.ctx.storage.transactionSync(() => {
          const spent = this.sql
            .exec(
              "UPDATE group_invites SET used_by = ?, used_at = ? WHERE code = ? AND group_id = ? AND used_by IS NULL RETURNING code",
              me,
              now,
              code,
              id,
            )
            .toArray();
          if (spent.length === 0) return false;
          this.sql.exec("INSERT INTO group_members (group_id, pubkey, roles, added_at) VALUES (?, ?, '[]', ?)", id, me, now);
          this.dropJoinRequests(id, me); // one left from before the code came
          return true;
        });
        if (!admitted) return reply(false, "restricted: that is an invalid invite code.");
        await this.publishGroupState(id, [members]);
        return reply(true, "info: welcome to the group!");
      }
      if (group.flags.has("closed")) {
        // groups.pendingJoins: the request waits for the group's admins, who read it with
        // REQ {"kinds": [9021], "#h": [<group>]} and answer with 9000 or 9001.
        this.store(e, "regular", expiration);
        this.broadcast(e);
        return reply(true, "info: your join request is pending admin approval.");
      }
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("INSERT INTO group_members (group_id, pubkey, roles, added_at) VALUES (?, ?, '[]', ?)", id, me, now);
        this.dropJoinRequests(id, me); // one left from when the group was closed
      });
      await this.publishGroupState(id, [members]);
      return reply(true, "info: you joined the group.");
    }

    if (e.kind === GROUP_KINDS.leaveRequest) {
      if (!access.isMember(id)) {
        const withdrawn = this.ctx.storage.transactionSync(() => this.dropJoinRequests(id, me));
        return reply(true, withdrawn > 0 ? "info: your join request is withdrawn." : "duplicate: you are not a member of this group.");
      }
      if (this.isLastAdmin(id, me)) return reply(false, "restricted: the group's last admin cannot leave it.");
      this.sql.exec("DELETE FROM group_members WHERE group_id = ? AND pubkey = ?", id, me);
      await this.publishGroupState(id, [admins, members]);
      return reply(true, "info: you have left the group.");
    }

    return reply(false, `invalid: kind ${e.kind} is not a NIP-29 request this relay implements (${IMPLEMENTED_GROUP_REQUESTS})`);
  }

  /** groups.moderationLog: an accepted moderation event is kept, for the group to read. */
  keepModeration(e: NostrEvent, expiration: number | null): void {
    this.store(e, "regular", expiration);
    this.broadcast(e);
  }

  isLastAdmin(id: string, pubkey: string): boolean {
    const admins = this.sql
      .exec<{ pubkey: string }>(
        "SELECT pubkey FROM group_members, json_each(group_members.roles) AS role WHERE group_id = ? AND role.value = ?",
        id,
        ADMIN_ROLE,
      )
      .toArray();
    return admins.length === 1 && admins[0].pubkey === pubkey;
  }

  /** Delete `pubkey`'s pending join requests to group `id`; how many there were. */
  dropJoinRequests(id: string, pubkey: string): number {
    const pending = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM events WHERE kind = ? AND pubkey = ?
         AND id IN (SELECT event_id FROM event_tags WHERE name = 'h' AND value = ?)`,
        GROUP_KINDS.joinRequest,
        pubkey,
        id,
      )
      .toArray();
    for (const row of pending) {
      this.sql.exec("DELETE FROM event_tags WHERE event_id = ?", row.id);
      this.sql.exec("DELETE FROM events WHERE id = ?", row.id);
    }
    return pending.length;
  }

  /** Sign and store group `id`'s state events of `kinds` as the tables hold it now. Runs in
   * order on one chain; a failure reaches the caller and is logged. */
  publishGroupState(id: string, kinds: number[]): Promise<void> {
    const run = this.stateChain.then(() => this.writeGroupState(id, kinds));
    this.stateChain = run.catch((err: unknown) => console.error(`relay: publishing the state of group ${id} failed`, err));
    return run;
  }

  async writeGroupState(id: string, kinds: number[]): Promise<void> {
    const group = loadGroup(this.sql, id);
    if (group === null) throw new Error(`group ${id} has no row to publish`);
    const seats = this.sql
      .exec<{ pubkey: string; roles: string }>(
        "SELECT pubkey, roles FROM group_members WHERE group_id = ? ORDER BY added_at, pubkey",
        id,
      )
      .toArray()
      .map((row) => ({ pubkey: row.pubkey, roles: JSON.parse(row.roles) as string[] }));
    const key = this.cfg.relayKey;
    for (const kind of kinds) {
      const d = ["d", id];
      let tags: string[][];
      if (kind === GROUP_KINDS.metadata) tags = [d, ...group.metadata];
      else if (kind === GROUP_KINDS.admins) tags = [d, ...seats.filter((s) => s.roles.length > 0).map((s) => ["p", s.pubkey, ...s.roles])];
      else if (kind === GROUP_KINDS.members) tags = [d, ...seats.map((s) => ["p", s.pubkey])];
      else if (kind === GROUP_KINDS.roles) tags = [d, ["role", ADMIN_ROLE, ADMIN_ROLE_DESCRIPTION]];
      else throw new Error(`kind ${kind} is not group state`);
      // Strictly newer than the version it replaces, so every client's NIP-01 rule agrees.
      const [current] = this.sql
        .exec<{ created_at: number }>("SELECT created_at FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ?", key.pubkey, kind, id)
        .toArray();
      const createdAt = Math.max(nowS(), current === undefined ? 0 : current.created_at + 1);
      const state = await signEvent(key, kind, tags, "", createdAt);
      if (this.store(state, "addressable", null) !== "stored") {
        throw new Error(`group ${id} state kind ${kind} was not stored over the version before it`);
      }
      this.broadcast(state);
    }
  }

  store(e: NostrEvent, cls: KindClass, expiration: number | null): "stored" | "duplicate" | "superseded" {
    return this.ctx.storage.transactionSync(() => {
      if (this.sql.exec("SELECT 1 AS hit FROM events WHERE id = ?", e.id).toArray().length > 0) return "duplicate";
      const address = cls === "addressable" ? dTag(e) : null;
      if (cls === "replaceable" || cls === "addressable") {
        const current = this.sql
          .exec<{ id: string; created_at: number }>(
            "SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d_tag IS ?",
            e.pubkey,
            e.kind,
            address,
          )
          .toArray();
        // NIP-01: the newest wins; on the same second, the lowest id.
        if (current.some((c) => c.created_at > e.created_at || (c.created_at === e.created_at && c.id < e.id))) {
          return "superseded";
        }
        for (const c of current) {
          this.sql.exec("DELETE FROM event_tags WHERE event_id = ?", c.id);
          this.sql.exec("DELETE FROM events WHERE id = ?", c.id);
        }
      }
      this.sql.exec(
        "INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, d_tag, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        e.id,
        e.pubkey,
        e.created_at,
        e.kind,
        JSON.stringify(e.tags),
        e.content,
        e.sig,
        address,
        expiration,
      );
      for (const t of e.tags) {
        if (t.length > 1 && /^[a-zA-Z]$/.test(t[0])) {
          this.sql.exec("INSERT INTO event_tags (event_id, name, value) VALUES (?, ?, ?)", e.id, t[0], t[1]);
        }
      }
      return "stored";
    });
  }

  async onReq(ws: RelaySocket, subId: unknown, rawFilters: unknown[]): Promise<void> {
    if (typeof subId !== "string" || subId.length === 0 || subId.length > MAX_SUBID_LENGTH) {
      return send(ws, ["NOTICE", `invalid: a subscription id is a string of 1 to ${MAX_SUBID_LENGTH} characters`]);
    }
    const att = attachmentOf(ws);
    if (att.pubkey === null) return send(ws, ["CLOSED", subId, "auth-required: answer the AUTH challenge first"]);
    if (!this.isMember(att.pubkey)) return send(ws, ["CLOSED", subId, "restricted: this key is not a member of the relay"]);
    if (rawFilters.length === 0) return send(ws, ["CLOSED", subId, "invalid: a REQ needs at least one filter"]);
    const filters: Filter[] = [];
    for (const raw of rawFilters) {
      const f = parseFilter(raw);
      if (typeof f === "string") return send(ws, ["CLOSED", subId, `invalid: ${f}`]);
      filters.push(f);
    }
    if (filters.length === 1 && filters[0].kinds?.length === 1 && filters[0].kinds[0] === INVITE_KIND) {
      return this.mintInvite(ws, subId, att.pubkey);
    }
    const access = this.access(att.pubkey);
    const refusal = readRefusal(filters, access);
    if (refusal !== null) return send(ws, ["CLOSED", subId, refusal]);
    this.sql.exec(
      "INSERT INTO subscriptions (conn, sub_id, filters) VALUES (?, ?, ?) ON CONFLICT (conn, sub_id) DO UPDATE SET filters = excluded.filters",
      att.conn,
      subId,
      JSON.stringify(rawFilters),
    );
    const now = nowS();
    if (filters.length === 1) {
      for (const e of this.query(filters[0], now, access)) send(ws, ["EVENT", subId, e]);
    } else {
      const seen = new Map<string, NostrEvent>();
      for (const f of filters) for (const e of this.query(f, now, access)) seen.set(e.id, e);
      const events = [...seen.values()].sort(
        (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      for (const e of events) send(ws, ["EVENT", subId, e]);
    }
    send(ws, ["EOSE", subId]);
  }

  /** NIP-43 invite request: a member mints a single-use invite and gets it back as an
   * ephemeral kind 28935 the relay signs, then EOSE, then the one-shot subscription closes,
   * as on the ncli relay. Each one costs a token of the key's event rate limit. */
  async mintInvite(ws: RelaySocket, subId: string, me: string): Promise<void> {
    const invite = await this.mintCode(me);
    if (typeof invite === "string") return send(ws, ["CLOSED", subId, invite]);
    send(ws, ["EVENT", subId, invite]);
    send(ws, ["EOSE", subId]);
    send(ws, ["CLOSED", subId, "one-shot invite request completed"]);
  }

  /** One member-minted invite: the relay-signed kind 28935 carrying its code, or why not. */
  async mintCode(me: string): Promise<NostrEvent | string> {
    if (!this.takeToken(me)) return `rate-limited: at most ${this.cfg.eventsPerMinute} events and invites a minute per key`;
    const now = nowS();
    const code = randomHex(32);
    const invite = await signEvent(this.cfg.relayKey, INVITE_KIND, [["-"], ["claim", code]], "", now);
    this.sql.exec(
      "INSERT INTO invites (code, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, 0)",
      code,
      now,
      now + MEMBER_INVITE_TTL_S,
      MEMBER_INVITE_MAX_USES,
    );
    return invite;
  }

  access(reader: string): Access {
    return new Access(this.sql, reader, this.cfg.relayKey.pubkey);
  }

  // --------------------------------------------------- the MCP persona's port (RelayPort)
  // What mailbox.ts may do on the relay for a persona it signs for: exactly what a socket
  // authenticated as that key may, through the same code.
  get host(): string {
    return this.cfg.relayHost;
  }

  get relayPubkey(): string {
    return this.cfg.relayKey.pubkey;
  }

  /** An EVENT from `me`, as onEvent takes it from a socket authenticated as `me`. */
  async publish(e: NostrEvent, me: string): Promise<[boolean, string]> {
    const verdict = await this.verdict(e, me);
    if (verdict.deliver !== undefined) this.broadcast(verdict.deliver);
    return [verdict.ok, verdict.message];
  }

  /** A REQ's stored answer for `reader`, oldest first, as onReq serves it. A refusal
   * throws RelayRefusal with the reason onReq would close the subscription with. */
  read(reader: string, rawFilters: unknown[]): NostrEvent[] {
    if (!this.isMember(reader)) throw new RelayRefusal("restricted: this key is not a member of the relay");
    if (rawFilters.length === 0) throw new RelayRefusal("invalid: a REQ needs at least one filter");
    const filters: Filter[] = [];
    for (const raw of rawFilters) {
      const f = parseFilter(raw);
      if (typeof f === "string") throw new RelayRefusal(`invalid: ${f}`);
      filters.push(f);
    }
    const access = this.access(reader);
    const refusal = readRefusal(filters, access);
    if (refusal !== null) throw new RelayRefusal(refusal);
    const now = nowS();
    const seen = new Map<string, NostrEvent>();
    for (const f of filters) for (const e of this.query(f, now, access)) seen.set(e.id, e);
    return [...seen.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** A member-minted invite code, as REQ kind 28935 mints one for a member. */
  async mintInviteCode(me: string): Promise<string> {
    if (!this.isMember(me)) throw new RelayRefusal("restricted: this key is not a member of the relay");
    const invite = await this.mintCode(me);
    if (typeof invite === "string") throw new RelayRefusal(invite);
    return tagValue(invite, "claim") as string;
  }

  /** Whether `code` is a relay invite that would still admit a key. Spends nothing. */
  inviteOpen(code: string): boolean {
    return (
      this.sql
        .exec("SELECT 1 AS hit FROM invites WHERE code = ? AND expires_at > ? AND uses < max_uses", code, nowS())
        .toArray().length > 0
    );
  }

  /** Where `pubkey` stands in group `group`: a member, a join request waiting for its
   * admins, outside it, or there is no such group. */
  groupStanding(group: string, pubkey: string): "member" | "pending" | "outside" | "absent" {
    if (loadGroup(this.sql, group) === null) return "absent";
    if (this.access(pubkey).isMember(group)) return "member";
    const waiting = this.sql
      .exec(
        `SELECT 1 AS hit FROM events WHERE kind = ? AND pubkey = ?
         AND id IN (SELECT event_id FROM event_tags WHERE name = 'h' AND value = ?)`,
        GROUP_KINDS.joinRequest,
        pubkey,
        group,
      )
      .toArray();
    return waiting.length > 0 ? "pending" : "outside";
  }

  /** The bytes of a stored blob, or null. The caller has checked the reader's standing. */
  async blobBytes(sha256Hex: string): Promise<Uint8Array | null> {
    const object = await this.env.BLOSSOM_BUCKET.get(sha256Hex);
    return object === null ? null : new Uint8Array(await new Response(object.body).arrayBuffer());
  }

  /** Armed at once: `arrived` resolves when an event matching `filter` is delivered, or at
   * `deadlineMs`, whichever is first; `cancel` disarms it. */
  waitFor(filter: Filter, deadlineMs: number): { arrived: Promise<void>; cancel(): void } {
    let wake = (): void => undefined;
    const arrived = new Promise<void>((resolve) => {
      // A deadline past setTimeout's ceiling wakes at the ceiling; the watch re-arms.
      const timer = setTimeout(() => wake(), Math.min(Math.max(0, deadlineMs - Date.now()), MAX_TIMER_MS));
      const waiter = { filter, wake: () => wake() };
      wake = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve();
      };
      this.waiters.add(waiter);
    });
    return { arrived, cancel: () => wake() };
  }

  openSession(id: string, tokenDigest: string, protocol: string): void {
    this.sql.exec(
      "INSERT INTO mcp_sessions (id, token_digest, protocol, created_at) VALUES (?, ?, ?, ?)",
      id,
      tokenDigest,
      protocol,
      nowS(),
    );
  }

  /** The token digest session `id` is bound to, or null when there is no such session. */
  sessionToken(id: string): string | null {
    const [row] = this.sql.exec<{ token_digest: string }>("SELECT token_digest FROM mcp_sessions WHERE id = ?", id).toArray();
    return row === undefined ? null : row.token_digest;
  }

  endSession(id: string): boolean {
    return this.sql.exec("DELETE FROM mcp_sessions WHERE id = ? RETURNING id", id).toArray().length > 0;
  }

  // ------------------------------------------------------- the OAuth server's port (OauthPort)
  get relayName(): string {
    return this.cfg.relayName;
  }

  /** RELAY_SIGNING_KEY, which readConfig checked is a secret key: the OAuth keys' root. */
  get oauthSecret(): string {
    return (this.env.RELAY_SIGNING_KEY as string).trim().toLowerCase();
  }

  spendCode(id: string, expiresAt: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      // A code past its expiry is refused for that alone, so its row has done its work.
      this.sql.exec("DELETE FROM oauth_spent_codes WHERE expires_at <= ?", nowS());
      const spent = this.sql
        .exec("INSERT INTO oauth_spent_codes (id, expires_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id", id, expiresAt)
        .toArray();
      return spent.length > 0;
    });
  }

  /** The stored events `f` matches that `access` may see, newest first, at most `limit` of
   * them. Pages through the store, so events the reader may not see never use up the
   * limit. */
  *query(f: Filter, now: number, access: Access): Generator<NostrEvent> {
    const where = ["(expires_at IS NULL OR expires_at > ?)"];
    const binds: SqlValue[] = [now];
    // A first cut of the recipient-only rule in SQL; access.visible() below is the rule.
    where.push("(kind NOT IN (SELECT value FROM json_each(?)) OR id IN (SELECT event_id FROM event_tags WHERE name = 'p' AND value = ?))");
    binds.push(JSON.stringify(RECIPIENT_ONLY_KINDS), access.reader);
    if (f.ids !== undefined) {
      where.push("id IN (SELECT value FROM json_each(?))");
      binds.push(JSON.stringify(f.ids));
    }
    if (f.authors !== undefined) {
      where.push("pubkey IN (SELECT value FROM json_each(?))");
      binds.push(JSON.stringify(f.authors));
    }
    if (f.kinds !== undefined) {
      where.push("kind IN (SELECT value FROM json_each(?))");
      binds.push(JSON.stringify(f.kinds));
    }
    if (f.since !== undefined) {
      where.push("created_at >= ?");
      binds.push(f.since);
    }
    if (f.until !== undefined) {
      where.push("created_at <= ?");
      binds.push(f.until);
    }
    for (const [name, values] of f.tags) {
      where.push("id IN (SELECT event_id FROM event_tags WHERE name = ? AND value IN (SELECT value FROM json_each(?)))");
      binds.push(name, JSON.stringify(values));
    }
    // `limit: 0` means "no limit" on the ncli relay too; either way MAX_LIMIT caps it.
    let wanted = f.limit === undefined || f.limit === 0 ? MAX_LIMIT : Math.min(f.limit, MAX_LIMIT);
    let after: [number, string] | null = null;
    while (wanted > 0) {
      const asked = wanted;
      const page: EventRow[] = this.sql
        .exec<EventRow>(
          `SELECT id, pubkey, created_at, kind, tags, content, sig FROM events WHERE ${where.join(" AND ")}
           ${after === null ? "" : "AND (created_at < ? OR (created_at = ? AND id > ?))"}
           ORDER BY created_at DESC, id ASC LIMIT ?`,
          ...binds,
          ...(after === null ? [] : [after[0], after[0], after[1]]),
          asked,
        )
        .toArray();
      for (const row of page) {
        after = [row.created_at, row.id];
        const e = rowToEvent(row);
        if (!access.visible(e)) continue;
        wanted--;
        yield e;
      }
      if (page.length < asked) return;
    }
  }

  onClose(ws: RelaySocket, subId: unknown): void {
    if (typeof subId !== "string") return send(ws, ["NOTICE", "invalid: CLOSE names a subscription id"]);
    this.sql.exec("DELETE FROM subscriptions WHERE conn = ? AND sub_id = ?", attachmentOf(ws).conn, subId);
  }

  broadcast(e: NostrEvent): void {
    // Per reader: false when it is not a member, or may not see `e`.
    const sees = new Map<string, boolean>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachmentOf(ws);
      if (att.pubkey === null) continue;
      const reader = att.pubkey;
      const subs = this.sql
        .exec<{ sub_id: string; filters: string }>("SELECT sub_id, filters FROM subscriptions WHERE conn = ?", att.conn)
        .toArray();
      for (const sub of subs) {
        const filters = (JSON.parse(sub.filters) as unknown[]).map(parseFilter) as Filter[];
        if (!filters.some((f) => matchesFilter(f, e))) continue;
        if (!sees.has(reader)) sees.set(reader, this.isMember(reader) && this.access(reader).visible(e));
        if (!sees.get(reader)) continue;
        try {
          send(ws, ["EVENT", sub.sub_id, e]);
        } catch (err) {
          // One socket going away must not stop delivery to the others.
          console.warn(`relay: delivering ${e.id} to connection ${att.conn} failed`, err);
        }
      }
    }
    // A waiting MCP watch only learns that something arrived: it reads again through
    // read(), which decides what its persona may see.
    for (const waiter of [...this.waiters]) if (matchesFilter(waiter.filter, e)) waiter.wake();
  }

  isMember(pubkey: string): boolean {
    return this.sql.exec("SELECT 1 AS hit FROM members WHERE pubkey = ?", pubkey).toArray().length > 0;
  }

  /** A token bucket per key: EVENTS_PER_MINUTE tokens, refilled continuously. */
  takeToken(pubkey: string): boolean {
    const capacity = this.cfg.eventsPerMinute;
    const now = Date.now();
    const [row] = this.sql
      .exec<{ tokens: number; updated_ms: number }>("SELECT tokens, updated_ms FROM rate WHERE pubkey = ?", pubkey)
      .toArray();
    const tokens = row === undefined
      ? capacity
      : Math.min(capacity, row.tokens + ((now - row.updated_ms) * capacity) / MS_PER_MINUTE);
    const allowed = tokens >= 1;
    this.sql.exec(
      "INSERT INTO rate (pubkey, tokens, updated_ms) VALUES (?, ?, ?) ON CONFLICT (pubkey) DO UPDATE SET tokens = excluded.tokens, updated_ms = excluded.updated_ms",
      pubkey,
      allowed ? tokens - 1 : tokens,
      now,
    );
    return allowed;
  }

  /** Close every subscription a revoked key holds. Its sockets stay open and carry nothing. */
  evict(pubkey: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachmentOf(ws);
      if (att.pubkey !== pubkey) continue;
      const subs = this.sql
        .exec<{ sub_id: string }>("SELECT sub_id FROM subscriptions WHERE conn = ?", att.conn)
        .toArray();
      this.sql.exec("DELETE FROM subscriptions WHERE conn = ?", att.conn);
      for (const sub of subs) send(ws, ["CLOSED", sub.sub_id, "restricted: membership revoked"]);
    }
  }

  // ---------------------------------------------------------------------- Blossom
  async authorize(
    request: Request,
    verb: "upload" | "get",
    blob: string | null,
  ): Promise<{ pubkey: string; sha256: string } | Response> {
    const header = request.headers.get("Authorization");
    if (header === null || !header.startsWith("Nostr ")) {
      return refuse(401, "a signed kind 24242 authorization is required");
    }
    let raw: unknown;
    try {
      raw = decodeAuthorization(header.slice("Nostr ".length).trim());
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof TypeError || err instanceof DOMException) {
        return refuse(401, `the authorization is not base64 JSON (${(err as Error).message})`);
      }
      throw err;
    }
    const problem = await eventError(raw);
    if (problem !== null) return refuse(401, `invalid authorization: ${problem}`);
    const e = raw as NostrEvent;
    const now = nowS();
    if (e.kind !== BLOSSOM_AUTH_KIND) return refuse(401, `an authorization is kind ${BLOSSOM_AUTH_KIND}`);
    if (tagValue(e, "t") !== verb) return refuse(401, `the authorization is not for ${verb}`);
    const expiration = expirationOf(e);
    if (expiration === null || expiration === "invalid" || expiration <= now) {
      return refuse(401, "the authorization has no expiration tag in the future");
    }
    if (e.created_at > now + CLOCK_WINDOW_S) return refuse(401, "the authorization is dated in the future");
    if (!tagValues(e, "server").includes(this.cfg.relayHost)) {
      return refuse(401, `the authorization does not name this server (${this.cfg.relayHost})`);
    }
    const hashes = tagValues(e, "x");
    let target: string;
    if (blob !== null) {
      if (hashes.length > 0 && !hashes.includes(blob)) return refuse(403, "the authorization is for other blobs");
      target = blob;
    } else {
      const declared = request.headers.get("X-SHA-256");
      if (declared !== null) {
        if (!hashes.includes(declared)) return refuse(401, "X-SHA-256 is not among the authorization's x tags");
        target = declared;
      } else if (hashes.length === 1) {
        target = hashes[0];
      } else {
        return refuse(401, "name the blob with exactly one x tag, or an X-SHA-256 header");
      }
      if (!isHex64(target)) return refuse(401, "an x tag is 64 lowercase hex characters");
    }
    if (!this.isMember(e.pubkey)) return refuse(403, "restricted: this key is not a member of the relay");
    return { pubkey: e.pubkey, sha256: target };
  }

  async upload(request: Request): Promise<Response> {
    const declared = request.headers.get("Content-Length");
    if (declared === null) return refuse(411, "Content-Length is required");
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) return refuse(400, "Content-Length is not a byte count");
    if (size > this.cfg.maxBlobBytes) {
      return refuse(413, `the blob is ${size} bytes; this relay takes at most ${this.cfg.maxBlobBytes}`);
    }
    const auth = await this.authorize(request, "upload", null);
    if (auth instanceof Response) return auth;
    const inFlight = this.uploadsInFlight.get(auth.pubkey) ?? 0;
    if (inFlight >= this.cfg.maxUploadsPerSigner) {
      return refuse(429, `at most ${this.cfg.maxUploadsPerSigner} uploads in flight per key`);
    }
    this.uploadsInFlight.set(auth.pubkey, inFlight + 1);
    try {
      const bucket = this.env.BLOSSOM_BUCKET;
      if ((await bucket.head(auth.sha256)) === null) {
        const contentType = request.headers.get("Content-Type") || "application/octet-stream";
        try {
          await bucket.put(auth.sha256, request.body, { sha256: auth.sha256, httpMetadata: { contentType } });
        } catch (err) {
          if (err instanceof Error && CHECKSUM_REFUSAL.test(err.message)) {
            console.warn(`relay: upload of ${auth.sha256} by ${auth.pubkey} refused by R2: ${err.message}`);
            return refuse(400, "the uploaded bytes do not hash to the authorization's x tag");
          }
          throw err;
        }
      } else if (request.body !== null) {
        await request.body.cancel();
      }
      const stored = await bucket.head(auth.sha256);
      if (stored === null) throw new Error(`R2 reports no object ${auth.sha256} right after storing it`);
      return json(200, {
        url: `https://${this.cfg.relayHost}/media/${auth.sha256}`,
        sha256: auth.sha256,
        size: stored.size,
        type: stored.httpMetadata?.contentType ?? "application/octet-stream",
        uploaded: Math.floor(stored.uploaded.getTime() / 1000),
      });
    } finally {
      const left = (this.uploadsInFlight.get(auth.pubkey) ?? 1) - 1;
      if (left > 0) this.uploadsInFlight.set(auth.pubkey, left);
      else this.uploadsInFlight.delete(auth.pubkey);
    }
  }

  async blob(request: Request, pathname: string): Promise<Response> {
    const match = BLOB_PATH.exec(pathname);
    if (match === null) return notFound();
    const sha = match[2];
    const auth = await this.authorize(request, "get", sha);
    if (auth instanceof Response) return auth;
    const bucket = this.env.BLOSSOM_BUCKET;
    const object = request.method === "HEAD" ? await bucket.head(sha) : await bucket.get(sha);
    if (object === null) return refuse(404, "no such blob");
    const headers = {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response((object as R2ObjectBody).body, { status: 200, headers });
  }

  // ------------------------------------------------------------------------ admin
  // Reached only through the Worker, after it checked ADMIN_TOKEN.
  async admin(request: Request, url: URL): Promise<Response> {
    const [collection, item, ...rest] = url.pathname.slice(ADMIN_PREFIX.length).split("/");
    const method = request.method;
    const now = nowS();
    if (rest.length === 0 && collection === "invites" && !item) {
      if (method === "GET") {
        return json(200, { invites: this.sql.exec("SELECT code, created_at, expires_at, max_uses, uses FROM invites ORDER BY created_at").toArray() });
      }
      if (method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch (err) {
          if (err instanceof SyntaxError) return json(400, { error: `the body is not JSON: ${err.message}` });
          throw err;
        }
        const { ttl_seconds: ttl, max_uses: maxUses } = (body ?? {}) as Record<string, unknown>;
        if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0) {
          return json(400, { error: "ttl_seconds must be a positive integer" });
        }
        if (typeof maxUses !== "number" || !Number.isSafeInteger(maxUses) || maxUses <= 0) {
          return json(400, { error: "max_uses must be a positive integer" });
        }
        const invite = { code: randomHex(32), created_at: now, expires_at: now + ttl, max_uses: maxUses, uses: 0 };
        this.sql.exec(
          "INSERT INTO invites (code, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, 0)",
          invite.code,
          invite.created_at,
          invite.expires_at,
          invite.max_uses,
        );
        return json(201, invite);
      }
    }
    if (rest.length === 0 && collection === "invites" && item && method === "DELETE") {
      const gone = this.sql.exec("DELETE FROM invites WHERE code = ? RETURNING code", item).toArray();
      return gone.length > 0 ? json(200, { revoked: item }) : json(404, { error: "no such invite" });
    }
    if (rest.length === 0 && collection === "members" && !item && method === "GET") {
      return json(200, { members: this.sql.exec("SELECT pubkey, added_at, via FROM members ORDER BY added_at").toArray() });
    }
    if (rest.length === 0 && collection === "members" && item) {
      if (!isHex64(item)) return json(400, { error: "a member is a 64-character lowercase hex public key" });
      if (method === "PUT") {
        const added = this.sql
          .exec("INSERT INTO members (pubkey, added_at, via) VALUES (?, ?, 'admin') ON CONFLICT DO NOTHING RETURNING pubkey", item, now)
          .toArray();
        return json(200, { added: item, already_member: added.length === 0 });
      }
      if (method === "DELETE") {
        const removed = this.sql.exec("DELETE FROM members WHERE pubkey = ? RETURNING pubkey", item).toArray();
        this.evict(item);
        return json(200, { removed: item, was_member: removed.length > 0 });
      }
    }
    return json(404, { error: `no admin route for ${method} ${url.pathname}` });
  }
}
