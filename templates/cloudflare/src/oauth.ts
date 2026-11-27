// OAuth 2.1 for the remote MCP server (mcp.ts), as the MCP authorization spec asks of one,
// so ChatGPT, Claude.ai and any other client that speaks it connect to https://<host>/mcp
// with nothing pasted into the client. A request to /mcp without a token is answered 401
// with `WWW-Authenticate: Bearer resource_metadata="…"`; the client follows it here,
// registers itself, and opens the consent page in its user's browser. There the user
// pastes the nm1_ token once (or the page fills it in from this browser's storage, where
// the console or an earlier consent left it) and presses Authorize.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728: /mcp, and who signs in for it
//   GET  /.well-known/oauth-authorization-server      RFC 8414 (and /.well-known/openid-configuration)
//   POST /oauth/register                              RFC 7591: a client id for its redirect URIs
//   GET  /oauth/authorize                             the consent page: Connect <client> to <relay>
//   POST /oauth/authorize                             its answer: 303 to the redirect URI, code or error
//   POST /oauth/token                                 a code and its PKCE verifier for an access token
//
// Nothing is stored but the ids of redeemed codes. A client id, an authorization code and
// an access token are each a sealed box: AES-256-GCM under a key HKDF derives from
// RELAY_SIGNING_KEY, with its kind as the additional data, so one is never taken for
// another and only this relay opens them. The code and the access token seal the nm1_
// token itself: a call made with the access token acts as the token's own persona,
// through the same Bearer as a call made with the token.
//
// What a client may do is what the token may do: there are no scopes. The access token
// stops working when the token's persona is revoked (`relay revoke`), as the token does,
// or after ACCESS_TOKEN_TTL_S. There is no refresh token: the client then sends its user
// through the consent page again. Erasable TypeScript only, like nostr.ts.

import { CONSOLE_STYLE } from "./console.ts";
import { Bearer, MAX_REQUEST_BYTES, Unauthorized } from "./mailbox.ts";
import type { RelayPort } from "./mailbox.ts";
import {
  AUTHORIZE_PATH,
  MCP_PATH,
  PROTECTED_RESOURCE_PATHS,
  REGISTER_PATH,
  TOKEN_PATH,
  bytesToHex,
  concat,
  hexToBytes,
  randomHex,
  sha256,
  utf8,
} from "./nostr.ts";

/** What the relay's Durable Object lets this module do, beside what mailbox.ts may. */
export interface OauthPort extends RelayPort {
  readonly relayName: string;
  /** RELAY_SIGNING_KEY, 64 hex: every key here is derived from it, under its own label. */
  readonly oauthSecret: string;
  /** Record that code `id` is redeemed, until `expiresAt`: true the first time, false after. */
  spendCode(id: string, expiresAt: number): boolean;
}

// RFC 6749 §4.1.2: "A maximum authorization code lifetime of 10 minutes is RECOMMENDED."
export const CODE_TTL_S = 600;
// An access token's expires_in, as this server was specified: 30 days. Then the client
// sends its user through the consent page again.
export const ACCESS_TOKEN_TTL_S = 30 * 24 * 3600;
// What each sealed box starts with, and seals as its additional data.
const CLIENT_ID = "nmoc_";
const CODE = "nmoa_";
const ACCESS_TOKEN = "nmot_";
const CLIENT_SECRET = "nmos_";
const KEY_DOMAIN = "nostr-relay-deploy/oauth/v1\x1f";
// RFC 7636 §4.1: a code_verifier (and a plain code_challenge) is 43 to 128 unreserved
// characters; an S256 challenge is the base64url of a SHA-256, 43 of them.
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_RULE = "43 to 128 characters of A-Z, a-z, 0-9, '-', '.', '_' and '~' (RFC 7636)";
const CHALLENGE_METHODS = ["S256", "plain"];
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];
// RFC 8252 §7.3: a native app's loopback redirect may name any port when it asks.
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
// Schemes a browser cannot hand a code to an app through, or that would run as script.
const NO_REDIRECT_SCHEMES = ["javascript:", "data:", "file:", "blob:", "about:", "vbscript:", "filesystem:", "ws:", "wss:"];
// The parameters of an authorization request this server reads, carried through the page.
const REQUEST_PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"];

type Payload = Record<string, unknown>;
const nowS = (): number => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------------ the keys
interface Keys {
  seal: CryptoKey;
  mac: CryptoKey;
}

// HKDF and AES are cheap, but an import is an await: once per secret and isolate.
let cachedKeys: { secret: string; keys: Promise<Keys> } | null = null;

function keysOf(port: OauthPort): Promise<Keys> {
  const secret = port.oauthSecret;
  if (cachedKeys === null || cachedKeys.secret !== secret) {
    cachedKeys = { secret, keys: deriveKeys(secret) };
  }
  return cachedKeys.keys;
}

async function deriveKeys(secret: string): Promise<Keys> {
  const base = await crypto.subtle.importKey("raw", hexToBytes(secret), "HKDF", false, ["deriveKey"]);
  const label = (what: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(KEY_DOMAIN + what) });
  const [seal, mac] = await Promise.all([
    crypto.subtle.deriveKey(label("seal"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    crypto.subtle.deriveKey(label("client-secret"), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]),
  ]);
  return { seal, mac };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of unpadded base64url `text`, or null when it is not that. */
function unbase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function seal(port: OauthPort, kind: string, payload: Payload): Promise<string> {
  const { seal: key } = await keysOf(port);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(kind) }, key, utf8(JSON.stringify(payload)));
  return kind + base64url(concat(iv, new Uint8Array(box)));
}

/** What `text` seals when it is a box of `kind` this relay sealed, else null: another
 * kind, a forgery, one sealed under another RELAY_SIGNING_KEY, or no box at all. */
async function unseal(port: OauthPort, kind: string, text: unknown): Promise<Payload | null> {
  if (typeof text !== "string" || !text.startsWith(kind)) return null;
  const bytes = unbase64url(text.slice(kind.length));
  if (bytes === null || bytes.length < 12 + 16) return null; // an IV and a GCM tag at least
  const { seal: key } = await keysOf(port);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: utf8(kind) }, key, bytes.subarray(12));
  } catch (err) {
    if (err instanceof DOMException) return null; // the tag does not verify: not ours
    throw err;
  }
  // This relay wrote what opened, so it is JSON; a failure here is a fault, and propagates.
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as Payload;
}

async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await sha256(utf8(text)));
}

/** Equal strings, compared through their digests in constant time. */
async function sameSecret(given: string, wanted: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(utf8(given)), sha256(utf8(wanted))]);
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ----------------------------------------------------------------- where things are
const origin = (port: OauthPort): string => `https://${port.host}`;

/** The resource an access token is for (RFC 8707): the MCP endpoint. */
export function resourceOf(host: string): string {
  return `https://${host}${MCP_PATH}`;
}

/** Where WWW-Authenticate sends a client that has no token (RFC 9728 §5.1). */
export function resourceMetadataUrl(host: string): string {
  return `https://${host}${PROTECTED_RESOURCE_PATHS[0]}`;
}

/** A `resource` a client may name for /mcp: the endpoint, or this origin itself. */
function resourceOk(port: OauthPort, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    if (err instanceof TypeError) return false; // not a URL: not this resource
    throw err;
  }
  return url.protocol === "https:" && url.host === port.host && ["/", MCP_PATH, `${MCP_PATH}/`].includes(url.pathname) &&
    url.search === "" && url.hash === "" && !value.includes("#");
}

function protectedResource(port: OauthPort): Payload {
  return {
    resource: resourceOf(port.host),
    authorization_servers: [origin(port)],
    bearer_methods_supported: ["header"],
    resource_name: port.relayName,
  };
}

function authorizationServer(port: OauthPort): Payload {
  const at = origin(port);
  return {
    issuer: at,
    authorization_endpoint: at + AUTHORIZE_PATH,
    token_endpoint: at + TOKEN_PATH,
    registration_endpoint: at + REGISTER_PATH,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    code_challenge_methods_supported: CHALLENGE_METHODS,
    authorization_response_iss_parameter_supported: true,
  };
}

// --------------------------------------------------------------------- HTTP helpers
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  // RFC 6749 §5.1: what carries a token or a credential is never cached.
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...headers },
  });
}

function oauthError(status: number, error: string, description: string, headers: Record<string, string> = {}): Response {
  return json(status, { error, error_description: description }, headers);
}

function seeOther(location: string): Response {
  // 303, never 307 (OAuth 2.1 §7.5.2): the form posted the user's token, and a 307 would
  // post it again to the client.
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

/** The body, if it fits one request's cap. */
async function capped(request: Request): Promise<string | Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  const tooBig = (size: number) => oauthError(413, "invalid_request",
    `a ${size.toLocaleString("en")}-byte request is ${Math.round((100 * size) / MAX_REQUEST_BYTES)}% of the ` +
    `${MAX_REQUEST_BYTES.toLocaleString("en")}-byte cap the MCP routes share`);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return tooBig(declared);
  const text = await request.text();
  const size = utf8(text).length;
  return size > MAX_REQUEST_BYTES ? tooBig(size) : text;
}

/** A form body (application/x-www-form-urlencoded, RFC 6749 §3.2), or a JSON object of
 * strings, which some clients send instead. */
async function formOf(request: Request): Promise<URLSearchParams | Response> {
  const text = await capped(request);
  if (text instanceof Response) return text;
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().includes("application/json")) return new URLSearchParams(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return oauthError(400, "invalid_request", `the body is not JSON: ${err.message}`);
    throw err;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return oauthError(400, "invalid_request", "the body is not a JSON object");
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(value as Payload)) {
    if (typeof v !== "string") return oauthError(400, "invalid_request", `${k} must be a string`);
    form.set(k, v);
  }
  return form;
}

function withParams(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.append(k, v);
  return url.toString();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ------------------------------------------------------------------------ clients
interface Client {
  name: string | null;
  redirectUris: string[];
  auth: string;
}

/** Why `uri` cannot be a redirect URI, or null when it can (RFC 6749 §3.1.2, RFC 8252). */
function redirectProblem(uri: unknown): string | null {
  if (typeof uri !== "string") return "a redirect URI is a string";
  let url: URL;
  try {
    url = new URL(uri);
  } catch (err) {
    if (err instanceof TypeError) return `${JSON.stringify(uri)} is not an absolute URL`;
    throw err;
  }
  if (uri.includes("#")) return `${uri} carries a fragment, which a redirect URI must not (RFC 6749 §3.1.2)`;
  if (url.username !== "" || url.password !== "") return `${uri} carries credentials`;
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    return LOOPBACK.includes(url.hostname) ? null : `${uri} is plain http on a host that is not loopback: use https (RFC 8252 §8.3)`;
  }
  if (NO_REDIRECT_SCHEMES.includes(url.protocol)) return `the ${url.protocol} scheme cannot receive a code`;
  return null; // a native app's private-use scheme (RFC 8252 §7.1)
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK.includes(url.hostname);
}

/** Whether `given` is the registered redirect URI: the same string, or for a loopback one
 * the same but for its port (RFC 8252 §7.3). */
function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true;
  let a: URL;
  let b: URL;
  try {
    [a, b] = [new URL(registered), new URL(given)];
  } catch (err) {
    if (err instanceof TypeError) return false; // `given` is no URL, so it is not this one
    throw err;
  }
  return isLoopback(a) && isLoopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search &&
    !given.includes("#") && b.username === "" && b.password === "";
}

async function openClient(port: OauthPort, id: unknown): Promise<Client | null> {
  const c = await unseal(port, CLIENT_ID, id);
  return c === null ? null : { name: (c.n as string | null) ?? null, redirectUris: c.r as string[], auth: c.a as string };
}

async function clientSecret(port: OauthPort, clientId: string): Promise<string> {
  const { mac } = await keysOf(port);
  return CLIENT_SECRET + base64url(new Uint8Array(await crypto.subtle.sign("HMAC", mac, utf8(clientId))));
}

/** POST /oauth/register (RFC 7591). Open to anyone, as the MCP spec has it: a client id
 * admits nothing by itself, and what it registers is shown on the consent page. */
async function register(request: Request, port: OauthPort): Promise<Response> {
  const text = await capped(request);
  if (text instanceof Response) return text;
  const bad = (description: string) => oauthError(400, "invalid_client_metadata", description);
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return bad(`the registration is not JSON: ${err.message}`);
    throw err;
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return bad("the registration is a JSON object of client metadata");
  const m = meta as Payload;
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris is a non-empty array of the URLs the code may be sent to");
  }
  for (const uri of uris) {
    const problem = redirectProblem(uri);
    if (problem !== null) return oauthError(400, "invalid_redirect_uri", problem);
  }
  const auth = m.token_endpoint_auth_method ?? "none";
  if (typeof auth !== "string" || !AUTH_METHODS.includes(auth)) return bad(`token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`);
  const listed = (name: string, needed: string): string | null => {
    const v = m[name];
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return `${name} must be an array of strings`;
    return v.includes(needed) ? null : `${name} must include ${needed}: this server issues authorization codes only`;
  };
  const problem = listed("grant_types", "authorization_code") ?? listed("response_types", "code");
  if (problem !== null) return bad(problem);
  const name = m.client_name ?? null;
  if (name !== null && typeof name !== "string") return bad("client_name must be a string");
  const issuedAt = nowS();
  const clientId = await seal(port, CLIENT_ID, { v: 1, n: name, r: uris, a: auth });
  const out: Payload = {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    ...(name !== null ? { client_name: name } : {}),
    redirect_uris: uris,
    // What was registered, which may be less than was asked: no refresh_token grant here.
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: auth,
  };
  if (auth !== "none") {
    out.client_secret = await clientSecret(port, clientId);
    out.client_secret_expires_at = 0;
  }
  return json(201, out);
}

// ------------------------------------------------------------- the authorization request
interface Asked {
  clientId: string;
  client: Client;
  redirectUri: string;
  explicitRedirect: boolean;
  challenge: string;
  method: string;
  state: string | null;
  params: Record<string, string>; // as the client sent them, for the page to carry on
  resources: string[];
}

type Reading = { ok: Asked } | { page: string };

/** An authorization request (RFC 6749 §4.1.1, with PKCE and RFC 8707's resource). Every
 * fault is shown on this host's page and sent nowhere. RFC 6749 §4.1.2.1 would send most
 * back to the redirect URI, but anyone may register one here, and a request that
 * redirects at once would make this host an open redirector (RFC 9700 §4.11.2). The
 * browser leaves for the redirect URI only when its user presses Authorize or Deny. */
async function readRequest(port: OauthPort, p: URLSearchParams): Promise<Reading> {
  const params: Record<string, string> = {};
  // RFC 8707 §2 lets a client name several resources; each must be this one.
  const repeated = REQUEST_PARAMS.filter((k) => k !== "resource" && p.getAll(k).length > 1);
  for (const k of REQUEST_PARAMS) {
    const v = p.get(k);
    if (v !== null) params[k] = v;
  }
  if (repeated.includes("client_id") || repeated.includes("redirect_uri")) {
    return { page: "the request names its client_id or redirect_uri more than once" };
  }
  const clientId = params.client_id;
  if (clientId === undefined) return { page: "the request names no client (client_id)" };
  const client = await openClient(port, clientId);
  if (client === null) {
    return { page: "this relay never registered that client: its client_id is unknown, or was registered before the relay's signing key changed. Add the server to the client again" };
  }
  const given = params.redirect_uri;
  let redirectUri: string;
  if (given === undefined) {
    if (client.redirectUris.length !== 1) return { page: "the client registered more than one redirect URI, and the request names none (redirect_uri)" };
    redirectUri = client.redirectUris[0];
  } else if (client.redirectUris.some((r) => sameRedirect(r, given))) {
    redirectUri = given;
  } else {
    return { page: "the redirect_uri is not one the client registered" };
  }
  // What the client got wrong, as the error code RFC 6749 §4.1.2.1 names for it.
  const fail = (error: string, description: string): Reading => ({ page: `${error}: ${description}` });
  if (repeated.length > 0) return fail("invalid_request", `${repeated.join(", ")} given more than once`);
  if (params.response_type !== "code") {
    return params.response_type === undefined
      ? fail("invalid_request", "response_type is required, and is code")
      : fail("unsupported_response_type", "this server issues authorization codes only (response_type=code)");
  }
  const challenge = params.code_challenge;
  if (challenge === undefined) return fail("invalid_request", "code_challenge is required: this server takes PKCE only");
  if (!PKCE_VALUE.test(challenge)) return fail("invalid_request", `a code_challenge is ${PKCE_RULE}`);
  // RFC 7636 §4.3: a challenge without a method is plain.
  const method = params.code_challenge_method ?? "plain";
  if (!CHALLENGE_METHODS.includes(method)) return fail("invalid_request", `code_challenge_method must be one of ${CHALLENGE_METHODS.join(", ")}`);
  if (!p.getAll("resource").every((r) => resourceOk(port, r))) {
    return fail("invalid_target", `this server issues tokens for ${resourceOf(port.host)} only`);
  }
  const state = params.state ?? null;
  return {
    ok: { clientId, client, redirectUri, explicitRedirect: given !== undefined, challenge, method, state, params, resources: p.getAll("resource") },
  };
}

// --------------------------------------------------------------------- the page
// The page's own script: it fills the token in from this browser's storage, where the
// console's "Pair a coding agent" card or an earlier consent left it, and keeps it there
// when asked. It sends nothing itself: the form posts the token to this host.
export const CONSENT_SCRIPT = String.raw`
(function () {
  'use strict';
  var TOKEN_KEY = 'nostr-relay-deploy/mcp-token';
  function $(id) { return document.getElementById(id); }
  var field = $('token'), remembered = $('remembered'), rememberRow = $('remember-row'), note = $('storage-note');
  var store = null;
  try { store = window.localStorage; store.getItem(TOKEN_KEY); } catch (err) {
    store = null;
    note.textContent = 'This browser keeps nothing for this page (' + err.message + '), so paste the token each time.';
    note.hidden = false;
  }
  function render() {
    var kept = store ? store.getItem(TOKEN_KEY) : null;
    remembered.hidden = !kept;
    rememberRow.hidden = !store || !!kept;
    return kept;
  }
  var kept = render();
  if (kept && !field.value) field.value = kept;
  $('forget').addEventListener('click', function () {
    store.removeItem(TOKEN_KEY);
    if (field.value === kept) field.value = '';
    kept = render();
    field.focus();
  });
  $('consent').addEventListener('submit', function (ev) {
    var choice = ev.submitter ? ev.submitter.value : 'authorize';
    var token = field.value.trim();
    if (choice === 'authorize' && store && $('remember').checked && token) store.setItem(TOKEN_KEY, token);
  });
})();
`;

// The script and style hashes the page's Content-Security-Policy admits.
let pageHashes: Promise<[string, string]> | null = null;

async function base64Sha256(text: string): Promise<string> {
  return btoa(String.fromCharCode(...(await sha256(utf8(text)))));
}

/** Where the form may send the browser on: this host, and the redirect URI's origin. A
 * browser holds a form's redirect to form-action too, so the code must be let through. */
function formTargets(redirectUri: string): string {
  const url = new URL(redirectUri);
  if (url.protocol !== "https:" && url.protocol !== "http:") return `'self' ${url.protocol}`; // a native app's scheme
  if (url.hostname.startsWith("[")) return `'self' ${url.protocol}`; // CSP names no IPv6 literal
  return `'self' ${isLoopback(url) ? `${url.protocol}//${url.hostname}:*` : url.origin}`;
}

/** Where the redirect goes, as the user should read it before authorizing. */
function destination(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : `${url.protocol} (an app on this device)`;
}

/** A page of this host's, in the console's style. `form` names where its form may send the
 * browser (formTargets), and brings the consent script; null is a page with no form. */
async function page(status: number, title: string, main: string, form: string | null): Promise<Response> {
  pageHashes ??= Promise.all([base64Sha256(CONSENT_SCRIPT), base64Sha256(CONSOLE_STYLE)]);
  const [script, style] = await pageHashes;
  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${script}'`,
    `style-src 'sha256-${style}'`,
    "base-uri 'none'",
    `form-action ${form ?? "'none'"}`,
    "frame-ancestors 'none'",
  ].join("; ");
  const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<meta name="referrer" content="no-referrer">\n<title>${escapeHtml(title)}</title>\n` +
    `<style>${CONSOLE_STYLE}</style>\n</head>\n<body>\n<main class="page">${main}</main>\n` +
    (form === null ? "" : `<script>${CONSENT_SCRIPT}</script>\n`) + "</body>\n</html>\n";
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": policy,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function faultPage(port: OauthPort, message: string): Promise<Response> {
  const main = `
  <section class="card wide" aria-labelledby="title">
    <h1 id="title">This connection cannot be authorized</h1>
    <p class="bad" role="alert">${escapeHtml(message)}.</p>
    <p class="muted">Nothing was sent to the client, and this page links nowhere. If you were adding ${escapeHtml(port.relayName)}
    to a client yourself, remove it there and add it again.</p>
  </section>`;
  return page(400, `Cannot connect to ${port.relayName}`, main, null);
}

function consentPage(port: OauthPort, a: Asked, status: number, problem: string | null): Promise<Response> {
  const named = a.client.name !== null && a.client.name.trim() !== "";
  const client = named ? (a.client.name as string) : "an MCP client";
  const fields = [
    ...Object.entries(a.params).filter(([k]) => k !== "resource"),
    ...a.resources.map((r): [string, string] => ["resource", r]),
  ];
  const hidden = fields.map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join("\n      ");
  const days = Math.round(ACCESS_TOKEN_TTL_S / 86_400);
  const main = `
  <header class="masthead card" aria-labelledby="title">
    <h1 id="title">Connect ${escapeHtml(client)} to ${escapeHtml(port.relayName)}</h1>
    <p>Authorizing sends a code to <strong class="mono">${escapeHtml(destination(a.redirectUri))}</strong>, and whoever
    receives it acts as your nm1_ token's persona: it reads and posts on the token's channel, and reads and writes its
    board, with nostr-mailbox's tools.</p>
    <p class="muted">${named ? `The client calls itself “${escapeHtml(client)}”, a name any client may give itself: judge it by
    where the code goes.` : "The client gave no name: judge it by where the code goes."} Relay: <span class="mono">${escapeHtml(port.host)}</span>.</p>
  </header>
  <section class="card wide" aria-labelledby="token-title">
    <h2 id="token-title">Your nm1_ token</h2>
    ${problem === null ? "" : `<p class="bad" role="alert">${escapeHtml(problem)}</p>`}
    <form id="consent" method="post" action="${AUTHORIZE_PATH}"><div>
      ${hidden}
      <div class="row"><input type="text" id="token" name="token" required autocomplete="off" spellcheck="false"
        placeholder="nm1_… token, or …/join/#nm1_… invite link" aria-label="nm1_ token or invite link"></div>
      <p id="remembered" class="muted" hidden>Filled in from this browser.
        <button id="forget" type="button" class="quiet">Forget it</button></p>
      <p id="storage-note" class="muted" hidden></p>
      <p id="remember-row"><label><input type="checkbox" id="remember"> Remember the token in this browser, for the next Authorize page</label></p>
      <div class="row">
        <button type="submit" name="decision" value="authorize">Authorize</button>
        <button type="submit" name="decision" value="deny" class="quiet" formnovalidate>Deny</button>
      </div>
    </div></form>
    <p class="muted">Authorize only a client you are adding yourself, and only when the code goes where you expect: whoever
    gets it acts as the token's persona for ${days} days, or until the persona is revoked. The first call spends the
    token's invite on that persona, so the token then no longer joins with <code>nostr-mailbox join</code>.</p>
  </section>`;
  return page(status, `Connect ${client} to ${port.relayName}`, main, formTargets(a.redirectUri));
}

/** GET /oauth/authorize: the consent page, or why there is none. */
async function consent(port: OauthPort, params: URLSearchParams): Promise<Response> {
  const read = await readRequest(port, params);
  if ("page" in read) return faultPage(port, read.page);
  return consentPage(port, read.ok, 200, null);
}

/** POST /oauth/authorize: the user's answer. Authorize checks the token as an MCP call
 * would (Bearer.open: readable, this relay's, still good here) and sends a code back. */
async function decide(request: Request, port: OauthPort): Promise<Response> {
  const form = await formOf(request);
  if (form instanceof Response) return form;
  const read = await readRequest(port, form);
  if ("page" in read) return faultPage(port, read.page);
  const a = read.ok;
  const iss = origin(port);
  const decision = form.get("decision");
  if (decision === "deny") {
    return seeOther(withParams(a.redirectUri, { error: "access_denied", error_description: "the user denied the request", state: a.state, iss }));
  }
  if (decision !== "authorize") return consentPage(port, a, 400, "Press Authorize or Deny.");
  const given = (form.get("token") ?? "").trim();
  if (given === "") return consentPage(port, a, 400, "Paste the nm1_ token, or the invite link that carries it, first.");
  let bearer: Bearer;
  try {
    bearer = await Bearer.open(port, given);
  } catch (err) {
    if (err instanceof Unauthorized) return consentPage(port, a, 400, `This relay does not honour that token: ${err.message}.`);
    throw err;
  }
  const code = await seal(port, CODE, {
    v: 1, tok: bearer.token.text, cid: await sha256Hex(a.clientId), ru: a.redirectUri, rx: a.explicitRedirect,
    cc: a.challenge, cm: a.method, jti: randomHex(16), exp: nowS() + CODE_TTL_S,
  });
  return seeOther(withParams(a.redirectUri, { code, state: a.state, iss }));
}

// ------------------------------------------------------------------- the token endpoint
async function pkceHolds(method: unknown, challenge: unknown, verifier: string): Promise<boolean> {
  if (method === "S256") return base64url(await sha256(utf8(verifier))) === challenge;
  return method === "plain" && verifier === challenge;
}

/** The client's id and secret from HTTP Basic (RFC 6749 §2.3.1), or why they cannot be read. */
function basicCredentials(header: string): [string, string] | string {
  const raw = unbase64url(header.replace(/^Basic\s+/i, "").trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  if (raw === null) return "the Basic credentials are not base64";
  const text = new TextDecoder().decode(raw);
  const at = text.indexOf(":");
  if (at < 0) return "the Basic credentials are not id:secret";
  const decode = (part: string): string | null => {
    try {
      return decodeURIComponent(part.replace(/\+/g, " "));
    } catch (err) {
      if (err instanceof URIError) return null; // a malformed %-escape: not form-encoded
      throw err;
    }
  };
  const [id, secret] = [decode(text.slice(0, at)), decode(text.slice(at + 1))];
  return id === null || secret === null ? "the Basic credentials hold a malformed %-escape" : [id, secret];
}

/** POST /oauth/token: grant_type=authorization_code with its PKCE verifier (RFC 6749 §4.1.3,
 * RFC 7636 §4.5). The code is spent once its every check passes, and only once. */
async function exchange(request: Request, port: OauthPort): Promise<Response> {
  const form = await formOf(request);
  if (form instanceof Response) return form;
  const grant = form.get("grant_type");
  if (grant !== "authorization_code") {
    return grant === null
      ? oauthError(400, "invalid_request", "grant_type is required, and is authorization_code")
      : oauthError(400, "unsupported_grant_type", "this server takes authorization codes only, and issues no refresh tokens");
  }
  let clientId = form.get("client_id");
  let secret = form.get("client_secret");
  const header = request.headers.get("Authorization");
  const basic = header !== null && /^Basic\s+/i.test(header);
  const challenge = basic ? { "WWW-Authenticate": 'Basic realm="oauth"' } : {};
  if (basic) {
    const credentials = basicCredentials(header as string);
    if (typeof credentials === "string") return oauthError(401, "invalid_client", credentials, challenge);
    if (clientId !== null && clientId !== credentials[0]) return oauthError(400, "invalid_request", "client_id is not the one the Basic credentials name");
    if (secret !== null) return oauthError(400, "invalid_request", "a client authenticates one way: Basic or client_secret, not both");
    [clientId, secret] = credentials;
  }
  if (clientId === null) return oauthError(401, "invalid_client", "the request names no client (client_id)", challenge);
  const client = await openClient(port, clientId);
  if (client === null) return oauthError(401, "invalid_client", "this relay never registered that client", challenge);
  if (client.auth !== "none" && (secret === null || !(await sameSecret(secret, await clientSecret(port, clientId))))) {
    return oauthError(401, "invalid_client", `the client registered with ${client.auth}, and its secret is missing or wrong`, challenge);
  }
  const code = await unseal(port, CODE, form.get("code"));
  if (code === null) return oauthError(400, "invalid_grant", "the code is not one this relay issued");
  if (code.cid !== (await sha256Hex(clientId))) return oauthError(400, "invalid_grant", "the code was issued to another client");
  if ((code.exp as number) <= nowS()) return oauthError(400, "invalid_grant", `the code expired: a code is good for ${CODE_TTL_S} seconds`);
  const redirect = form.get("redirect_uri");
  if (redirect !== null ? redirect !== code.ru : code.rx === true) {
    return oauthError(400, "invalid_grant", "redirect_uri is not the one the code was sent to");
  }
  if (!form.getAll("resource").every((r) => resourceOk(port, r))) {
    return oauthError(400, "invalid_target", `this server issues tokens for ${resourceOf(port.host)} only`);
  }
  const verifier = form.get("code_verifier");
  if (verifier === null || !PKCE_VALUE.test(verifier)) return oauthError(400, "invalid_request", `code_verifier is required: ${PKCE_RULE}`);
  if (!(await pkceHolds(code.cm, code.cc, verifier))) return oauthError(400, "invalid_grant", "the code_verifier does not match the code_challenge");
  if (!port.spendCode(code.jti as string, code.exp as number)) return oauthError(400, "invalid_grant", "the code was already used: a code is good once");
  let bearer: Bearer;
  try {
    bearer = await Bearer.open(port, code.tok as string);
  } catch (err) {
    if (err instanceof Unauthorized) return oauthError(400, "invalid_grant", `the token behind the code is no longer honoured: ${err.message}`);
    throw err;
  }
  const now = nowS();
  const accessToken = await seal(port, ACCESS_TOKEN, {
    v: 1, tok: bearer.token.text, cid: code.cid, aud: resourceOf(port.host), iat: now, exp: now + ACCESS_TOKEN_TTL_S,
  });
  return json(200, { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S });
}

// ----------------------------------------------------------------- for mcp.ts
/** The nm1_ token an `Authorization: Bearer` value stands for. An access token this relay
 * issued opens to the token it seals; anything else is taken as given, for Bearer.open to
 * judge. Unauthorized for an access token that is forged, another resource's or expired. */
export async function bearerToken(port: OauthPort, presented: string): Promise<string> {
  if (!presented.startsWith(ACCESS_TOKEN)) return presented;
  const t = await unseal(port, ACCESS_TOKEN, presented);
  if (t === null) throw new Unauthorized("this access token is not one this relay issued, or its signing key changed since: authorize again");
  if (t.aud !== resourceOf(port.host)) throw new Unauthorized(`this access token is for ${String(t.aud)}, not for ${resourceOf(port.host)}`);
  const expired = t.exp as number;
  if (expired <= nowS()) {
    throw new Unauthorized(`this access token expired at ${new Date(expired * 1000).toISOString()}: authorize again`);
  }
  return t.tok as string;
}

/** One request to the OAuth routes, inside the relay's Durable Object. */
export async function serveOauth(
  route: "protected-resource" | "authorization-server" | "register" | "authorize" | "token",
  request: Request,
  url: URL,
  port: OauthPort,
): Promise<Response> {
  switch (route) {
    case "protected-resource":
      return json(200, protectedResource(port));
    case "authorization-server":
      return json(200, authorizationServer(port));
    case "register":
      return register(request, port);
    case "authorize":
      return request.method === "GET" ? consent(port, url.searchParams) : decide(request, port);
    case "token":
      return exchange(request, port);
  }
}
