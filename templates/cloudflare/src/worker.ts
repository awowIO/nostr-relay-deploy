// A private, invite-gated Nostr + Blossom relay for nostr-mailbox on Cloudflare Workers.
//
//   Worker          the edge filter: the same four public routes as the Caddyfile and the
//                   Traefik IngressRoute, 404 for everything else
//   Durable Object  one instance holds every socket, the event store and the member list
//                   in its SQLite storage (ctx.storage.sql)
//   R2              Blossom blobs, addressed by SHA-256 (binding BLOSSOM_BUCKET)
//
// The three gates of the ncli deployments hold here too:
//   1. auth_required        nothing is read or written before the NIP-42 AUTH answer
//   2. membership_required  an authenticated key that is not enrolled gets nothing
//   3. single-use invites   NIP-43 kind 28934 redeems an invite the admin API minted
//
// Membership is managed over /_admin/ with ADMIN_TOKEN (`wrangler secret put ADMIN_TOKEN`)
// by scripts/cf_ncli_shim.py, which speaks the `ncli relay ...` argv nostr-mailbox's
// `--exec` sends. Without ADMIN_TOKEN, /_admin/ answers 404 like any other path.

import {
  AUTH_KIND,
  BLOB_PATH,
  BLOSSOM_AUTH_KIND,
  INVITE_CLAIM_KIND,
  dTag,
  edgeRoute,
  eventError,
  expirationOf,
  isHex64,
  isProtected,
  kindClass,
  matchesFilter,
  parseFilter,
  randomHex,
  sha256,
  tagValue,
  tagValues,
  utf8,
  wireEvent,
} from "./nostr.ts";
import type { Filter, KindClass, NostrEvent } from "./nostr.ts";

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
}

// ------------------------------------------------------------------------ constants
const VERSION = "0.1.0";
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

interface Config {
  relayHost: string;
  relayName: string;
  eventsPerMinute: number;
  maxBlobBytes: number;
  maxUploadsPerSigner: number;
}

function positiveInt(env: Env, name: keyof Env): number {
  const raw = env[name];
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer in wrangler.toml [vars], got ${JSON.stringify(raw)}`);
  }
  return n;
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

function nip11(cfg: Config): Response {
  const document = {
    name: cfg.relayName,
    description: "Private, invite-gated Nostr + Blossom relay for nostr-mailbox.",
    supported_nips: [1, 11, 40, 42, 43, 70],
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
  return new Response(JSON.stringify(document), {
    headers: {
      "Content-Type": "application/nostr+json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET",
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
    const route = edgeRoute(request.method, url.pathname, request.headers);
    if (route === null) return notFound();
    if (route === "info") return nip11(readConfig(env));
    return relayStub(env).fetch(request);
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
];

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

function sameRelayUrl(value: string | null, host: string): boolean {
  if (value === null) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    if (err instanceof TypeError) return false; // not a URL at all: the tag is wrong
    throw err;
  }
  return (
    url.protocol === "wss:" &&
    url.hostname === host &&
    (url.port === "" || url.port === "443") &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === ""
  );
}

function decodeAuthorization(token: string): unknown {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export class RelayDurableObject {
  ctx: DurableObjectState;
  env: Env;
  sql: SqlStorage;
  cfg: Config;
  // In memory only, and that is enough: an upload holds the object awake while it runs,
  // and per-connection queues are empty whenever the object may hibernate.
  uploadsInFlight = new Map<string, number>();
  queues = new Map<string, Promise<void>>();

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
    switch (edgeRoute(request.method, url.pathname, request.headers)) {
      case "wire":
        return this.accept();
      case "upload":
        return this.upload(request);
      case "blob":
        return this.blob(request, url.pathname);
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
    if (attachmentOf(ws).pubkey === null) {
      return send(ws, ["OK", id, false, "auth-required: answer the AUTH challenge first"]);
    }
    const problem = await eventError(raw);
    if (problem !== null) return send(ws, ["OK", id, false, `invalid: ${problem}`]);
    const e = wireEvent(raw as NostrEvent);
    const me = attachmentOf(ws).pubkey as string;
    if (e.kind === AUTH_KIND) return send(ws, ["OK", id, false, "invalid: AUTH events go in an AUTH message"]);
    if (!this.takeToken(me)) {
      return send(ws, ["OK", id, false, `rate-limited: at most ${this.cfg.eventsPerMinute} events a minute per key`]);
    }
    if (e.kind === INVITE_CLAIM_KIND) return this.redeem(ws, e, me);
    if (!this.isMember(me)) return send(ws, ["OK", id, false, "restricted: this key is not a member of the relay"]);
    if (e.pubkey !== me) {
      if (isProtected(e)) {
        return send(ws, ["OK", id, false, "restricted: a protected event is accepted only from its author"]);
      }
      if (!this.isMember(e.pubkey)) {
        return send(ws, ["OK", id, false, "restricted: the event's author is not a member of the relay"]);
      }
    }
    const expiration = expirationOf(e);
    if (expiration === "invalid") return send(ws, ["OK", id, false, "invalid: the expiration tag is not a timestamp"]);
    if (expiration !== null && expiration <= nowS()) {
      return send(ws, ["OK", id, false, "invalid: the event has already expired"]);
    }
    const cls = kindClass(e.kind);
    if (cls === "ephemeral") {
      send(ws, ["OK", id, true, ""]);
      return this.broadcast(e);
    }
    const outcome = this.store(e, cls, expiration);
    if (outcome === "duplicate") return send(ws, ["OK", id, true, "duplicate: already have this event"]);
    if (outcome === "superseded") return send(ws, ["OK", id, true, "duplicate: a newer version is stored"]);
    send(ws, ["OK", id, true, ""]);
    this.broadcast(e);
  }

  redeem(ws: RelaySocket, e: NostrEvent, me: string): void {
    if (e.pubkey !== me) {
      return send(ws, ["OK", e.id, false, "restricted: an invite claim is accepted only from the key that authenticated"]);
    }
    const code = tagValue(e, "claim");
    if (code === null || code === "") return send(ws, ["OK", e.id, false, "invalid: the claim tag carries no invite code"]);
    if (this.isMember(me)) return send(ws, ["OK", e.id, true, "duplicate: already a member"]);
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
    if (!redeemed) return send(ws, ["OK", e.id, false, "restricted: the invite is unknown, spent or expired"]);
    send(ws, ["OK", e.id, true, ""]);
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

  onReq(ws: RelaySocket, subId: unknown, rawFilters: unknown[]): void {
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
    this.sql.exec(
      "INSERT INTO subscriptions (conn, sub_id, filters) VALUES (?, ?, ?) ON CONFLICT (conn, sub_id) DO UPDATE SET filters = excluded.filters",
      att.conn,
      subId,
      JSON.stringify(rawFilters),
    );
    const now = nowS();
    if (filters.length === 1) {
      for (const e of this.query(filters[0], now)) send(ws, ["EVENT", subId, e]);
    } else {
      const seen = new Map<string, NostrEvent>();
      for (const f of filters) for (const e of this.query(f, now)) seen.set(e.id, e);
      const events = [...seen.values()].sort(
        (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      for (const e of events) send(ws, ["EVENT", subId, e]);
    }
    send(ws, ["EOSE", subId]);
  }

  *query(f: Filter, now: number): Generator<NostrEvent> {
    const where = ["(expires_at IS NULL OR expires_at > ?)"];
    const binds: SqlValue[] = [now];
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
    const limit = f.limit === undefined || f.limit === 0 ? MAX_LIMIT : Math.min(f.limit, MAX_LIMIT);
    const rows = this.sql.exec<EventRow>(
      `SELECT id, pubkey, created_at, kind, tags, content, sig FROM events WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id ASC LIMIT ?`,
      ...binds,
      limit,
    );
    for (const row of rows) yield rowToEvent(row);
  }

  onClose(ws: RelaySocket, subId: unknown): void {
    if (typeof subId !== "string") return send(ws, ["NOTICE", "invalid: CLOSE names a subscription id"]);
    this.sql.exec("DELETE FROM subscriptions WHERE conn = ? AND sub_id = ?", attachmentOf(ws).conn, subId);
  }

  broadcast(e: NostrEvent): void {
    const membership = new Map<string, boolean>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachmentOf(ws);
      if (att.pubkey === null) continue;
      let member = membership.get(att.pubkey);
      if (member === undefined) {
        member = this.isMember(att.pubkey);
        membership.set(att.pubkey, member);
      }
      if (!member) continue;
      const subs = this.sql
        .exec<{ sub_id: string; filters: string }>("SELECT sub_id, filters FROM subscriptions WHERE conn = ?", att.conn)
        .toArray();
      for (const sub of subs) {
        const filters = (JSON.parse(sub.filters) as unknown[]).map(parseFilter) as Filter[];
        if (!filters.some((f) => matchesFilter(f, e))) continue;
        try {
          send(ws, ["EVENT", sub.sub_id, e]);
        } catch (err) {
          // One socket going away must not stop delivery to the others.
          console.warn(`relay: delivering ${e.id} to connection ${att.conn} failed`, err);
        }
      }
    }
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
