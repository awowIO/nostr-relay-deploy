// NIP-44 version 2 for the Worker: what nostr-mailbox's channels are sealed with
// (nostr_mailbox/nip44.py), so the remote MCP server (mcp.ts, mailbox.ts) can read and
// write a channel on behalf of the nm1_ token that names its keys.
//
//   conversation key  HKDF-extract(salt, ikm): salt "nip44-v2" and the x of a secp256k1
//                     ECDH for a pairwise key (gift wraps); salt "nip44-v2:<campaign>"
//                     and a 32-byte epoch key for a channel (campaign_conversation_key)
//   message keys      HKDF-expand(conversation key, nonce, 76): ChaCha20 key, nonce, HMAC key
//   payload           base64(0x02 || nonce(32) || ChaCha20(padded plaintext) || HMAC(32))
//
// As in nostr-mailbox, a plaintext of 65,536 bytes or more takes the extended 6-byte
// length prefix (0x0000 then 4 bytes), so one cipher covers events and blobs alike.
//
// HMAC and SHA-256 are WebCrypto's; ChaCha20 is the RFC 8439 block function below.
// Erasable TypeScript only, like nostr.ts, so Node's type stripping runs it in the tests.

import { concat, sharedSecretX, utf8 } from "./nostr.ts";
import type { SecretKey } from "./nostr.ts";

const VERSION = 2;
const EXTENDED_PREFIX_THRESHOLD = 65_536;
const MAX_PLAINTEXT = 0xffffffff;
const SALT = "nip44-v2";

/** A payload that fails NIP-44 v2 validation: version, length, MAC or padding. */
export class Nip44Error extends Error {}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

function hkdfExtract(ikm: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(salt, ikm);
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let block = new Uint8Array(0);
  for (let at = 0, counter = 1; at < length; at += block.length, counter++) {
    block = await hmacSha256(prk, concat(block, info, Uint8Array.of(counter)));
    out.set(block.subarray(0, Math.min(block.length, length - at)), at);
  }
  return out;
}

/** The pairwise conversation key of `key` and `pubkey`: conv(a, B) == conv(b, A). */
export function pairwiseConversationKey(key: SecretKey, pubkey: string): Promise<Uint8Array> {
  return hkdfExtract(sharedSecretX(key, pubkey), utf8(SALT));
}

/** A channel's conversation key for one epoch: nostr-mailbox's campaign_conversation_key. */
export function campaignConversationKey(secret: Uint8Array, campaign: string): Promise<Uint8Array> {
  if (secret.length !== 32) throw new Nip44Error("an epoch key is 32 bytes");
  return hkdfExtract(secret, utf8(`${SALT}:${campaign}`));
}

// ------------------------------------------------------------------ ChaCha20 (RFC 8439)
function rotl(v: number, c: number): number {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

function quarter(x: Uint32Array, a: number, b: number, c: number, d: number): void {
  x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16);
  x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
  x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8);
  x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7);
}

function chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12) throw new Nip44Error("ChaCha20 takes a 32-byte key and a 12-byte nonce");
  const state = new Uint32Array(16);
  state.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  const kv = new DataView(key.buffer, key.byteOffset, 32);
  for (let i = 0; i < 8; i++) state[4 + i] = kv.getUint32(4 * i, true);
  const nv = new DataView(nonce.buffer, nonce.byteOffset, 12);
  for (let i = 0; i < 3; i++) state[13 + i] = nv.getUint32(4 * i, true);
  const out = new Uint8Array(data.length);
  const x = new Uint32Array(16);
  const block = new Uint8Array(64);
  const bv = new DataView(block.buffer);
  for (let at = 0, counter = 0; at < data.length; at += 64, counter++) {
    state[12] = counter;
    x.set(state);
    for (let round = 0; round < 10; round++) {
      quarter(x, 0, 4, 8, 12); quarter(x, 1, 5, 9, 13); quarter(x, 2, 6, 10, 14); quarter(x, 3, 7, 11, 15);
      quarter(x, 0, 5, 10, 15); quarter(x, 1, 6, 11, 12); quarter(x, 2, 7, 8, 13); quarter(x, 3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) bv.setUint32(4 * i, (x[i] + state[i]) >>> 0, true);
    const n = Math.min(64, data.length - at);
    for (let i = 0; i < n; i++) out[at + i] = data[at + i] ^ block[i];
  }
  return out;
}

// ------------------------------------------------------------------------- padding
function bitLength(n: number): number {
  return n === 0 ? 0 : n.toString(2).length;
}

export function paddedLength(unpadded: number): number {
  if (unpadded <= 32) return 32;
  const nextPower = 2 ** bitLength(unpadded - 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpadded - 1) / chunk) + 1);
}

function pad(plaintext: Uint8Array): Uint8Array {
  const n = plaintext.length;
  if (n < 1 || n > MAX_PLAINTEXT) throw new Nip44Error(`a plaintext of ${n} bytes cannot be sealed`);
  const prefix = n >= EXTENDED_PREFIX_THRESHOLD ? new Uint8Array(6) : new Uint8Array(2);
  const view = new DataView(prefix.buffer);
  if (prefix.length === 6) view.setUint32(2, n);
  else view.setUint16(0, n);
  const out = new Uint8Array(prefix.length + paddedLength(n));
  out.set(prefix);
  out.set(plaintext, prefix.length);
  return out;
}

function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 2) throw new Nip44Error("invalid padding");
  const view = new DataView(padded.buffer, padded.byteOffset, padded.length);
  let n = view.getUint16(0);
  let prefix = 2;
  if (n === 0) {
    if (padded.length < 6) throw new Nip44Error("invalid padding");
    n = view.getUint32(2);
    if (n < EXTENDED_PREFIX_THRESHOLD) throw new Nip44Error("invalid padding");
    prefix = 6;
  }
  if (padded.length !== prefix + paddedLength(n)) throw new Nip44Error("invalid padding");
  return padded.slice(prefix, prefix + n);
}

// -------------------------------------------------------------------------- base64
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fromBase64(text: string): Uint8Array {
  if (!BASE64.test(text)) throw new Nip44Error("invalid base64");
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- encrypt / decrypt
async function messageKeys(conversationKey: Uint8Array, nonce: Uint8Array): Promise<[Uint8Array, Uint8Array, Uint8Array]> {
  if (conversationKey.length !== 32) throw new Nip44Error("a conversation key is 32 bytes");
  if (nonce.length !== 32) throw new Nip44Error("a nonce is 32 bytes");
  const keys = await hkdfExpand(conversationKey, nonce, 76);
  return [keys.subarray(0, 32), keys.subarray(32, 44), keys.subarray(44, 76)];
}

export async function encryptBytes(plaintext: Uint8Array, conversationKey: Uint8Array, nonce?: Uint8Array): Promise<string> {
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(32));
  const [chachaKey, chachaNonce, hmacKey] = await messageKeys(conversationKey, n);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = await hmacSha256(hmacKey, concat(n, ciphertext));
  return toBase64(concat(Uint8Array.of(VERSION), n, ciphertext, mac));
}

export function encrypt(plaintext: string, conversationKey: Uint8Array, nonce?: Uint8Array): Promise<string> {
  return encryptBytes(utf8(plaintext), conversationKey, nonce);
}

export async function decryptBytes(payload: string, conversationKey: Uint8Array): Promise<Uint8Array> {
  if (payload === "" || payload[0] === "#" || payload[0] === "{") throw new Nip44Error("payload is not NIP-44 v2 ciphertext");
  if (payload.length < 132) throw new Nip44Error("invalid payload size");
  const data = fromBase64(payload);
  if (data.length < 99) throw new Nip44Error("invalid data size");
  if (data[0] !== VERSION) throw new Nip44Error(`unknown encryption version ${data[0]}`);
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const [chachaKey, chachaNonce, hmacKey] = await messageKeys(conversationKey, nonce);
  const expected = await hmacSha256(hmacKey, concat(nonce, ciphertext));
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= expected[i] ^ mac[i];
  if (diff !== 0) throw new Nip44Error("invalid MAC (wrong key, or a tampered ciphertext)");
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}

export async function decrypt(payload: string, conversationKey: Uint8Array): Promise<string> {
  const raw = await decryptBytes(payload, conversationKey);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (err) {
    if (err instanceof TypeError) throw new Nip44Error("the plaintext is not valid UTF-8");
    throw err;
  }
}
