// Pure Nostr primitives for the Cloudflare Worker relay: BIP-340 Schnorr verification,
// NIP-01 event ids, event and filter rules, and the edge route table.
//
// No Cloudflare API is used here, and only erasable TypeScript syntax, so the same file
// runs unchanged under wrangler (esbuild) and under Node's type stripping, which is how
// tests/test_hydrate.py checks it against the published BIP-340 test vectors.

// ------------------------------------------------------------------ secp256k1 / BIP-340
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

// Jacobian coordinates (X, Y, Z) stand for the affine point (X/Z^2, Y/Z^3); Z = 0 is the
// point at infinity.
type Point = readonly [bigint, bigint, bigint];
const INFINITY: Point = [0n, 1n, 0n];
const G: Point = [GX, GY, 1n];

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function invert(a: bigint, m: bigint = P): bigint {
  let low = mod(a, m);
  let high = m;
  let lm = 1n;
  let hm = 0n;
  if (low === 0n) throw new RangeError("zero has no modular inverse");
  while (low > 1n) {
    const q = high / low;
    [lm, hm] = [hm - lm * q, lm];
    [low, high] = [high - low * q, low];
  }
  return mod(lm, m);
}

function powMod(base: bigint, exponent: bigint, m: bigint = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function double(p: Point): Point {
  const [x1, y1, z1] = p;
  if (z1 === 0n || y1 === 0n) return INFINITY;
  const a = mod(x1 * x1);
  const b = mod(y1 * y1);
  const c = mod(b * b);
  const d = mod(2n * (mod((x1 + b) * (x1 + b)) - a - c));
  const e = mod(3n * a);
  const f = mod(e * e);
  const x3 = mod(f - 2n * d);
  const y3 = mod(e * (d - x3) - 8n * c);
  const z3 = mod(2n * y1 * z1);
  return [x3, y3, z3];
}

function add(p: Point, q: Point): Point {
  const [x1, y1, z1] = p;
  const [x2, y2, z2] = q;
  if (z1 === 0n) return q;
  if (z2 === 0n) return p;
  const z1z1 = mod(z1 * z1);
  const z2z2 = mod(z2 * z2);
  const u1 = mod(x1 * z2z2);
  const u2 = mod(x2 * z1z1);
  const s1 = mod(y1 * z2 * z2z2);
  const s2 = mod(y2 * z1 * z1z1);
  const h = mod(u2 - u1);
  const rr = mod(s2 - s1);
  if (h === 0n) return rr === 0n ? double(p) : INFINITY;
  const i = mod(4n * h * h);
  const j = mod(h * i);
  const r = mod(2n * rr);
  const v = mod(u1 * i);
  const x3 = mod(r * r - j - 2n * v);
  const y3 = mod(r * (v - x3) - 2n * s1 * j);
  const z3 = mod((mod((z1 + z2) * (z1 + z2)) - z1z1 - z2z2) * h);
  return [x3, y3, z3];
}

// a*A + b*B in one pass over the bits (Shamir's trick).
function mulAdd(a: bigint, pa: Point, b: bigint, pb: Point): Point {
  const both = add(pa, pb);
  let r: Point = INFINITY;
  for (let i = 255n; i >= 0n; i--) {
    r = double(r);
    const bitA = (a >> i) & 1n;
    const bitB = (b >> i) & 1n;
    if (bitA && bitB) r = add(r, both);
    else if (bitA) r = add(r, pa);
    else if (bitB) r = add(r, pb);
  }
  return r;
}

function liftX(x: bigint): Point | null {
  if (x >= P) return null;
  const c = mod(x * x * x + 7n);
  const y = powMod(c, (P + 1n) / 4n);
  if (mod(y * y) !== c) return null;
  return [x, (y & 1n) === 0n ? y : P - y, 1n];
}

function bytesToBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n;
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

let challengeTag: Uint8Array | null = null;

async function challengeHash(data: Uint8Array): Promise<Uint8Array> {
  challengeTag ??= await sha256(utf8("BIP0340/challenge"));
  return sha256(concat(challengeTag, challengeTag, data));
}

/** BIP-340 verification of `sig` over `msg` under the x-only public key `pubkey`. */
export async function verifySchnorr(
  pubkey: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  if (pubkey.length !== 32 || sig.length !== 64) return false;
  const pt = liftX(bytesToBig(pubkey));
  if (pt === null) return false;
  const rBytes = sig.subarray(0, 32);
  const r = bytesToBig(rBytes);
  const s = bytesToBig(sig.subarray(32));
  if (r >= P || s >= N) return false;
  const e = mod(bytesToBig(await challengeHash(concat(rBytes, pubkey, msg))), N);
  const point = mulAdd(s, G, mod(N - e, N), pt);
  if (point[2] === 0n) return false;
  const zInv = invert(point[2]);
  const zInv2 = mod(zInv * zInv);
  const x = mod(point[0] * zInv2);
  const y = mod(point[1] * zInv2 * zInv);
  return (y & 1n) === 0n && x === r;
}

// ------------------------------------------------------------------------------ hex
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError(`not an even-length hex string: ${JSON.stringify(hex)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(byteCount: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

// --------------------------------------------------------------------------- events
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export const AUTH_KIND = 22242; // NIP-42
export const INVITE_CLAIM_KIND = 28934; // NIP-43 join request
export const BLOSSOM_AUTH_KIND = 24242; // Blossom authorization

/** Why `raw` is not a well-formed event, or null when it is. Checks types only. */
export function eventShapeError(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "an event is a JSON object";
  }
  const e = raw as Record<string, unknown>;
  if (!isHex64(e.id)) return "id must be 64 lowercase hex characters";
  if (!isHex64(e.pubkey)) return "pubkey must be 64 lowercase hex characters";
  if (typeof e.sig !== "string" || !HEX128.test(e.sig)) {
    return "sig must be 128 lowercase hex characters";
  }
  if (typeof e.created_at !== "number" || !Number.isSafeInteger(e.created_at) || e.created_at < 0) {
    return "created_at must be a non-negative integer";
  }
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind) || e.kind < 0 || e.kind > 65535) {
    return "kind must be an integer from 0 to 65535";
  }
  if (
    !Array.isArray(e.tags) ||
    !e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))
  ) {
    return "tags must be an array of arrays of strings";
  }
  if (typeof e.content !== "string") return "content must be a string";
  return null;
}

/** The id an event must carry: SHA-256 of its NIP-01 serialization. */
export async function computeEventId(e: NostrEvent): Promise<string> {
  const serial = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  return bytesToHex(await sha256(utf8(serial)));
}

/** Why `raw` is not a valid signed event, or null when its id and signature hold. */
export async function eventError(raw: unknown): Promise<string | null> {
  const shape = eventShapeError(raw);
  if (shape !== null) return shape;
  const e = raw as NostrEvent;
  if ((await computeEventId(e)) !== e.id) return "id is not the hash of the event";
  const ok = await verifySchnorr(hexToBytes(e.pubkey), hexToBytes(e.id), hexToBytes(e.sig));
  return ok ? null : "signature does not verify";
}

/** Only the seven NIP-01 fields, in their usual order: what the relay stores and sends. */
export function wireEvent(e: NostrEvent): NostrEvent {
  return {
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags,
    content: e.content,
    sig: e.sig,
  };
}

export function tagValue(e: NostrEvent, name: string): string | null {
  const tag = e.tags.find((t) => t[0] === name && t.length > 1);
  return tag === undefined ? null : tag[1];
}

export function tagValues(e: NostrEvent, name: string): string[] {
  return e.tags.filter((t) => t[0] === name && t.length > 1).map((t) => t[1]);
}

/** NIP-70: an event carrying the `["-"]` tag may only be published by its author. */
export function isProtected(e: NostrEvent): boolean {
  return e.tags.some((t) => t.length === 1 && t[0] === "-");
}

/** NIP-40 expiry: null without a tag, "invalid" for a tag that is not a timestamp. */
export function expirationOf(e: NostrEvent): number | null | "invalid" {
  const value = tagValue(e, "expiration");
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) return "invalid";
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : "invalid";
}

export type KindClass = "regular" | "replaceable" | "ephemeral" | "addressable";

/** NIP-01 kind ranges. */
export function kindClass(kind: number): KindClass {
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) return "replaceable";
  if (kind >= 20000 && kind < 30000) return "ephemeral";
  if (kind >= 30000 && kind < 40000) return "addressable";
  return "regular";
}

/** The `d` tag that addresses a NIP-33 event; an absent tag is the empty address. */
export function dTag(e: NostrEvent): string {
  return tagValue(e, "d") ?? "";
}

// -------------------------------------------------------------------------- filters
export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  tags: [string, string[]][];
}

const TAG_KEY = /^#[a-zA-Z]$/;

function stringArray(value: unknown, check: (v: string) => boolean): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && check(v))) return null;
  return value as string[];
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A NIP-01 filter, or why `raw` is not one. Unknown keys are refused rather than ignored,
 * so the relay never answers with more than the client asked for. */
export function parseFilter(raw: unknown): Filter | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "a filter is a JSON object";
  const f: Filter = { tags: [] };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "ids" || key === "authors") {
      const list = stringArray(value, (v) => HEX64.test(v));
      if (list === null) return `${key} must be an array of 64-hex strings`;
      f[key] = list;
    } else if (key === "kinds") {
      if (
        !Array.isArray(value) ||
        !value.every((k) => typeof k === "number" && Number.isInteger(k) && k >= 0 && k <= 65535)
      ) {
        return "kinds must be an array of integers from 0 to 65535";
      }
      f.kinds = value as number[];
    } else if (key === "since" || key === "until" || key === "limit") {
      const n = timestamp(value);
      if (n === null) return `${key} must be a non-negative integer`;
      f[key] = n;
    } else if (TAG_KEY.test(key)) {
      const list = stringArray(value, () => true);
      if (list === null) return `${key} must be an array of strings`;
      f.tags.push([key.slice(1), list]);
    } else {
      return `unsupported filter key ${JSON.stringify(key)}`;
    }
  }
  return f;
}

export function matchesFilter(f: Filter, e: NostrEvent): boolean {
  if (f.ids !== undefined && !f.ids.includes(e.id)) return false;
  if (f.authors !== undefined && !f.authors.includes(e.pubkey)) return false;
  if (f.kinds !== undefined && !f.kinds.includes(e.kind)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const [name, values] of f.tags) {
    if (!e.tags.some((t) => t[0] === name && t.length > 1 && values.includes(t[1]))) return false;
  }
  return true;
}

// ----------------------------------------------------------------------- edge routes
// The whole public surface. The Caddyfile (compose target) and the Traefik IngressRoute
// (kubernetes target) admit exactly these, and tests/test_hydrate.py holds all three to
// one table.
export const BLOB_PATH = /^\/(media\/)?([0-9a-f]{64})([.][a-z0-9]{1,8})?$/;

export type EdgeRoute = "wire" | "info" | "upload" | "blob";

export function edgeRoute(method: string, path: string, headers: Headers): EdgeRoute | null {
  if (path === "/" && method === "GET") {
    if (headers.get("Upgrade") === "websocket") return "wire";
    if (headers.get("Accept") === "application/nostr+json") return "info";
    return null;
  }
  if (method === "PUT" && (path === "/upload" || path === "/media/upload")) return "upload";
  if ((method === "GET" || method === "HEAD") && BLOB_PATH.test(path)) return "blob";
  return null;
}
