// nostr-mailbox's channel, spoken by the Worker on behalf of an nm1_ token, for the
// remote MCP server (mcp.ts). Everything here is nostr-mailbox's own wire format, read
// from its source (nostr_mailbox/cli.py, profile.py, backend.py, keyring.py, groups.py,
// giftwrap.py), so its CLI reads what this writes and this reads what its CLI writes:
//
//   token     nm1_ + base64url(JSON): a cf.transport/1 declaration, the relay invite
//             `code`, and for a topic its group code, redeem secret, keeper (`owner`),
//             role and epoch keys. It is a bearer secret, and the only credential here.
//   persona   a secp256k1 key derived from the token alone:
//             HMAC-SHA256(SHA-256(domain || token), "mcp-persona:" + name). Nothing about
//             it is stored: the same token derives the same key on every call.
//   admission the token's own persona ("default") redeems the token: the relay invite
//             (NIP-43 kind 28934) and, for a topic, the group code with its redeem proof
//             (9021), exactly as `nostr-mailbox join` does. Another persona of the same
//             token is introduced by that one: a member-minted invite (28935), then a
//             join request that waits for the topic's keeper (`topic approve <npub>`).
//   records   cf.campaign/1 JSON, sealed with NIP-44 v2 under the epoch key the event's
//             `epoch` tag names; kinds 8881-8891 and 38881-38883 (profile.Kind).
//   keys      the token's epochs, and any epoch a topic admin gift-wrapped (NIP-59,
//             rumor kind 8892) to the persona since: read from the relay on every call,
//             never kept here.
//
// Every event is signed by the persona and goes through RelayPort.publish, and every read
// through RelayPort.read: the gates of an authenticated socket, by the same code
// (worker.ts). Erasable TypeScript only, like nostr.ts.

import { campaignConversationKey, decrypt, encrypt, hmacSha256, Nip44Error, pairwiseConversationKey } from "./nip44.ts";
import {
  bytesToHex,
  eventError,
  hexToBytes,
  parseFilter,
  sameRelayUrl,
  secretKey,
  sha256,
  signEvent,
  signSchnorr,
  utf8,
} from "./nostr.ts";
import type { Filter, NostrEvent, SecretKey } from "./nostr.ts";

// ------------------------------------------------------------------------- errors
/** A call refused, before or instead of doing what it asked. The message is the answer. */
export class ToolError extends Error {}
/** Arguments that do not match a tool's input schema (JSON-RPC -32602, HTTP 400). */
export class InvalidArguments extends ToolError {}
/** No token, or one this relay does not honour (HTTP 401). */
export class Unauthorized extends ToolError {}
/** The relay said no: the reason a socket would have been given. */
export class RelayRefusal extends ToolError {
  reason: string;
  constructor(reason: string) {
    super(`the relay refused: ${reason}`);
    this.reason = reason;
  }
}
/** A record read from the relay that is not a well-formed record of this campaign. It is
 * skipped, and reported beside the answer as `rejected`, never silently. */
class RecordError extends Error {}

// --------------------------------------------------------------------- the relay port
/** What worker.ts's Durable Object lets this module do, for a key it signs for. */
export interface RelayPort {
  readonly host: string;
  readonly relayPubkey: string;
  /** An EVENT from a socket authenticated as `me`: [accepted, message] as OK says. */
  publish(e: NostrEvent, me: string): Promise<[boolean, string]>;
  /** A REQ's stored answer for `reader`, oldest first; RelayRefusal when it is closed. */
  read(reader: string, filters: unknown[]): NostrEvent[];
  /** A member-minted single-use invite code (NIP-43 kind 28935); RelayRefusal if not. */
  mintInviteCode(me: string): Promise<string>;
  isMember(pubkey: string): boolean;
  inviteOpen(code: string): boolean;
  groupStanding(group: string, pubkey: string): "member" | "pending" | "outside" | "absent";
  blobBytes(sha256: string): Promise<Uint8Array | null>;
  /** Armed at once: `arrived` resolves when an event matching `filter` is delivered, or
   * at `deadlineMs`; `cancel` disarms it. */
  waitFor(filter: Filter, deadlineMs: number): { arrived: Promise<void>; cancel(): void };
  takeToken(pubkey: string): boolean;
  openSession(id: string, tokenDigest: string, protocol: string): void;
  sessionToken(id: string): string | null;
  endSession(id: string): boolean;
}

// -------------------------------------------------------------------- nostr-mailbox's rules
export const BUS = "bus";
export const INBOX = "inbox";
export const DEFAULT_PERSONA = "default"; // identity.DEFAULT_NAME
const SCHEMA = "cf.campaign/1";
const TRUST_SCHEMA = "cf.transport/1";
const KEYRING_SCHEMA = "cf.keyring/1";
// profile.MAX_EVENT_BYTES: the campaign's cap on one complete serialized event.
export const MAX_EVENT_BYTES = 16_384;
// nostr-mailbox's MAX_FRAME_BYTES: one request carries at most one campaign event's worth
// of text, and JSON escaping can at most sextuple a byte, so 8 × the event cap bounds it.
// The MCP routes (mcp.ts) and the OAuth ones (oauth.ts), which carry one token, share it.
export const MAX_REQUEST_BYTES = 8 * MAX_EVENT_BYTES;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOPIC_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GROUP = /^[A-Za-z0-9_-]{1,64}$/;
const EPOCH = /^[1-9][0-9]{0,8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MESSAGE_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
export const KIND = {
  claim: 8881,
  decision: 8882,
  handoff: 8884,
  ack: 8888,
  seal: 8889,
  message: 8891,
  epochKeys: 8892,
  conditionHead: 38881,
  routeHead: 38882,
  checkpointHead: 38883,
} as const;
const INVITE_CLAIM_KIND = 28934;
const JOIN_REQUEST = 9021;
const CREATE_GROUP = 9007;
const SEAL_KIND = 13;
const GIFT_WRAP_KIND = 1059;
export const ROLES = ["read-write", "read-only", "write-only"] as const;
export const TERMINAL_DISPOSITIONS = ["handled", "ignored", "rejected"];
export const DISPOSITIONS = [...TERMINAL_DISPOSITIONS, "deferred"];
export const ROUTE_STATES = ["scouting", "active", "parked", "falsified", "closed"];
export const CLAIM_EFFECTS = ["closes", "narrows", "falsifies"];
export const DECISION_OUTCOMES = ["accepted", "narrowed", "rejected"];
const CONDITION_STATES = ["open", "closed"];
const KEYRING_MODES = ["create", "full_history", "forward_only", "rotate"];
// keyring.REDEEM_DOMAIN: a topic token's redeem proof binds its group code to one key.
const REDEEM_DOMAIN = "nostr-mailbox/topic-redeem/v1";
// Domain separation for what is derived from a token: its personas' secret, and the
// digest an MCP session is bound to (no token is ever stored).
const PERSONA_DOMAIN = "nostr-relay-deploy/mcp-persona/v1\x1f";
const SESSION_DOMAIN = "nostr-relay-deploy/mcp-session/v1\x1f";

const nowS = (): number => Math.floor(Date.now() / 1000);

export function slug(value: unknown, what: string): string {
  if (typeof value !== "string" || !SLUG.test(value)) throw new ToolError(`${what} ${JSON.stringify(value)} must match ${SLUG.source}`);
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await sha256(utf8(text)));
}

// ------------------------------------------------------------------- bech32 (NIP-19)
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  return [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & max) !== 0)) return null;
  return out;
}

export function npub(pubkey: string): string {
  const data = convertBits([...hexToBytes(pubkey)], 8, 5, true) as number[];
  const check = polymod([...hrpExpand("npub"), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const sum = [0, 1, 2, 3, 4, 5].map((i) => (check >> (5 * (5 - i))) & 31);
  return "npub1" + [...data, ...sum].map((v) => CHARSET[v]).join("");
}

/** 32 bytes from an `npub1…`/`nsec1…` string, or null when it is not one. */
function bech32Key(text: string, hrp: string): string | null {
  const s = text.toLowerCase();
  if (!s.startsWith(`${hrp}1`)) return null;
  const data: number[] = [];
  for (const c of s.slice(hrp.length + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return null;
    data.push(v);
  }
  if (data.length < 6 || polymod([...hrpExpand(hrp), ...data]) !== 1) return null;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  return bytes !== null && bytes.length === 32 ? bytesToHex(Uint8Array.from(bytes)) : null;
}

/** A public key given as npub or 64 hex (bech32.pubkey_hex). */
export function pubkeyHex(text: string, what: string): string {
  const lower = text.trim().toLowerCase();
  if (HEX64.test(lower)) return lower;
  const decoded = bech32Key(lower, "npub");
  if (decoded === null) throw new ToolError(`${what} is neither an npub nor a 64-hex public key`);
  return decoded;
}

// --------------------------------------------------------------- Python-compatible JSON
/** json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False): the
 * record envelope (profile.encode) and the token (cli._encode_invite_token). */
export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** json.dumps(value, sort_keys=True) with Python's defaults (", ", ": ", ensure_ascii): the
 * text nostr-mailbox digests into a post's idempotency key (cli._content_key). */
function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${pythonJson(k)}: ${pythonJson(v)}`).join(", ")}}`;
  }
  const text = JSON.stringify(value);
  return typeof value === "string" ? text.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) : text;
}

// --------------------------------------------------------------------------- trust
interface Url {
  scheme: string;
  host: string;
  path: string;
}

function checkedUrl(value: unknown, schemes: string[], what: string, originOnly: boolean): Url {
  if (typeof value !== "string") throw new ToolError(`${what} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    if (err instanceof TypeError) throw new ToolError(`${what} ${JSON.stringify(value)} is not a usable URL`);
    throw err;
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (!schemes.includes(scheme) || url.hostname === "") throw new ToolError(`${what} must be a ${schemes.join("/")} URL`);
  if (url.username !== "" || url.password !== "") throw new ToolError(`${what} must not carry credentials`);
  if (url.search !== "" || url.hash !== "") throw new ToolError(`${what} must not carry a query or a fragment`);
  if (originOnly && !["", "/"].includes(url.pathname)) throw new ToolError(`${what} must be an origin with no path`);
  return { scheme, host: url.host, path: url.pathname };
}

/** profile.Trust: what a campaign pins. Built from a token's declaration. */
export class Trust {
  relay: string;
  relayAuthUrl: string | null;
  campaign: string;
  operators: Set<string>;
  leadKeys: Set<string>;
  reviewerKeys: Set<string>;
  group: string | null;
  keyring: string | null;
  campaignKey: string | null;

  constructor(raw: Record<string, unknown>) {
    const unknown = Object.keys(raw).filter((k) => !TRUST_KEYS.has(k)).sort();
    if (unknown.length > 0) throw new ToolError(`the token declares unknown keys ${JSON.stringify(unknown)}`);
    if (raw.schema !== TRUST_SCHEMA) throw new ToolError(`the token's schema is not ${TRUST_SCHEMA}`);
    const missing = ["relay", "campaign", "operator_pubkeys"].filter((k) => !(k in raw));
    if (missing.length > 0) throw new ToolError(`the token's declaration is missing ${JSON.stringify(missing)}`);
    checkedUrl(raw.relay, ["ws", "wss"], "relay", false);
    this.relay = raw.relay as string;
    this.relayAuthUrl = null;
    if (raw.relay_auth_url !== undefined && raw.relay_auth_url !== null) {
      checkedUrl(raw.relay_auth_url, ["ws", "wss"], "relay_auth_url", false);
      this.relayAuthUrl = raw.relay_auth_url as string;
    }
    if (raw.blossom !== undefined && raw.blossom !== null) checkedUrl(raw.blossom, ["http", "https"], "blossom", true);
    this.campaign = slug(raw.campaign, "campaign");
    const roster = (name: string): Set<string> => {
      const keys = raw[name] ?? [];
      if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) {
        throw new ToolError(`${name} must be a list of npub or hex strings`);
      }
      return new Set(keys.map((k: string) => pubkeyHex(k, `a key of ${name}`)));
    };
    this.operators = roster("operator_pubkeys");
    if (this.operators.size === 0) throw new ToolError("operator_pubkeys is empty");
    this.leadKeys = roster("lead_pubkeys");
    this.reviewerKeys = roster("reviewer_pubkeys");
    const optional = (name: string, rule: RegExp): string | null => {
      const v = raw[name];
      if (v === undefined || v === null) return null;
      if (typeof v !== "string" || !rule.test(v)) throw new ToolError(`${name} ${JSON.stringify(v)} must match ${rule.source}`);
      return v;
    };
    this.group = optional("group", GROUP);
    this.keyring = optional("keyring", GROUP);
    let ck = raw.campaign_key;
    if (typeof ck === "string" && ck.startsWith("nsec1")) ck = bech32Key(ck, "nsec") ?? ck;
    if (typeof ck === "string") ck = ck.toLowerCase();
    if (ck !== undefined && ck !== null && (typeof ck !== "string" || !HEX64.test(ck))) {
      throw new ToolError("campaign_key must be 64 hex characters or an nsec1…");
    }
    this.campaignKey = (ck as string | undefined) ?? null;
    if (raw.allow_cleartext !== undefined && typeof raw.allow_cleartext !== "boolean") {
      throw new ToolError("allow_cleartext must be true or false");
    }
  }

  /** Route Board writers: every operator, and the declared leads. */
  get leads(): Set<string> {
    return new Set([...this.operators, ...this.leadKeys]);
  }

  /** Who may decide a claim: every operator, and the declared reviewers. */
  get reviewers(): Set<string> {
    return new Set([...this.operators, ...this.reviewerKeys]);
  }

  /** The `t` tag: the campaign for a typed record, `<campaign>:<topic>` for mailbox traffic. */
  route(topic: string | null): string {
    return topic === null ? this.campaign : `${this.campaign}:${slug(topic, "topic")}`;
  }

  address(name: string): string {
    const scoped = `${this.campaign}:${name}`;
    return this.group !== null ? `${this.group}:${scoped}` : scoped;
  }

  scope(topic: string | null): Record<string, string[]> {
    return { "#t": [this.route(topic)], ...(this.group !== null ? { "#h": [this.group] } : {}) };
  }
}

const TRUST_KEYS = new Set([
  "schema", "relay", "campaign", "operator_pubkeys", "group", "blossom", "lead_pubkeys",
  "reviewer_pubkeys", "allow_cleartext", "relay_auth_url", "campaign_key", "keyring",
]);
const TOKEN_EXTRAS = ["topic", "group_code", "redeem", "owner"];
const TOKEN_KEYS = ["epochs", "current"];

// --------------------------------------------------------------------------- token
export interface Token {
  text: string;
  code: string;
  member: string | null;
  declaration: Record<string, unknown>; // the cf.transport/1 keys, as the token carries them
  trust: Trust;
  topic: string | null;
  groupCode: string | null;
  redeem: string | null;
  owner: string | null;
  role: string;
  epochs: Map<number, string>;
}

function epochsOf(raw: unknown, what: string): Map<number, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new ToolError(`${what}: epochs must be a non-empty object of epoch → key`);
  }
  const out = new Map<number, string>();
  for (const [epoch, key] of Object.entries(raw as Record<string, unknown>)) {
    if (!EPOCH.test(epoch)) throw new ToolError(`${what}: an epoch is not a positive integer`);
    if (typeof key !== "string" || !HEX64.test(key)) throw new ToolError(`${what}: an epoch key is not 64 lowercase hex`);
    out.set(Number(epoch), key);
  }
  return out;
}

/** An nm1_ token, or a join link that carries one (cli._token_from_link), checked the way
 * `nostr-mailbox join` checks it (cli._decode_invite_token). */
export function readToken(given: string): Token {
  const text = tokenIn(given.trim());
  let data: unknown;
  try {
    const b64 = text.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof TypeError || err instanceof DOMException) {
      throw new ToolError("the nm1_ token is not base64url JSON");
    }
    throw err;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new ToolError("the nm1_ token holds no invite");
  const bundle = { ...(data as Record<string, unknown>) };
  const code = bundle.code;
  if (typeof code !== "string" || code === "") throw new ToolError("the nm1_ token is missing `code`");
  delete bundle.code;
  const member = typeof bundle.member === "string" && bundle.member !== "" ? bundle.member : null;
  delete bundle.member;
  delete bundle.expires_at;
  const extra: Record<string, unknown> = {};
  for (const name of [...TOKEN_EXTRAS, ...TOKEN_KEYS, "role"]) {
    if (name in bundle) {
      extra[name] = bundle[name];
      delete bundle[name];
    }
  }
  const trust = new Trust(bundle);
  const token: Token = {
    text, code, member, declaration: bundle, trust, topic: null, groupCode: null, redeem: null, owner: null,
    role: "read-write", epochs: new Map(),
  };
  if (Object.keys(extra).length === 0) return token;
  const role = extra.role ?? "read-write";
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
    throw new ToolError(`the nm1_ topic token names a role that is not one of ${ROLES.join(", ")}`);
  }
  const wanted = role === "write-only" ? TOKEN_EXTRAS : [...TOKEN_EXTRAS, ...TOKEN_KEYS];
  const carried = Object.keys(extra).filter((k) => k !== "role").sort();
  if (carried.join() !== [...wanted].sort().join() || bundle.keyring !== extra.topic) {
    throw new ToolError(`an nm1_ topic token for a ${role} member carries exactly ${JSON.stringify([...wanted].sort())} and names its topic as its keyring`);
  }
  if (typeof extra.topic !== "string" || !TOPIC_ID.test(extra.topic)) throw new ToolError("the nm1_ topic token names no topic id");
  if (typeof extra.owner !== "string" || !HEX64.test(extra.owner)) throw new ToolError("the nm1_ topic token does not name the inviter's key");
  if (typeof extra.redeem !== "string" || !HEX64.test(extra.redeem)) throw new ToolError("the nm1_ topic token carries no redeem secret");
  if (typeof extra.group_code !== "string" || extra.group_code === "") throw new ToolError("the nm1_ topic token carries no group code");
  return {
    ...token, topic: extra.topic, groupCode: extra.group_code, redeem: extra.redeem, owner: extra.owner, role,
    epochs: role === "write-only" ? new Map() : epochsOf(extra.epochs, "the nm1_ token"),
  };
}

/** The nm1_ token in `given`: the token itself, or what a link carries in its fragment
 * (…/join/#nm1_…, …#join=nm1_…) or path. */
function tokenIn(given: string): string {
  if (given.startsWith("nm1_")) {
    if (!/^nm1_[A-Za-z0-9_-]+$/.test(given)) throw new ToolError("the nm1_ token holds characters base64url does not use");
    return given;
  }
  if (/^https?:\/\//.test(given)) {
    let url: URL;
    try {
      url = new URL(given);
    } catch (err) {
      if (err instanceof TypeError) throw new ToolError("the join link is not a URL");
      throw err;
    }
    const pieces = [...url.hash.replace(/^#/, "").split("&"), ...url.pathname.split("/").reverse()];
    for (const piece of pieces) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(piece);
      } catch (err) {
        if (err instanceof URIError) throw new ToolError("the join link holds a malformed %-escape");
        throw err;
      }
      const value = decoded.split("=").pop() ?? "";
      if (value.startsWith("nm1_")) return tokenIn(value);
    }
    throw new ToolError("the join link carries no nm1_ token (expected …/join/#nm1_…)");
  }
  throw new ToolError("give an nm1_ token, or a …/join/#nm1_… link");
}

// ------------------------------------------------------------------------- persona
export interface Persona {
  name: string;
  key: SecretKey;
  pubkey: string;
  npub: string;
}

/** The persona `name` of `token`: HMAC-SHA256(token secret, "mcp-persona:" + name), where
 * the token secret is SHA-256(domain || token). A digest that is no secp256k1 scalar (odds
 * about 1 in 2^128) is refused, never wrapped into one. */
export async function derivePersona(token: Token, name: string): Promise<Persona> {
  if (!SLUG.test(name)) throw new InvalidArguments(`persona ${JSON.stringify(name)} must match ${SLUG.source}: it is also its seat`);
  const secret = await sha256(utf8(PERSONA_DOMAIN + token.text));
  const key = secretKey(bytesToHex(await hmacSha256(secret, utf8(`mcp-persona:${name}`))));
  return { name, key, pubkey: key.pubkey, npub: npub(key.pubkey) };
}

/** keyring.redeem_proof: what a token holder signs to claim the token's place for its key. */
async function redeemProof(code: string, pubkey: string, redeemSecret: string): Promise<string> {
  const message = await sha256(new Uint8Array([...utf8(REDEEM_DOMAIN), ...hexToBytes(await sha256Hex(code)), ...hexToBytes(pubkey)]));
  return bytesToHex(await signSchnorr(message, secretKey(redeemSecret), crypto.getRandomValues(new Uint8Array(32))));
}

/** The token's own name for the relay (relay_auth_url, else relay), when it is this one. */
export function namesThisRelay(token: Token, host: string): boolean {
  return sameRelayUrl(token.trust.relayAuthUrl ?? token.trust.relay, host);
}

// ------------------------------------------------------------------- the epoch ring
class Ring {
  campaign: string;
  epochs: Map<number, string>;
  keys = new Map<number, Uint8Array>();

  constructor(campaign: string, epochs: Map<number, string>) {
    this.campaign = campaign;
    this.epochs = epochs;
  }

  get current(): number {
    return Math.max(...this.epochs.keys());
  }

  /** Held epochs, newest first: the order a reader tries them in. */
  held(): number[] {
    return [...this.epochs.keys()].sort((a, b) => b - a);
  }

  async key(epoch: number): Promise<Uint8Array> {
    const hex = this.epochs.get(epoch);
    if (hex === undefined) {
      throw new RecordError(`no key for epoch ${epoch} on this persona (it holds ${JSON.stringify(this.held().reverse())})`);
    }
    let key = this.keys.get(epoch);
    if (key === undefined) {
      key = await campaignConversationKey(hexToBytes(hex), this.campaign);
      this.keys.set(epoch, key);
    }
    return key;
  }
}

// ------------------------------------------------------------------- the records
type FieldType = "str" | "int" | "list";
type Payload = Record<string, unknown>;

/** profile.fields: exactly the declared keys, each of its declared type. */
function fields(payload: Payload, required: Record<string, FieldType>, optional: Record<string, FieldType>): Payload {
  const unknown = Object.keys(payload).filter((k) => !(k in required) && !(k in optional)).sort();
  if (unknown.length > 0) throw new RecordError(`unexpected fields ${JSON.stringify(unknown)}`);
  const out: Payload = {};
  for (const name of Object.keys(required)) {
    if (!(name in payload)) throw new RecordError(`missing field '${name}'`);
    out[name] = payload[name];
  }
  for (const name of Object.keys(optional)) if (payload[name] !== undefined && payload[name] !== null) out[name] = payload[name];
  for (const [name, value] of Object.entries(out)) {
    const kind = required[name] ?? optional[name];
    const ok = kind === "str" ? typeof value === "string"
      : kind === "int" ? typeof value === "number" && Number.isInteger(value)
      : Array.isArray(value) && value.every((v) => typeof v === "string");
    if (!ok) throw new RecordError(`field '${name}' must be ${kind === "list" ? "a list of strings" : kind}`);
  }
  return out;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`${what} is empty`);
  return value;
}

function line(value: unknown, what: string): string {
  if (text(value, what).includes("\n")) throw new ToolError(`${what} must be a single line`);
  return value as string;
}

function digest(value: unknown, what: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) throw new ToolError(`${what} must be a sha256 in lowercase hex`);
  return value;
}

/** A record's parse, where a shape error is the record's fault: rejected, not raised. */
function record<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    if (err instanceof ToolError) throw new RecordError(err.message);
    throw err;
  }
}

function supersedes(a: NostrEvent, b: NostrEvent): boolean {
  return a.created_at > b.created_at || (a.created_at === b.created_at && b.id > a.id);
}

function newest<T>(rows: [NostrEvent, T][]): [NostrEvent, T] | null {
  let best: [NostrEvent, T] | null = null;
  for (const row of rows) if (best === null || supersedes(row[0], best[0])) best = row;
  return best;
}

function values(e: NostrEvent, name: string): string[] {
  return e.tags.filter((t) => t[0] === name && t.length > 1).map((t) => t[1]);
}

// profile.Route, Condition, Claim, Decision, Handoff, Checkpoint: checked as they are built.
export interface Route {
  route: string; state: string; hypothesis: string; falsification_criterion: string;
  origin: string; evidence: string[]; obstruction: string; reopen_trigger: string;
}

export function route(p: Payload): Route {
  slug(p.route, "route");
  if (!ROUTE_STATES.includes(p.state as string)) throw new ToolError(`route state ${JSON.stringify(p.state)} must be one of ${ROUTE_STATES.join(", ")}`);
  text(p.hypothesis, "route hypothesis");
  text(p.falsification_criterion, "route falsification_criterion");
  return {
    route: p.route as string, state: p.state as string, hypothesis: p.hypothesis as string,
    falsification_criterion: p.falsification_criterion as string, origin: (p.origin as string) ?? "",
    evidence: [...((p.evidence as string[]) ?? [])], obstruction: (p.obstruction as string) ?? "",
    reopen_trigger: (p.reopen_trigger as string) ?? "",
  };
}

const routeFields = (p: Payload): Route => route(fields(p, { route: "str", state: "str", hypothesis: "str", falsification_criterion: "str" },
  { origin: "str", evidence: "list", obstruction: "str", reopen_trigger: "str" }));

export interface Condition {
  condition: string; rev: number; state: string; goal: string; statement: string; next_action: string;
  evidence: string[]; rejected_routes: string[]; last_decision: string; last_claim: string;
}

export function condition(p: Payload): Condition {
  slug(p.condition, "condition");
  if (typeof p.rev !== "number" || !Number.isInteger(p.rev) || p.rev < 1) throw new ToolError("condition rev is an integer from 1");
  if (!CONDITION_STATES.includes(p.state as string)) throw new ToolError(`condition state ${JSON.stringify(p.state)} must be one of open, closed`);
  text(p.goal, "condition goal");
  text(p.statement, "condition statement");
  text(p.next_action, "condition next_action");
  const evidence = [...((p.evidence as string[]) ?? [])];
  const rejected = [...((p.rejected_routes as string[]) ?? [])];
  for (const item of [...evidence, ...rejected]) line(item, "condition evidence or rejected route");
  for (const name of ["last_decision", "last_claim"]) if (p[name]) digest(p[name], `condition ${name}`);
  return {
    condition: p.condition as string, rev: p.rev, state: p.state as string, goal: p.goal as string,
    statement: p.statement as string, next_action: p.next_action as string, evidence, rejected_routes: rejected,
    last_decision: (p.last_decision as string) ?? "", last_claim: (p.last_claim as string) ?? "",
  };
}

const conditionFields = (p: Payload): Condition => condition(fields(p,
  { condition: "str", rev: "int", state: "str", goal: "str", statement: "str", next_action: "str" },
  { evidence: "list", rejected_routes: "list", last_decision: "str", last_claim: "str" }));

export interface Claim {
  condition: string; condition_rev: number; effect: string; candidate_digest: string;
  evidence_refs: string[]; wave: string; task: string;
}

export function claim(p: Payload): Claim {
  slug(p.condition, "claim condition");
  if (typeof p.condition_rev !== "number" || !Number.isInteger(p.condition_rev) || p.condition_rev < 1) {
    throw new ToolError("claim condition_rev is the condition revision it was made against, an integer from 1");
  }
  if (!CLAIM_EFFECTS.includes(p.effect as string)) throw new ToolError(`claim effect ${JSON.stringify(p.effect)} must be one of ${CLAIM_EFFECTS.join(", ")}`);
  digest(p.candidate_digest, "claim candidate_digest");
  const refs = [...((p.evidence_refs as string[]) ?? [])];
  if (refs.length === 0) throw new ToolError("a claim needs at least one evidence reference to review");
  for (const ref of refs) line(ref, "claim evidence reference");
  return {
    condition: p.condition as string, condition_rev: p.condition_rev, effect: p.effect as string,
    candidate_digest: p.candidate_digest as string, evidence_refs: refs, wave: (p.wave as string) ?? "",
    task: (p.task as string) ?? "",
  };
}

const claimFields = (p: Payload): Claim => claim(fields(p,
  { condition: "str", condition_rev: "int", effect: "str", candidate_digest: "str", evidence_refs: "list" },
  { wave: "str", task: "str" }));

export interface Decision {
  claim: string; condition: string; condition_rev: number; outcome: string; reason: string;
  next_action: string; candidate_digest: string; statement: string; reopen_if: string;
}

function decision(p: Payload): Decision {
  digest(p.claim, "decision claim id");
  slug(p.condition, "decision condition");
  if (typeof p.condition_rev !== "number" || !Number.isInteger(p.condition_rev) || p.condition_rev < 1) {
    throw new ToolError("decision condition_rev is an integer from 1");
  }
  if (!DECISION_OUTCOMES.includes(p.outcome as string)) {
    throw new ToolError(`decision outcome ${JSON.stringify(p.outcome)} must be one of ${DECISION_OUTCOMES.join(", ")}`);
  }
  line(p.reason, "decision reason");
  text(p.next_action, "decision next_action");
  digest(p.candidate_digest, "decision candidate_digest");
  if (p.outcome === "narrowed") text(p.statement, "the narrowed condition statement");
  if (p.outcome === "rejected") line(p.reopen_if, "the reopening condition of a rejected claim");
  return {
    claim: p.claim as string, condition: p.condition as string, condition_rev: p.condition_rev,
    outcome: p.outcome as string, reason: p.reason as string, next_action: p.next_action as string,
    candidate_digest: p.candidate_digest as string, statement: (p.statement as string) ?? "",
    reopen_if: (p.reopen_if as string) ?? "",
  };
}

const decisionFields = (p: Payload): Decision => decision(fields(p,
  { claim: "str", condition: "str", condition_rev: "int", outcome: "str", reason: "str", next_action: "str", candidate_digest: "str" },
  { statement: "str", reopen_if: "str" }));

const HANDOFF_FIELDS: [keyof Handoff, string][] = [
  ["original_goal", "Original goal"],
  ["open_condition", "Open condition"],
  ["evidence_and_rejected_routes", "Evidence & rejected routes"],
  ["next_action", "Next action"],
];

export interface Handoff {
  original_goal: string; open_condition: string; evidence_and_rejected_routes: string; next_action: string;
}

export function handoff(p: Payload): Handoff {
  const headings = new Set(HANDOFF_FIELDS.map(([, label]) => `## ${label}`));
  for (const [key, label] of HANDOFF_FIELDS) {
    const value = text(p[key], `handoff field '${label}'`);
    const clash = value.split(/\r?\n/).find((l) => headings.has(l.trim()) || l.startsWith("<!--"));
    if (clash !== undefined) {
      throw new ToolError(`handoff field '${label}' carries a line that reads as a field heading or a provenance line: ${JSON.stringify(clash)}`);
    }
  }
  return {
    original_goal: p.original_goal as string, open_condition: p.open_condition as string,
    evidence_and_rejected_routes: p.evidence_and_rejected_routes as string, next_action: p.next_action as string,
  };
}

export interface Checkpoint {
  seat: string; seq: number; sha256: string; task: string; parent_sha256: string;
  feed_sha256: string; attempt: number; note: string;
}

export function checkpoint(p: Payload): Checkpoint {
  slug(p.seat, "seat");
  const attempt = p.attempt ?? 1;
  if (typeof p.seq !== "number" || !Number.isInteger(p.seq) || typeof attempt !== "number" || !Number.isInteger(attempt)) {
    throw new ToolError("checkpoint seq and attempt are integers");
  }
  if (p.seq < 0 || attempt < 1) throw new ToolError("checkpoint seq must be ≥ 0 and attempt ≥ 1");
  digest(p.sha256, "checkpoint sha256");
  for (const name of ["parent_sha256", "feed_sha256"]) if (p[name]) digest(p[name], `checkpoint ${name}`);
  return {
    seat: p.seat as string, seq: p.seq, sha256: p.sha256 as string, task: (p.task as string) ?? "",
    parent_sha256: (p.parent_sha256 as string) ?? "", feed_sha256: (p.feed_sha256 as string) ?? "",
    attempt, note: (p.note as string) ?? "",
  };
}

const checkpointFields = (p: Payload): Checkpoint => checkpoint(fields(p, { seat: "str", seq: "int", sha256: "str" },
  { task: "str", parent_sha256: "str", feed_sha256: "str", attempt: "int", note: "str" }));

/** Condition.after: the condition once `ruling` on `made` is applied. */
function conditionAfter(held: Condition, made: Claim, ruling: Decision, rulingId: string): Condition {
  let { evidence, rejected_routes: rejected, state } = held;
  if (ruling.outcome === "rejected") {
    rejected = [...rejected, `${made.effect} via ${made.candidate_digest.slice(0, 12)}…: ${ruling.reason} (reopen if: ${ruling.reopen_if})`];
  } else {
    evidence = [...new Set([...evidence, ...made.evidence_refs])];
    if (ruling.outcome === "accepted" && (made.effect === "closes" || made.effect === "falsifies")) state = "closed";
  }
  return {
    condition: held.condition, rev: held.rev + 1, state, goal: held.goal, statement: ruling.statement || held.statement,
    next_action: ruling.next_action, evidence, rejected_routes: rejected, last_decision: rulingId, last_claim: ruling.claim,
  };
}

/** One mailbox message as the transport reads it (backend.Message.to_dict). */
export interface Message {
  id: string; topic: string; author: string; created_at: number; kind: string; subject: string;
  body: string; refs: string[]; reply_to: string | null; key: string;
}

/** backend.Receipt.to_dict: what a write came to, against the campaign event cap. */
function receipt(topic: string, id: string, bytesUsed: number, extra: Partial<Record<string, unknown>> = {}): Payload {
  return {
    backend: "nostr-relay", topic, id, accepted: true, duplicate: false, detail: "", bytes_used: bytesUsed,
    bytes_cap: MAX_EVENT_BYTES, disposition: null, result_ref: null, ...extra,
    bytes_used_pct: Math.round((1000 * bytesUsed) / MAX_EVENT_BYTES) / 10,
  };
}

function wireBytes(e: NostrEvent): number {
  return utf8(JSON.stringify(e)).length;
}

// ------------------------------------------------------------------------ a channel
/** One call's session: one token, one persona, one campaign. `rejected` collects every
 * record read from the relay that was not a well-formed record of this campaign. */
export class Channel {
  relay: RelayPort;
  token: Token;
  persona: Persona;
  trust: Trust;
  rejected: { id: string; reason: string }[] = [];
  ring: Ring | null = null;
  ringProblem: string | null = null;

  constructor(relay: RelayPort, token: Token, persona: Persona) {
    this.relay = relay;
    this.token = token;
    this.persona = persona;
    this.trust = token.trust;
  }

  get me(): string {
    return this.persona.pubkey;
  }

  /** The keys records are written and read with (Trust.ring): the topic's epochs (the
   * token's, and those delivered to this persona since), else campaign_key as epoch 1,
   * else none, a plaintext campaign. */
  async load(): Promise<Channel> {
    const { keyring, campaignKey, campaign } = this.trust;
    if (keyring !== null) {
      const epochs = new Map(this.token.epochs);
      await this.syncDeliveries(epochs);
      if (campaignKey !== null && (epochs.get(1) ?? campaignKey) !== campaignKey) {
        throw new ToolError("the persona's epoch 1 is not this campaign's declared campaign_key");
      }
      if (campaignKey !== null) epochs.set(1, campaignKey);
      if (epochs.size > 0) this.ring = new Ring(campaign, epochs);
      else {
        this.ringProblem = `campaign ${campaign} is encrypted with epoch keyring ${keyring}, and persona ` +
          `${this.persona.name} holds no key of it: a write-only token carries none, and none was delivered to it. ` +
          "A write-only member writes sealed mail to the topic's keeper with the nostr-mailbox CLI, which this edge does not offer";
      }
    } else if (campaignKey !== null) {
      this.ring = new Ring(campaign, new Map([[1, campaignKey]]));
    }
    return this;
  }

  requireRing(): Ring | null {
    if (this.ringProblem !== null) throw new ToolError(this.ringProblem);
    return this.ring;
  }

  // ------------------------------------------------- epoch keys delivered (NIP-59)
  async syncDeliveries(epochs: Map<number, string>): Promise<void> {
    if (!this.relay.isMember(this.me)) return; // nothing is readable before admission
    let admins: Set<string> | null = null;
    for (const wrap of this.relay.read(this.me, [{ kinds: [GIFT_WRAP_KIND], "#p": [this.me] }])) {
      let rumor: { author: string; kind: number; tags: string[][]; content: string };
      try {
        rumor = await this.unwrap(wrap);
      } catch (err) {
        if (!(err instanceof RecordError)) throw err;
        this.rejected.push({ id: wrap.id, reason: `epoch keys: ${err.message}` });
        continue;
      }
      if (rumor.kind !== KIND.epochKeys) continue; // a gift wrap for another purpose
      let body: { topic: string; campaign: string; epochs: Map<number, string> };
      try {
        body = parseDelivery(rumor);
      } catch (err) {
        if (!(err instanceof RecordError || err instanceof ToolError)) throw err;
        this.rejected.push({ id: wrap.id, reason: `epoch keys: ${err.message}` });
        continue;
      }
      if (body.topic !== this.trust.keyring || body.campaign !== this.trust.campaign) continue;
      if (rumor.author !== this.me) {
        admins ??= this.topicAdmins();
        if (!admins.has(rumor.author)) {
          this.rejected.push({ id: wrap.id, reason: `epoch keys: from ${rumor.author.slice(0, 12)}…, which is not an admin of this topic; not merged` });
          continue;
        }
      }
      const clash = [...body.epochs].filter(([e, key]) => (epochs.get(e) ?? key) !== key).map(([e]) => e);
      if (clash.length > 0) {
        this.rejected.push({ id: wrap.id, reason: `epoch keys: a different key for epoch(s) ${JSON.stringify(clash)} than the one held; nothing was merged` });
        continue;
      }
      for (const [e, key] of body.epochs) epochs.set(e, key);
    }
  }

  /** groups.Topic.admins, and the token's inviter (keyring authorities): who may deliver. */
  topicAdmins(): Set<string> {
    const admins = new Set([...this.trust.operators, ...(this.token.owner !== null ? [this.token.owner] : [])]);
    const group = this.trust.keyring as string;
    if (this.relay.groupStanding(group, this.me) === "member") {
      const made = this.relay.read(this.me, [{ kinds: [CREATE_GROUP], "#h": [group] }])[0];
      if (made !== undefined) admins.add(made.pubkey);
    }
    return admins;
  }

  /** giftwrap.unwrap: the rumor in a kind 1059 addressed to this persona alone. */
  async unwrap(wrap: NostrEvent): Promise<{ author: string; kind: number; tags: string[][]; content: string }> {
    if (JSON.stringify(values(wrap, "p")) !== JSON.stringify([this.me])) throw new RecordError("this gift wrap is not addressed to this key alone");
    const open = async (payload: string, pubkey: string, what: string): Promise<unknown> => {
      try {
        return JSON.parse(await decrypt(payload, await pairwiseConversationKey(this.persona.key, pubkey)));
      } catch (err) {
        if (err instanceof Nip44Error) throw new RecordError(`the ${what} does not decrypt for this key: ${err.message}`);
        if (err instanceof SyntaxError) throw new RecordError(`the ${what} decrypted to something that is not JSON`);
        throw err;
      }
    };
    const seal = await open(wrap.content, wrap.pubkey, "gift wrap");
    if ((await eventError(seal)) !== null) throw new RecordError("the seal inside is not a validly signed event");
    const s = seal as NostrEvent;
    if (s.kind !== SEAL_KIND || s.tags.length > 0) throw new RecordError("the inner event is not a NIP-59 seal (kind 13, no tags)");
    const rumor = await open(s.content, s.pubkey, "seal");
    const keys = ["content", "created_at", "id", "kind", "pubkey", "tags"];
    if (rumor === null || typeof rumor !== "object" || Object.keys(rumor).sort().join() !== keys.join()) {
      throw new RecordError("the rumor is not an unsigned event (id, pubkey, created_at, kind, tags, content)");
    }
    const r = rumor as Record<string, unknown>;
    if (r.pubkey !== s.pubkey) throw new RecordError("the rumor names another author than the seal's signer: refused as an impersonation");
    const typed = Number.isInteger(r.kind) && Number.isInteger(r.created_at) && typeof r.content === "string" &&
      Array.isArray(r.tags) && r.tags.every((t) => Array.isArray(t) && t.length > 0 && t.every((v) => typeof v === "string"));
    const serial = JSON.stringify([0, r.pubkey, r.created_at, r.kind, r.tags, r.content]);
    if (!typed || (await sha256Hex(serial)) !== r.id) throw new RecordError("the rumor's id is not the hash of its fields, or a field has the wrong type");
    return { author: s.pubkey, kind: r.kind as number, tags: r.tags as string[][], content: r.content as string };
  }

  // ----------------------------------------------------------------- records
  tags(topic: string | null): string[][] {
    const tags = [["t", this.trust.route(topic)]];
    if (this.trust.group !== null) tags.push(["h", this.trust.group]);
    const ring = this.requireRing();
    if (ring !== null) tags.push(["epoch", String(ring.current)]);
    return tags;
  }

  /** profile.encode: the record's JSON, sealed under the current epoch when encrypted. */
  async encode(recordType: string, payload: Payload): Promise<string> {
    const raw = sortedJson({ ...payload, schema: SCHEMA, type: recordType, campaign: this.trust.campaign });
    const ring = this.requireRing();
    return ring === null ? raw : encrypt(raw, await ring.key(ring.current));
  }

  async sign(kind: number, recordType: string, payload: Payload, topic: string | null, tags: string[][] = [], createdAt?: number): Promise<NostrEvent> {
    const content = await this.encode(recordType, payload);
    return signEvent(this.persona.key, kind, [...this.tags(topic), ...tags], content, createdAt ?? nowS());
  }

  async publishRecord(e: NostrEvent, recordType: string): Promise<NostrEvent> {
    const size = wireBytes(e);
    if (size > MAX_EVENT_BYTES) {
      throw new ToolError(`this ${recordType} is ${size.toLocaleString("en")} bytes, ${Math.round((100 * size) / MAX_EVENT_BYTES)}% ` +
        `of the ${MAX_EVENT_BYTES.toLocaleString("en")}-byte campaign event cap; nothing was sent. Upload the body as a blob and send its sha256`);
    }
    const [ok, said] = await this.relay.publish(e, this.me);
    if (!ok) throw new RelayRefusal(said);
    return e;
  }

  async publish(kind: number, recordType: string, payload: Payload, topic: string | null, tags: string[][] = []): Promise<NostrEvent> {
    return this.publishRecord(await this.sign(kind, recordType, payload, topic, tags), recordType);
  }

  /** profile.decode behind profile.admit: the cap, the envelope, then the record's own parse. */
  async admit<T>(e: NostrEvent, kind: number, recordType: string, topic: string | null,
    parse: (e: NostrEvent, p: Payload) => T | Promise<T>): Promise<T> {
    const size = wireBytes(e);
    if (size > MAX_EVENT_BYTES) throw new RecordError(`${size} bytes is over the ${MAX_EVENT_BYTES}-byte campaign event cap`);
    if (e.kind !== kind) throw new RecordError(`kind ${e.kind} is not a ${recordType} (${kind})`);
    if (JSON.stringify(values(e, "t")) !== JSON.stringify([this.trust.route(topic)])) {
      throw new RecordError(`routing tag ${JSON.stringify(values(e, "t"))} is not exactly [${JSON.stringify(this.trust.route(topic))}]`);
    }
    if (JSON.stringify(values(e, "h")) !== JSON.stringify(this.trust.group !== null ? [this.trust.group] : [])) {
      throw new RecordError(`group tag ${JSON.stringify(values(e, "h"))} does not match the campaign's`);
    }
    const ring = this.requireRing();
    const raw = ring === null ? e.content : await decryptRecord(e, ring);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      if (err instanceof SyntaxError) throw new RecordError(`content is not JSON: ${err.message}`);
      throw err;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new RecordError("content is not a JSON object");
    const payload = { ...(body as Payload) };
    for (const [name, wanted] of [["schema", SCHEMA], ["type", recordType], ["campaign", this.trust.campaign]]) {
      if (payload[name] !== wanted) throw new RecordError(`content ${name} is not '${wanted}'`);
      delete payload[name];
    }
    return await parse(e, payload);
  }

  /** Every stored record of one type, oldest first, admitted and parsed. */
  async records<T>(kind: number, recordType: string, parse: (e: NostrEvent, p: Payload) => T | Promise<T>, topic: string | null,
    where: Record<string, unknown> = {}): Promise<[NostrEvent, T][]> {
    const filter = { kinds: [kind], ...this.trust.scope(topic), ...where };
    const out: [NostrEvent, T][] = [];
    for (const e of this.relay.read(this.me, [filter])) {
      try {
        out.push([e, await this.admit(e, kind, recordType, topic, parse)]);
      } catch (err) {
        if (!(err instanceof RecordError)) throw err;
        this.rejected.push({ id: e.id, reason: `${recordType}: ${err.message}` });
      }
    }
    return out;
  }

  withRejected(result: Payload): Payload {
    if (this.rejected.length > 0) result.rejected = this.rejected;
    return result;
  }

  // ------------------------------------------------------------- the mailbox (bus)
  async keyTag(topic: string, key: string): Promise<string> {
    return sha256Hex([this.trust.campaign, topic, key].join("\x1f"));
  }

  parseMessage(topic: string): (e: NostrEvent, p: Payload) => Promise<Message> {
    return async (e, p) => {
      const got = fields(p, { body: "str", kind: "str", key: "str" }, { subject: "str", refs: "list", reply_to: "str" });
      if (got.key === "") throw new RecordError("empty idempotency key");
      if (JSON.stringify(values(e, "i")) !== JSON.stringify([await this.keyTag(topic, got.key as string)])) {
        throw new RecordError("i tag is not the digest of the message's own key");
      }
      const reply = (got.reply_to as string | undefined) ?? null;
      if (JSON.stringify(values(e, "e")) !== JSON.stringify(reply ? [reply] : [])) throw new RecordError("e tag does not match reply_to");
      record(() => checkMessage(got.body, got.kind, reply));
      return {
        id: e.id, topic, author: e.pubkey, created_at: e.created_at, kind: got.kind as string,
        subject: (got.subject as string) ?? "", body: got.body as string, refs: [...((got.refs as string[]) ?? [])],
        reply_to: reply, key: got.key as string,
      };
    };
  }

  messages(topic: string, where: Record<string, unknown> = {}): Promise<[NostrEvent, Message][]> {
    return this.records(KIND.message, "message", this.parseMessage(topic), topic, where);
  }

  async seal(topic: string): Promise<[NostrEvent, string[]] | null> {
    const rows = await this.records(KIND.seal, "seal", (_e, p) => {
      if (p.topic !== topic) throw new RecordError("seals another topic");
      return fields(p, { topic: "str", count: "int", manifest_sha256: "str" }, { ids: "list" });
    }, topic, { authors: [...this.trust.operators].sort() });
    for (const [e, got] of rows) {
      let ids = got.ids as string[] | undefined;
      if (ids === undefined) {
        const bytes = await this.relay.blobBytes(got.manifest_sha256 as string);
        if (bytes === null || bytesToHex(await sha256(bytes)) !== got.manifest_sha256) {
          this.rejected.push({ id: e.id, reason: "seal: its manifest blob is not on this relay" });
          continue;
        }
        ids = new TextDecoder().decode(bytes).split("\n").filter((i) => i !== "");
      }
      if (ids.length !== got.count || new Set(ids).size !== ids.length || !ids.every((i) => HEX64.test(i)) ||
        (await sha256Hex(ids.join("\n"))) !== got.manifest_sha256) {
        this.rejected.push({ id: e.id, reason: "seal: seal manifest does not match its own count and digest" });
        continue;
      }
      return [e, ids];
    }
    return null;
  }

  /** backend._read: one canonical message per (author, key), in journal order; on a sealed
   * topic exactly the ids its seal lists. */
  async journal(topic: string): Promise<{ messages: Message[]; alias: Map<string, string>; sealed: boolean }> {
    const seal = await this.seal(topic);
    const physical = new Map<string, Message>();
    const first = new Map<string, Message>();
    const alias = new Map<string, string>();
    for (const [, m] of await this.messages(topic)) {
      physical.set(m.id, m);
      const slot = `${m.author}\x1f${m.key}`;
      if (!first.has(slot)) first.set(slot, m);
      alias.set(m.id, (first.get(slot) as Message).id);
    }
    const linked = (m: Message): Message => {
      const target = m.reply_to === null ? null : alias.get(m.reply_to) ?? m.reply_to;
      return target === m.reply_to ? m : { ...m, reply_to: target };
    };
    if (seal === null) return { messages: [...first.values()].map(linked), alias, sealed: false };
    const missing = seal[1].filter((id) => !physical.has(id));
    if (missing.length > 0) {
      throw new ToolError(`topic ${topic} was sealed with ${seal[1].length} message(s) and ${missing.length} of them are no longer ` +
        `on the relay (first: ${missing[0].slice(0, 12)}…). A sealed journal is not served with holes in it`);
    }
    const listed = new Set(seal[1]);
    for (const id of physical.keys()) if (!listed.has(id)) this.rejected.push({ id, reason: "message: outside the sealed journal" });
    return { messages: seal[1].map((id) => linked(physical.get(id) as Message)), alias, sealed: true };
  }

  async acks(topic: string, where: Record<string, unknown>): Promise<[NostrEvent, Payload][]> {
    return this.records(KIND.ack, "ack", (e, p) => {
      const got = fields(p, { seat: "str", msg_id: "str", disposition: "str" }, { result_ref: "str", note: "str" });
      record(() => slug(got.seat, "seat"));
      if (!DISPOSITIONS.includes(got.disposition as string)) throw new RecordError(`disposition ${JSON.stringify(got.disposition)} is not one of ${DISPOSITIONS.join(", ")}`);
      if (JSON.stringify(values(e, "e")) !== JSON.stringify([got.msg_id])) throw new RecordError("e tag does not name the message acked");
      return got;
    }, topic, where);
  }

  static settles(topic: string, got: Payload): boolean {
    if (!TERMINAL_DISPOSITIONS.includes(got.disposition as string)) return false;
    if (topic !== INBOX) return true;
    if (got.disposition === "handled") return Boolean(got.result_ref);
    return Boolean(got.result_ref || got.note);
  }

  /** backend.post: once per (author, idempotency key); the receipt names the canonical event. */
  async post(topic: string, body: string, kind: string, subject: string, replyTo: string | null, given?: string): Promise<Payload> {
    checkMessage(body, kind, replyTo);
    // cli._content_key: running the same post twice says it once.
    const key = given ?? (await sha256Hex(pythonJson([topic, body, kind, subject, [], replyTo])));
    if ((await this.seal(topic)) !== null) throw new ToolError(`topic ${JSON.stringify(topic)} is sealed; nothing was sent`);
    const mine = { authors: [this.me], "#i": [await this.keyTag(topic, key)] };
    const said = (m: Message) => JSON.stringify([m.body, m.kind, m.subject, m.refs, m.reply_to]);
    const wanted = JSON.stringify([body, kind, subject, [], replyTo]);
    const earlier = await this.messages(topic, mine);
    if (earlier.length > 0) {
      if (said(earlier[0][1]) !== wanted) {
        throw new ToolError(`key ${JSON.stringify(key)} already carries a different message on ${JSON.stringify(topic)} (${earlier[0][0].id.slice(0, 12)}…); nothing was sent`);
      }
      return receipt(topic, earlier[0][0].id, wireBytes(earlier[0][0]), { duplicate: true, detail: "already posted under this key" });
    }
    const tags = [["i", await this.keyTag(topic, key)], ...(replyTo ? [["e", replyTo]] : [])];
    const payload = { body, kind, subject, refs: [], reply_to: replyTo, key };
    const sent = await this.publish(KIND.message, "message", payload, topic, tags);
    const standing = await this.messages(topic, mine);
    const first = standing[0] ?? [sent];
    if (first[0].id === sent.id) return receipt(topic, sent.id, wireBytes(sent));
    if (said(standing[0][1]) !== wanted) {
      throw new ToolError(`key ${JSON.stringify(key)} was used at the same moment for a different message on ${JSON.stringify(topic)}. ` +
        `The earlier one (${first[0].id.slice(0, 12)}…) stands; this one was sent and no reader will show it`);
    }
    return receipt(topic, first[0].id, wireBytes(first[0]), {
      duplicate: true, detail: "another writer with this key published first; its event is the canonical one",
    });
  }

  async pending(topic: string, seat: string): Promise<Message[]> {
    const journal = await this.journal(topic);
    const done = new Set<string>();
    for (const [, got] of await this.acks(topic, { authors: [this.me] })) {
      if (got.seat === seat && Channel.settles(topic, got)) done.add(journal.alias.get(got.msg_id as string) ?? (got.msg_id as string));
    }
    return journal.messages.filter((m) => !done.has(m.id) && m.author !== this.me);
  }

  /** backend.watch: this seat's unsettled messages, oldest first, waiting up to `waitS`
   * for one when none is pending. The wait is armed before the journal is read, so a
   * message published meanwhile wakes it. */
  async watch(topic: string, seat: string, waitS: number): Promise<Message[]> {
    slug(seat, "seat");
    const deadline = Date.now() + waitS * 1000;
    const filter = parseFilter({ kinds: [KIND.message], ...this.trust.scope(topic) }) as Filter;
    for (;;) {
      const waiting = Date.now() < deadline ? this.relay.waitFor(filter, deadline) : null;
      try {
        const pending = await this.pending(topic, seat);
        if (pending.length > 0 || waiting === null) return pending;
        await waiting.arrived;
      } finally {
        waiting?.cancel();
      }
    }
  }

  async canonical(topic: string, msgId: string): Promise<string> {
    const found = await this.messages(topic, { ids: [msgId] });
    if (found.length === 0) throw new ToolError(`no message ${msgId.slice(0, 12)}… on topic ${JSON.stringify(topic)}`);
    const m = found[0][1];
    const copies = await this.messages(topic, { authors: [m.author], "#i": [await this.keyTag(topic, m.key)] });
    return copies.length > 0 ? copies[0][0].id : msgId;
  }

  /** backend.ack: the first settlement stands. */
  async ack(topic: string, seat: string, msgId: string, disposition: string, resultRef: string | null, note: string | null): Promise<Payload> {
    slug(seat, "seat");
    if (!DISPOSITIONS.includes(disposition)) throw new ToolError(`disposition ${JSON.stringify(disposition)} must be one of ${DISPOSITIONS.join(", ")}`);
    if (topic === INBOX && TERMINAL_DISPOSITIONS.includes(disposition)) {
      if (disposition === "handled" && !resultRef) throw new ToolError("a handled inbox pointer needs result_ref");
      if (disposition !== "handled" && !(resultRef || note)) throw new ToolError(`an inbox pointer marked ${disposition} needs a note or a result_ref`);
    }
    const target = await this.canonical(topic, msgId);
    const mine = { authors: [this.me], "#e": [target] };
    const recorded = async (): Promise<[NostrEvent, Payload] | null> =>
      (await this.acks(topic, mine)).find(([, got]) => got.seat === seat && Channel.settles(topic, got)) ?? null;
    const settled = (e: NostrEvent, got: Payload, detail: string) => receipt(topic, e.id, wireBytes(e), {
      duplicate: detail !== "", detail, disposition: got.disposition, result_ref: got.result_ref ?? null,
    });
    const first = await recorded();
    if (first !== null) return settled(first[0], first[1], "already settled by this seat");
    const payload = { seat, msg_id: target, disposition, result_ref: resultRef, note };
    const sent = await this.publish(KIND.ack, "ack", payload, topic, [["e", target]]);
    if (TERMINAL_DISPOSITIONS.includes(disposition)) {
      const standing = await recorded();
      if (standing !== null && standing[0].id !== sent.id) {
        return settled(standing[0], standing[1], "another writer for this seat settled it first; that settlement stands");
      }
    }
    return settled(sent, payload, "");
  }

  /** backend.history and cmd_read's kind filter. */
  async history(topic: string, after: string | null, kind: string | null): Promise<Message[]> {
    const journal = await this.journal(topic);
    let messages = journal.messages;
    if (after !== null) {
      const cursor = journal.alias.get(after) ?? after;
      const position = messages.findIndex((m) => m.id === cursor);
      if (position < 0) throw new ToolError(`no message ${after.slice(0, 12)}… on topic ${JSON.stringify(topic)} to continue from`);
      messages = journal.sealed ? messages.slice(position + 1)
        : messages.filter((m) => m.created_at >= messages[position].created_at && m.id !== cursor);
    }
    return kind === null ? messages : messages.filter((m) => m.kind === kind);
  }

  // --------------------------------------------------------- the board (heads)
  async heads<T>(kind: number, recordType: string, parse: (p: Payload) => T, nameOf: (r: T) => string,
    authors: Iterable<string>, name?: string): Promise<[NostrEvent, T][]> {
    const where: Record<string, unknown> = { authors: [...authors].sort() };
    if (name !== undefined) where["#d"] = [this.trust.address(name)];
    return this.records(kind, recordType, (e, p) => {
      const r = record(() => parse(p));
      if (JSON.stringify(values(e, "d")) !== JSON.stringify([this.trust.address(nameOf(r))])) {
        throw new RecordError("d tag does not name the record it carries");
      }
      return r;
    }, null, where);
  }

  /** CampaignSession._replace: write the new head of an addressable slot so that it wins,
   * or refuse; then read it back. */
  async replace<T extends object>(kind: number, recordType: string, rec: T, parse: (p: Payload) => T,
    nameOf: (r: T) => string, guard: (held: T) => void): Promise<[NostrEvent, boolean]> {
    const name = nameOf(rec);
    const held = newest(await this.heads(kind, recordType, parse, nameOf, [this.me], name));
    if (held !== null) {
      if (sortedJson(held[1]) === sortedJson(rec)) return [held[0], false];
      guard(held[1]);
    }
    const stamp = Math.max(nowS(), held !== null ? held[0].created_at + 1 : 0);
    const e = await this.publishRecord(
      await this.sign(kind, recordType, rec as unknown as Payload, null, [["d", this.trust.address(name)]], stamp), recordType);
    const won = newest(await this.heads(kind, recordType, parse, nameOf, [this.me], name));
    if (won === null || won[0].id !== e.id) {
      throw new ToolError(`this ${recordType} was sent, but another writer using this key holds the slot ` +
        `(${won !== null ? won[0].id.slice(0, 12) + "…" : "nothing readable"}). One key should have one writer; read the head again before retrying`);
    }
    return [e, true];
  }

  async routes(): Promise<Route[]> {
    const byRoute = new Map<string, [NostrEvent, Route][]>();
    for (const row of await this.heads(KIND.routeHead, "route", routeFields, (r) => r.route, this.trust.leads)) {
      byRoute.set(row[1].route, [...(byRoute.get(row[1].route) ?? []), row]);
    }
    return [...byRoute.keys()].sort().map((name) => (newest(byRoute.get(name) as [NostrEvent, Route][]) as [NostrEvent, Route])[1]);
  }

  async putRoute(r: Route): Promise<[NostrEvent, boolean]> {
    if (!this.trust.leads.has(this.me)) {
      throw new ToolError("the Route Board is written by a lead or operator key of this campaign; this persona is neither, so nothing was sent");
    }
    return this.replace(KIND.routeHead, "route", r, routeFields, (x) => x.route, () => undefined);
  }

  async conditionHeads(name?: string): Promise<[NostrEvent, Condition][]> {
    return this.heads(KIND.conditionHead, "condition", conditionFields, (c) => c.condition, this.trust.reviewers, name);
  }

  static latest(rows: [NostrEvent, Condition][]): [NostrEvent, Condition] | null {
    let best: [NostrEvent, Condition] | null = null;
    for (const row of rows) {
      if (best === null || row[1].rev > best[1].rev || (row[1].rev === best[1].rev && supersedes(row[0], best[0]))) best = row;
    }
    return best;
  }

  async conditions(): Promise<[NostrEvent, Condition][]> {
    const byName = new Map<string, [NostrEvent, Condition][]>();
    for (const row of await this.conditionHeads()) byName.set(row[1].condition, [...(byName.get(row[1].condition) ?? []), row]);
    return [...byName.keys()].sort().map((n) => Channel.latest(byName.get(n) as [NostrEvent, Condition][]) as [NostrEvent, Condition]);
  }

  async openCondition(c: Condition): Promise<[NostrEvent, boolean]> {
    if (!this.trust.reviewers.has(this.me)) throw new ToolError("a condition is opened by a reviewer or operator key of this campaign; nothing was sent");
    const standing = Channel.latest(await this.conditionHeads(slug(c.condition, "condition")));
    if (standing !== null && sortedJson(standing[1]) !== sortedJson(c)) {
      throw new ToolError(`condition ${JSON.stringify(c.condition)} already stands at revision ${standing[1].rev}; a decision moves it, opening it again does not`);
    }
    return this.replace(KIND.conditionHead, "condition", c, conditionFields, (x) => x.condition, (held) => {
      throw new ToolError(`condition ${JSON.stringify(held.condition)} is already open at revision ${held.rev}`);
    });
  }

  parseClaim(e: NostrEvent, p: Payload): Claim {
    const c = record(() => claimFields(p));
    if (values(e, "e").length > 1) throw new RecordError("a claim links at most one goal event");
    return c;
  }

  async claims(where: Record<string, unknown> = {}): Promise<[NostrEvent, Claim][]> {
    return this.records(KIND.claim, "claim", (e, p) => this.parseClaim(e, p), null, where);
  }

  async decisions(claimId?: string, authors?: Iterable<string>): Promise<[NostrEvent, Decision][]> {
    const where: Record<string, unknown> = { authors: [...(authors ?? this.trust.reviewers)].sort() };
    if (claimId !== undefined) where["#e"] = [claimId];
    return this.records(KIND.decision, "decision", (e, p) => {
      const d = record(() => decisionFields(p));
      if (JSON.stringify(values(e, "e")) !== JSON.stringify([d.claim])) throw new RecordError("e tag does not name the claim decided");
      return d;
    }, null, where);
  }

  /** CampaignSession.decide: rule on one claim and move its condition one revision. */
  async decide(claimId: string, outcome: string, reason: string, nextAction: string, statement: string, reopenIf: string):
    Promise<[Decision, Condition, boolean]> {
    if (!this.trust.reviewers.has(this.me)) throw new ToolError("a claim is decided by a reviewer or operator key of this campaign; nothing was sent");
    const found = await this.claims({ ids: [claimId] });
    if (found.length === 0) throw new ToolError(`no claim ${claimId.slice(0, 12)}… on this campaign`);
    const [claimEvent, made] = found[0];
    if (claimEvent.pubkey === this.me) throw new ToolError("a claim is not reviewed by the key that made it; nothing was sent");
    const standing = Channel.latest(await this.conditionHeads(made.condition));
    if (standing === null) throw new ToolError(`condition ${JSON.stringify(made.condition)} was never opened; a reviewer opens it before claims against it can be decided`);
    const head = standing[1];
    const mine = await this.decisions(claimId, [this.me]);
    let ruling: Decision;
    let rulingEvent: NostrEvent;
    if (mine.length > 0) {
      [rulingEvent, ruling] = mine[0];
    } else {
      if (made.condition_rev !== head.rev) {
        throw new ToolError(`the claim was made against revision ${made.condition_rev} of ${JSON.stringify(made.condition)}, which now stands at ` +
          `revision ${head.rev}. The claimant submits again against what is open now; nothing was written`);
      }
      if (outcome === "accepted" && made.effect === "narrows" && statement.trim() === "") {
        throw new ToolError("accepting a claim that narrows the condition needs the narrowed statement");
      }
      ruling = decision({
        claim: claimId, condition: made.condition, condition_rev: head.rev, outcome, reason, next_action: nextAction,
        statement, reopen_if: reopenIf, candidate_digest: made.candidate_digest,
      });
      rulingEvent = await this.publish(KIND.decision, "decision", { ...ruling }, null, [["e", claimId]]);
    }
    if (head.last_decision === rulingEvent.id) return [ruling, head, true];
    if (head.rev !== ruling.condition_rev) {
      throw new ToolError(`the ruling on ${claimId.slice(0, 12)}… was made at revision ${ruling.condition_rev} of ${JSON.stringify(made.condition)}, ` +
        `and the condition has since moved to revision ${head.rev} without it. Reconcile by hand`);
    }
    const moved = conditionAfter(head, made, ruling, rulingEvent.id);
    await this.replace(KIND.conditionHead, "condition", moved, conditionFields, (x) => x.condition, (held) => {
      if (held.rev > head.rev) throw new ToolError(`this key already holds revision ${held.rev} of ${JSON.stringify(held.condition)}`);
    });
    return [ruling, moved, mine.length > 0];
  }

  async handoffs(forSeat: string | null, author: string | null): Promise<[Handoff, NostrEvent, string | null][]> {
    const rows = await this.records(KIND.handoff, "handoff", (_e, p) => {
      const payload = { ...p };
      const addressed = payload.for_seat ?? null;
      delete payload.for_seat;
      if (addressed !== null) record(() => slug(addressed, "seat"));
      const fieldsOf = Object.fromEntries(HANDOFF_FIELDS.map(([k]) => [k, "str" as FieldType]));
      return [addressed as string | null, record(() => handoff(fields(payload, fieldsOf, {})))] as const;
    }, null, author !== null ? { authors: [author] } : {});
    return rows.filter(([, [addressed]]) => forSeat === null || addressed === null || addressed === forSeat)
      .map(([e, [addressed, packet]]) => [packet, e, addressed]);
  }

  async checkpointHead(seat: string, author: string | null): Promise<Checkpoint | null> {
    const found = newest(await this.heads(KIND.checkpointHead, "checkpoint", checkpointFields, (c) => c.seat,
      [author ?? this.me], slug(seat, "seat")));
    return found === null ? null : found[1];
  }

  async putCheckpoint(c: Checkpoint): Promise<[NostrEvent, boolean]> {
    return this.replace(KIND.checkpointHead, "checkpoint", c, checkpointFields, (x) => x.seat, (held) => {
      const behind = c.attempt < held.attempt || (c.attempt === held.attempt && c.seq <= held.seq);
      if (behind) {
        if (c.seq === held.seq && c.attempt === held.attempt) {
          throw new ToolError(`checkpoint ${held.seq} of ${held.seat} is already recorded with digest ${held.sha256.slice(0, 12)}…; ` +
            "a different pointer for the same sequence is a conflict, not an update");
        }
        throw new ToolError(`checkpoint (attempt ${c.attempt}, sequence ${c.seq}) is behind the recorded (attempt ${held.attempt}, ` +
          `sequence ${held.seq}) of ${held.seat}; nothing was written`);
      }
      if (c.seq === held.seq + 1 && c.parent_sha256 && c.parent_sha256 !== held.sha256) {
        throw new ToolError(`checkpoint ${c.seq} declares parent ${c.parent_sha256.slice(0, 12)}…, but the recorded checkpoint ` +
          `${held.seq} is ${held.sha256.slice(0, 12)}…; nothing was written`);
      }
    });
  }
}

/** profile.decrypt_record: under the epoch the record names, or every held one, newest first. */
async function decryptRecord(e: NostrEvent, ring: Ring): Promise<string> {
  const named = values(e, "epoch");
  if (named.length > 1 || (named.length === 1 && !EPOCH.test(named[0]))) {
    throw new RecordError(`epoch tag ${JSON.stringify(named)} is not one positive integer`);
  }
  const failures: string[] = [];
  for (const epoch of named.length === 1 ? [Number(named[0])] : ring.held()) {
    try {
      return await decrypt(e.content, await ring.key(epoch));
    } catch (err) {
      if (err instanceof Nip44Error) failures.push(`epoch ${epoch}: ${err.message}`);
      else throw err;
    }
  }
  throw new RecordError(`NIP-44 v2 decryption failed: ${failures.join("; ")}`);
}

/** keyring.parse_delivery: an epoch-key rumor's content, checked field by field. */
function parseDelivery(rumor: { tags: string[][]; content: string }): { topic: string; campaign: string; epochs: Map<number, string> } {
  let body: unknown;
  try {
    body = JSON.parse(rumor.content);
  } catch (err) {
    if (err instanceof SyntaxError) throw new RecordError("epoch-key delivery is not JSON");
    throw err;
  }
  const b = (body ?? {}) as Payload;
  if (typeof body !== "object" || body === null || b.schema !== KEYRING_SCHEMA) throw new RecordError(`epoch-key delivery is not ${KEYRING_SCHEMA}`);
  if (!KEYRING_MODES.includes(b.mode as string)) throw new RecordError("epoch-key delivery mode is not one of " + KEYRING_MODES.join(", "));
  if (typeof b.campaign !== "string" || typeof b.topic !== "string") throw new RecordError("epoch-key delivery has no campaign or topic");
  const epochs = epochsOf(b.epochs, "epoch-key delivery");
  if (b.current !== Math.max(...epochs.keys())) throw new RecordError("epoch-key delivery names a current epoch it does not carry");
  const tag = (name: string) => JSON.stringify(rumor.tags.filter((t) => t[0] === name && t.length > 1).map((t) => t[1]));
  if (tag("h") !== JSON.stringify([b.topic]) || tag("t") !== JSON.stringify([b.campaign])) {
    throw new RecordError("epoch-key delivery's tags do not name the topic it carries");
  }
  return { topic: b.topic, campaign: b.campaign, epochs };
}

/** backend.Message.__post_init__: what a message must be before it is sent. */
function checkMessage(body: unknown, kind: unknown, replyTo: unknown): void {
  if (typeof body !== "string" || body.trim() === "") throw new ToolError("a message needs a body");
  if (typeof kind !== "string" || !MESSAGE_KIND.test(kind)) throw new ToolError(`message kind ${JSON.stringify(kind)} must match ${MESSAGE_KIND.source}`);
  if (replyTo !== null && (typeof replyTo !== "string" || !HEX64.test(replyTo))) throw new ToolError("reply_to is the id of the message answered");
}

// ------------------------------------------------------------------- the bearer
/** One request's bearer: a token for this relay, and the personas it derives. */
export class Bearer {
  relay: RelayPort;
  token: Token;
  digest: string;
  own: Persona;
  personas = new Map<string, Persona>();

  constructor(relay: RelayPort, token: Token, digestHex: string, own: Persona) {
    this.relay = relay;
    this.token = token;
    this.digest = digestHex;
    this.own = own;
    this.personas.set(own.name, own);
  }

  /** The bearer of `text`, or Unauthorized: a token for another relay, one that is not an
   * nm1_ token at all, and one whose invite is spent while its own persona is no member
   * (it was redeemed by a key that is not this token's, or that member was revoked). */
  static async open(relay: RelayPort, text: string): Promise<Bearer> {
    let token: Token;
    try {
      token = readToken(text);
    } catch (err) {
      if (err instanceof ToolError) throw new Unauthorized(err.message);
      throw err;
    }
    if (!namesThisRelay(token, relay.host)) {
      throw new Unauthorized(`this token is for ${token.trust.relayAuthUrl ?? token.trust.relay}, not for wss://${relay.host}`);
    }
    const own = await derivePersona(token, DEFAULT_PERSONA);
    if (!relay.isMember(own.pubkey) && !relay.inviteOpen(token.code)) {
      throw new Unauthorized("this token's relay invite is spent, expired or unknown, and its persona is not a member of this relay");
    }
    return new Bearer(relay, token, await sha256Hex(SESSION_DOMAIN + token.text), own);
  }

  async persona(name: string | undefined): Promise<Persona> {
    const wanted = name ?? DEFAULT_PERSONA;
    let p = this.personas.get(wanted);
    if (p === undefined) {
      p = await derivePersona(this.token, wanted);
      this.personas.set(wanted, p);
    }
    return p;
  }

  async signed(p: Persona, kind: number, tags: string[][], content = ""): Promise<[boolean, string]> {
    return this.relay.publish(await signEvent(p.key, kind, tags, content, nowS()), p.pubkey);
  }

  /** Admit `p` to the relay, and to the token's topic, through the relay's own doors:
   * the token's persona redeems the token; any other persona is introduced by it. */
  async admit(p: Persona): Promise<Payload> {
    const { token, relay, own } = this;
    const out: Payload = {};
    if (!relay.isMember(own.pubkey)) {
      const [ok, said] = await this.signed(own, INVITE_CLAIM_KIND, [["-"], ["claim", token.code]]);
      if (!ok) throw new RelayRefusal(said);
      out.relay_said = said;
    }
    const topic = token.topic;
    if (topic !== null) {
      const standing = relay.groupStanding(topic, own.pubkey);
      if (standing === "absent") throw new ToolError(`topic ${topic} does not exist on this relay`);
      if (standing !== "member") {
        const proof = await redeemProof(token.groupCode as string, own.pubkey, token.redeem as string);
        const [ok, said] = await this.signed(own, JOIN_REQUEST, [["h", topic], ["code", token.groupCode as string], ["proof", proof]]);
        if (!ok) throw new RelayRefusal(said);
        out.topic_said = said;
      }
    }
    if (p.pubkey === own.pubkey) return out;
    if (!relay.isMember(p.pubkey)) {
      const code = await relay.mintInviteCode(own.pubkey);
      const [ok, said] = await this.signed(p, INVITE_CLAIM_KIND, [["-"], ["claim", code]]);
      if (!ok) throw new RelayRefusal(said);
      out.relay_said = `${said || "joined"} (invited by persona ${own.name}, ${own.npub})`;
    }
    if (topic !== null) {
      const standing = relay.groupStanding(topic, p.pubkey);
      if (standing === "outside") {
        const [ok, said] = await this.signed(p, JOIN_REQUEST, [["h", topic]], `persona ${p.name} of an MCP session`);
        if (!ok) throw new RelayRefusal(said);
        out.topic_said = said;
      }
      if (relay.groupStanding(topic, p.pubkey) !== "member") {
        out.pending = `persona ${p.name} waits for the topic's keeper: nostr-mailbox --topic ${topic} topic approve ${p.npub}`;
      }
    }
    return out;
  }

  /** An admitted persona's channel, keys loaded; ToolError while its join is pending. */
  async channel(p: Persona): Promise<Channel> {
    const admitted = await this.admit(p);
    if (typeof admitted.pending === "string") throw new ToolError(admitted.pending);
    return new Channel(this.relay, this.token, p).load();
  }
}
