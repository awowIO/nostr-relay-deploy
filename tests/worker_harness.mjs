// Runs the hydrated Cloudflare Worker under Node for tests/test_hydrate.py.
//
//   node tests/worker_harness.mjs <.build/cloudflare/src/worker.ts> '<wrangler [vars] as JSON>'
//
// Prints {"ready": true, "port": N} once it listens on 127.0.0.1:N.
//
// Real here: every line of worker.ts, nostr.ts and console.ts (edge filter, NIP-11, the
// console page, NIP-42, NIP-43 invites and member-minted invites, NIP-29 groups,
// recipient-only kinds, NIP-01 store and filters, Blossom, admin API, BIP-340 signing and
// verification), SQLite (node:sqlite stands in for
// ctx.storage.sql: the same engine, json_each and RETURNING), HTTP and RFC 6455 frames over
// loopback sockets, and WebCrypto.
//
// Stand-ins, so NOT covered by these tests: the Workers runtime's WebSocketPair and
// hibernation API, Durable Object routing, and R2 (an in-memory map that checks the
// `sha256` put option the way R2 is documented to; R2's real refusal text is not seen).
//
// Harness-only routes, never forwarded to the Worker:
//   POST /__harness/fetch   {method, host, path, headers} -> {status, upgrade}  (in-process fetch)
//   POST /__harness/verify  {pubkey, msg, sig} -> {valid}                      (BIP-340 vectors)
//   POST /__harness/sign    {secret, msg, aux} -> {pubkey, sig}                (BIP-340 vectors)
//   POST /__harness/clock   {offset_s}                                          (shift Date.now)
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [workerPath, varsJson] = process.argv.slice(2);
const vars = JSON.parse(varsJson);

let clockOffsetMs = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockOffsetMs;

// ------------------------------------------------------------ runtime stand-ins
const NativeResponse = globalThis.Response;
class HarnessResponse extends NativeResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(null, { status: 200 });
      this.upgrade = init.webSocket;
    } else {
      super(body, init);
    }
  }
}
globalThis.Response = HarnessResponse;

const accepted = new Set();

class ServerSocket {
  constructor() {
    this.attachment = null;
    this.tcp = null;
    this.pending = [];
    this.closed = false;
  }
  send(text) {
    if (this.closed) throw new Error("send on a closed WebSocket");
    if (this.tcp === null) this.pending.push(text);
    else writeFrame(this.tcp, 0x1, Buffer.from(text, "utf8"));
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    accepted.delete(this);
    if (this.tcp !== null) {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      writeFrame(this.tcp, 0x8, payload);
      this.tcp.end();
    }
  }
  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  attach(tcp) {
    this.tcp = tcp;
    for (const text of this.pending.splice(0)) writeFrame(tcp, 0x1, Buffer.from(text, "utf8"));
  }
}

globalThis.WebSocketPair = class {
  constructor() {
    const server = new ServerSocket();
    this[0] = { server };
    this[1] = server;
  }
};

const db = new DatabaseSync(":memory:");
const sql = {
  exec(query, ...bindings) {
    const rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  },
};
const ctx = {
  storage: {
    sql,
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  },
  acceptWebSocket(ws) {
    accepted.add(ws);
  },
  getWebSockets() {
    return [...accepted];
  },
};

const objects = new Map();
function meta(o) {
  return { size: o.bytes.length, uploaded: o.uploaded, httpMetadata: o.httpMetadata };
}
const bucket = {
  async head(key) {
    const o = objects.get(key);
    return o ? meta(o) : null;
  },
  async get(key) {
    const o = objects.get(key);
    return o ? { ...meta(o), body: new Blob([o.bytes]).stream() } : null;
  },
  async put(key, body, options) {
    const bytes = Buffer.from(await new NativeResponse(body).arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (options.sha256 !== undefined && digest !== options.sha256) {
      throw new Error("put: the SHA-256 checksum you specified did not match what we received (harness stand-in)");
    }
    objects.set(key, { bytes, uploaded: new Date(Date.now()), httpMetadata: options.httpMetadata ?? {} });
    return meta(objects.get(key));
  },
};

const worker = await import(pathToFileURL(path.resolve(workerPath)).href);
const nostr = await import(pathToFileURL(path.join(path.dirname(path.resolve(workerPath)), "nostr.ts")).href);
let relayObject = null;
const env = {
  ...vars,
  BLOSSOM_BUCKET: bucket,
  RELAY: {
    idFromName: (name) => name,
    get: () => ({
      fetch: (request) => {
        relayObject ??= new worker.RelayDurableObject(ctx, env);
        return relayObject.fetch(request);
      },
    }),
  },
};

// ------------------------------------------------------------------ RFC 6455 frames
function writeFrame(tcp, opcode, payload) {
  let head;
  if (payload.length < 126) {
    head = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  tcp.write(Buffer.concat([head, payload]));
}

function serveSocket(tcp, server, head) {
  server.attach(tcp);
  let buffer = head;
  let fragments = [];
  const fail = (err) => {
    console.error("harness: relay handler failed", err);
    server.close(1011, "internal error");
  };
  tcp.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      let size = buffer[1] & 0x7f;
      let at = 2;
      if (size === 126) {
        if (buffer.length < 4) return;
        size = buffer.readUInt16BE(2);
        at = 4;
      } else if (size === 127) {
        if (buffer.length < 10) return;
        size = Number(buffer.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (buffer[1] & 0x80) !== 0;
      if (buffer.length < at + (masked ? 4 : 0) + size) return;
      const mask = masked ? buffer.subarray(at, at + 4) : null;
      at += masked ? 4 : 0;
      const payload = Buffer.from(buffer.subarray(at, at + size));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(at + size);
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        Promise.resolve(relayObject.webSocketClose(server, code, payload.subarray(2).toString("utf8"), true)).catch(fail);
        accepted.delete(server);
        return;
      }
      if (opcode === 0x9) {
        writeFrame(tcp, 0xa, payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        relayObject.webSocketMessage(server, text).catch(fail);
      }
    }
  });
  // A client that resets its socket is an ordinary disconnect: "close" follows and cleans up.
  tcp.on("error", (err) => console.error(`harness: socket error (${err.code}); treated as a disconnect`));
  tcp.on("close", () => {
    if (!server.closed && accepted.has(server)) {
      accepted.delete(server);
      Promise.resolve(relayObject.webSocketClose(server, 1006, "", false)).catch(fail);
    }
  });
}

// ------------------------------------------------------------------------- server
let port = 0;
function hostFor(header) {
  const host = header ?? "";
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` ? vars.RELAY_HOST : host;
}

function requestHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (name === "host" || name === "connection") continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function control(route, body, res) {
  const input = JSON.parse(body.toString("utf8") || "{}");
  let output;
  if (route === "/__harness/clock") {
    clockOffsetMs = input.offset_s * 1000;
    output = { offset_s: input.offset_s };
  } else if (route === "/__harness/verify") {
    const valid = await nostr.verifySchnorr(
      nostr.hexToBytes(input.pubkey),
      nostr.hexToBytes(input.msg),
      nostr.hexToBytes(input.sig),
    );
    output = { valid };
  } else if (route === "/__harness/sign") {
    const key = nostr.secretKey(input.secret);
    const sig = await nostr.signSchnorr(nostr.hexToBytes(input.msg), key, nostr.hexToBytes(input.aux));
    output = { pubkey: key.pubkey, sig: nostr.bytesToHex(sig) };
  } else if (route === "/__harness/fetch") {
    const request = new Request(`https://${input.host}${input.path}`, {
      method: input.method,
      headers: input.headers,
    });
    const response = await worker.default.fetch(request, env);
    const upgrade = response.upgrade !== undefined;
    if (upgrade) {
      const server = response.upgrade.server;
      server.close(1000, "probe");
      relayObject.webSocketClose(server, 1000, "probe", true);
    }
    output = { status: upgrade ? 101 : response.status, upgrade };
  } else {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(output));
}

const server = http.createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    if (req.url.startsWith("/__harness/")) return await control(req.url, body, res);
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const request = new Request(`https://${hostFor(req.headers.host)}${req.url}`, {
      method: req.method,
      headers: requestHeaders(req.headers),
      body: hasBody ? body : undefined,
      duplex: "half",
    });
    const response = await worker.default.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (req.method === "HEAD" || response.body === null) return res.end();
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error("harness: request failed", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(err && err.stack ? err.stack : err));
  }
});

server.on("upgrade", async (req, tcp, head) => {
  try {
    const request = new Request(`https://${hostFor(req.headers.host)}${req.url}`, {
      method: req.method,
      headers: requestHeaders(req.headers),
    });
    const response = await worker.default.fetch(request, env);
    if (response.upgrade === undefined) {
      tcp.end(`HTTP/1.1 ${response.status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    const accept = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    tcp.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    serveSocket(tcp, response.upgrade.server, head);
  } catch (err) {
    console.error("harness: upgrade failed", err);
    tcp.destroy();
  }
});

server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  process.stdout.write(JSON.stringify({ ready: true, port }) + "\n");
});
