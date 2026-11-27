"""Test-side Nostr: a BIP-340 signer (the specification's reference algorithm, checked
against its published vectors in test_hydrate.py), signed events, a minimal RFC 6455
client, and the Node harness that runs the hydrated Cloudflare Worker."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

P = 2**256 - 2**32 - 977                        # the secp256k1 field prime
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

HARNESS = Path(__file__).with_name("worker_harness.mjs")


# ===================================================================== BIP-340 (reference)
def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    if p1[0] == p2[0] and p1[1] != p2[1]:
        return None
    if p1 == p2:
        lam = 3 * p1[0] * p1[0] * pow(2 * p1[1], -1, P) % P
    else:
        lam = (p2[1] - p1[1]) * pow(p2[0] - p1[0], -1, P) % P
    x3 = (lam * lam - p1[0] - p2[0]) % P
    return x3, (lam * (p1[0] - x3) - p1[1]) % P


def _mul(point, n):
    result = None
    for i in range(256):
        if (n >> i) & 1:
            result = _add(result, point)
        point = _add(point, point)
    return result


def _tagged(tag: str, data: bytes) -> bytes:
    th = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(th + th + data).digest()


def pubkey_gen(secret: bytes) -> bytes:
    d = int.from_bytes(secret, "big")
    if not 1 <= d < N:
        raise ValueError("secret key out of range")
    return _mul(G, d)[0].to_bytes(32, "big")


def schnorr_sign(msg: bytes, secret: bytes, aux: bytes) -> bytes:
    d0 = int.from_bytes(secret, "big")
    pt = _mul(G, d0)
    d = d0 if pt[1] % 2 == 0 else N - d0
    t = bytes(a ^ b for a, b in zip(d.to_bytes(32, "big"), _tagged("BIP0340/aux", aux)))
    k0 = int.from_bytes(_tagged("BIP0340/nonce", t + pt[0].to_bytes(32, "big") + msg), "big") % N
    if k0 == 0:
        raise ValueError("nonce is zero")
    r = _mul(G, k0)
    k = k0 if r[1] % 2 == 0 else N - k0
    e = int.from_bytes(_tagged("BIP0340/challenge", r[0].to_bytes(32, "big") + pt[0].to_bytes(32, "big") + msg),
                       "big") % N
    return r[0].to_bytes(32, "big") + ((k + e * d) % N).to_bytes(32, "big")


def schnorr_verify(msg: bytes, pubkey: bytes, sig: bytes) -> bool:
    """BIP-340 verification, the specification's reference algorithm."""
    if len(pubkey) != 32 or len(sig) != 64:
        return False
    x = int.from_bytes(pubkey, "big")
    if x >= P:
        return False
    c = (pow(x, 3, P) + 7) % P
    y = pow(c, (P + 1) // 4, P)
    if pow(y, 2, P) != c:
        return False
    point = (x, y if y % 2 == 0 else P - y)
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if r >= P or s >= N:
        return False
    e = int.from_bytes(_tagged("BIP0340/challenge", sig[:32] + pubkey + msg), "big") % N
    combined = _add(_mul(G, s), _mul(point, N - e))
    return combined is not None and combined[1] % 2 == 0 and combined[0] == r


def event_is_signed(event: dict) -> bool:
    """True when `event`'s id is the hash of its fields and its signature verifies."""
    if event_id(event["pubkey"], event["created_at"], event["kind"], event["tags"], event["content"]) != event["id"]:
        return False
    return schnorr_verify(bytes.fromhex(event["id"]), bytes.fromhex(event["pubkey"]), bytes.fromhex(event["sig"]))


def event_id(pubkey: str, created_at: int, kind: int, tags: list, content: str) -> str:
    serial = json.dumps([0, pubkey, created_at, kind, tags, content], separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(serial.encode("utf-8")).hexdigest()


@dataclass
class Key:
    """A deterministic test key. Not a secret: it exists only inside these tests."""
    secret: bytes

    @classmethod
    def numbered(cls, n: int) -> Key:
        return cls(hashlib.sha256(f"nostr-relay-deploy test key {n}".encode()).digest())

    @property
    def pubkey(self) -> str:
        if not hasattr(self, "_pub"):
            self._pub = pubkey_gen(self.secret).hex()
        return self._pub

    def event(self, kind: int, tags: list | None = None, content: str = "", created_at: int | None = None) -> dict:
        tags = tags or []
        stamp = int(time.time()) if created_at is None else created_at
        eid = event_id(self.pubkey, stamp, kind, tags, content)
        sig = schnorr_sign(bytes.fromhex(eid), self.secret, os.urandom(32)).hex()
        return {"id": eid, "pubkey": self.pubkey, "created_at": stamp, "kind": kind, "tags": tags,
                "content": content, "sig": sig}

    def blossom_auth(self, verb: str, sha256: str | None, server: str, *, expires_in: int = 3600,
                     created_at: int | None = None) -> str:
        now = int(time.time()) if created_at is None else created_at
        tags = [["t", verb], ["expiration", str(now + expires_in)], ["server", server]]
        if sha256 is not None:
            tags.insert(1, ["x", sha256])
        event = self.event(24242, tags, f"{verb} {sha256}", created_at=now)
        token = base64.urlsafe_b64encode(json.dumps(event, separators=(",", ":")).encode()).rstrip(b"=")
        return "Nostr " + token.decode()


# ============================================================================ WebSocket
class Closed(Exception):
    pass


class WsClient:
    """One RFC 6455 client connection to the harness. Reads block: every test step that
    waits names the frame it waits for."""

    def __init__(self, port: int, path: str = "/"):
        self.sock = socket.create_connection(("127.0.0.1", port))
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                           "Sec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise Closed(f"the harness closed the upgrade: {head!r}")
            head += chunk
        status, _, self.buf = head.partition(b"\r\n\r\n")
        if b" 101 " not in status.split(b"\r\n")[0]:
            raise Closed(f"upgrade refused: {status!r}")

    def send(self, message: list) -> None:
        payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_raw(payload)

    def send_raw(self, payload: bytes, opcode: int = 0x1) -> None:
        mask = os.urandom(4)
        size = len(payload)
        if size < 126:
            head = struct.pack("!BB", 0x80 | opcode, 0x80 | size)
        elif size < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, size)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, size)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _read(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise Closed("the relay closed the connection")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self) -> list:
        while True:
            b0, b1 = self._read(2)
            size = b1 & 0x7F
            if size == 126:
                size = struct.unpack("!H", self._read(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self._read(8))[0]
            payload = self._read(size)
            opcode = b0 & 0x0F
            if opcode == 0x8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
                raise Closed(f"close frame {code} {payload[2:].decode(errors='replace')!r}")
            if opcode == 0x1:
                return json.loads(payload)

    def close(self) -> None:
        self.send_raw(struct.pack("!H", 1000), opcode=0x8)
        self.sock.close()


# ============================================================================== harness
def node_problem() -> str | None:
    """Why the Worker cannot run under this machine's Node, or None when it can."""
    node = shutil.which("node")
    if node is None:
        return "node is not installed (the Worker tests need Node >= 23.6 for TypeScript type stripping)"
    version = subprocess.run([node, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    major, minor = (int(x) for x in re.match(r"v(\d+)\.(\d+)", version).groups())
    if (major, minor) < (23, 6):
        return f"node {version} is too old: the Worker tests need >= 23.6 (type stripping, node:sqlite)"
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is an answer to read, not to follow: the Worker's OAuth 303s point at an
    MCP client's redirect URI, which nothing here serves."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Harness:
    """The hydrated Worker, running in a Node process on a loopback port."""

    def __init__(self, worker_ts: Path, variables: dict[str, str]):
        self.variables = variables
        self.log: list[str] = []
        self.proc = subprocess.Popen(["node", str(HARNESS), str(worker_ts), json.dumps(variables)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        # Drained continuously, so a chatty harness never blocks on a full pipe.
        threading.Thread(target=lambda: self.log.extend(self.proc.stderr), daemon=True).start()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f"the Worker harness did not start:\n{self.stderr()}")
        self.port = json.loads(line)["port"]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def stderr(self) -> str:
        return "".join(self.log)

    def stop(self) -> None:
        self.proc.terminate()
        self.proc.wait()
        self.proc.stdout.close()

    def control(self, route: str, body: dict) -> dict:
        request = urllib.request.Request(f"{self.origin}/__harness/{route}", data=json.dumps(body).encode(),
                                         method="POST")
        with self.opener.open(request) as response:
            return json.loads(response.read())

    def probe(self, method: str, path: str, headers: dict[str, str], host: str | None = None) -> dict:
        return self.control("fetch", {"method": method, "path": path, "headers": headers,
                                      "host": host or self.variables["RELAY_HOST"]})

    def http(self, method: str, path: str, *, headers: dict[str, str] | None = None,
             body: bytes | None = None):
        """(status, headers, body); the headers are case-insensitive."""
        request = urllib.request.Request(self.origin + path, data=body, method=method, headers=headers or {})
        try:
            with self.opener.open(request) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read()

    def connect(self) -> WsClient:
        return WsClient(self.port)
