import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WebSocket } from "ws";
import { ecdhKeyPair, pairingCodeMaterial, pairingProof, pairingSessionKey, randomNonce, sameSecret, sessionProof } from "./pairing.ts";

const context = "opencode-browser-pairing-v3";
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export type Credential = { profile: string; browser: string; token: string };
export type CredentialStore = { load(): Promise<unknown>; save(credentials: Credential[]): Promise<void> };
type Code = { profile: string; material: string; expiresAt: number };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
export type Connection = { socket: WebSocket; profile: string; browser: string; tabs: Set<number>; pending: Map<number, Pending> };

export class BrowserBroker {
  private credentials: Credential[] = [];
  private codes = new Map<string, Code>();
  private connections = new Map<string, Connection>();
  private sockets = new Set<WebSocket>();
  private nextId = 0;
  private writes: Promise<void> = Promise.resolve();
  private epoch = 0;
  private stopped = false;
  readonly workerTokens = new Map<string, string>();
  private file: string | CredentialStore;
  private port: number;
  private endpoint?: string;
  constructor(file: string | CredentialStore, port: number, endpoint?: string) { this.file = file; this.port = port; this.endpoint = endpoint; }
  async load() {
    try {
      const value: unknown = typeof this.file === "string" ? JSON.parse(await readFile(this.file, "utf8")) : await this.file.load();
      if (!Array.isArray(value) || value.length > 256 || value.some((entry) => !entry || typeof entry.profile !== "string" || typeof entry.browser !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(entry.token))) throw new Error("Invalid browser credentials file");
      this.credentials = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private persist() {
    const text = JSON.stringify(this.credentials);
    const file = this.file;
    const write = this.writes.then(async () => {
      if (typeof file !== "string") return file.save(JSON.parse(text));
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    });
    this.writes = write.catch(() => {});
    return write;
  }
  async pair(profile: string) {
    if (this.stopped) throw new Error("Browser broker is stopping");
    this.prune();
    if (this.codes.size >= 64 && !this.codes.has(profile)) throw new Error("Too many pending pairing codes");
    const code = Array.from(randomBytes(8), byte => alphabet[byte & 31]).join("");
    const epoch = this.epoch;
    const material = await pairingCodeMaterial({ code, legacy: false });
    if (epoch !== this.epoch || this.stopped) throw new Error("Pairing changed; generate a new code");
    const expiresAt = Date.now() + 5 * 60_000;
    this.codes.set(profile, { profile, material, expiresAt });
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }
  private prune() { for (const [key, code] of this.codes) if (code.expiresAt <= Date.now()) this.codes.delete(key); }
  status(profile: string) {
    this.prune();
    return { pairingPending: this.codes.has(profile), browsers: this.credentials.filter(item => item.profile === profile).map(item => ({ id: item.browser, connected: this.connections.has(item.browser), tabs: this.connections.get(item.browser)?.tabs.size ?? 0 })) };
  }
  async revoke(profile: string) {
    this.epoch++;
    this.codes.delete(profile);
    this.credentials = this.credentials.filter(item => item.profile !== profile);
    for (const connection of this.connections.values()) if (connection.profile === profile) connection.socket.close(4006, "Pairing revoked");
    await this.persist();
    return { revoked: true };
  }
  workerToken(profile: string) {
    let token = this.workerTokens.get(profile);
    if (!token) { token = randomBytes(32).toString("base64url"); this.workerTokens.set(profile, token); }
    return token;
  }
  workerProfile(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    for (const [profile, secret] of this.workerTokens) if (timingSafeEqual(Buffer.from(secret), Buffer.from(token))) return profile;
    return undefined;
  }
  accept(socket: WebSocket) {
    if (this.stopped || this.sockets.size >= 64) return socket.close(1013, "Connection limit");
    this.sockets.add(socket);
    let stage = "hello", credential: Credential | undefined;
    let protocolSeen = false;
    let extensionNonce = "", relayNonce = "", browser = "";
    let exchange: Awaited<ReturnType<typeof ecdhKeyPair>> | undefined;
    let transcript: Parameters<typeof pairingSessionKey>[2] | undefined;
    let shared: Uint8Array | undefined;
    let connection: Connection | undefined;
    const epoch = this.epoch;
    const send = (method: string, params: object) => socket.send(JSON.stringify({ method, params }));
    const fail = () => socket.close(4006, "Pairing refused or expired");
    const timeout = setTimeout(fail, 15_000);
    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN && connection) this.rpc(connection, "ping", {}).catch(() => socket.terminate());
    }, 20_000);
    const receive = async (raw: string) => {
      if (raw.length > 8 * 1024 * 1024) return socket.close(1009, "Message too large");
      const message = JSON.parse(raw);
      const params = message.params ?? {};
      if (stage === "hello") {
        if (message.method === "protocol" && !protocolSeen) {
          if (params.protocolVersion !== 3) return fail();
          protocolSeen = true;
          if (params.unpaired === true) socket.close(1000, "Pairing code required");
          return;
        }
        if (!protocolSeen || message.method !== "hello" || params.protocolVersion !== 3 || typeof params.profileId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(params.profileId) || !/^[A-Za-z0-9_-]{22,128}$/.test(params.pairing?.nonce)) return fail();
        browser = params.profileId;
        extensionNonce = params.pairing.nonce;
        relayNonce = randomNonce();
        if (params.pairing.mode === "token") {
          for (const item of this.credentials.filter(item => item.browser === browser)) {
            // The extension sends its proof after the relay proves possession; only one credential per browser.
            credential = item;
          }
          if (!credential) return fail();
          stage = "response";
          send("auth.challenge", { nonce: relayNonce, proof: await pairingProof(credential.token, "relay", this.port, relayNonce, extensionNonce, this.endpoint), protocol: { version: 3, min: 3 } });
        } else if (params.pairing.mode === "code") {
          exchange = await ecdhKeyPair();
          shared = await exchange.secret(params.pairing.ecdh);
          if (!shared) return fail();
          transcript = { endpoint: this.endpoint, port: this.port, extensionNonce, relayNonce, extensionKey: params.pairing.ecdh, relayKey: exchange.publicKey };
          stage = "code";
          send("auth.challenge", { nonce: relayNonce, ecdh: exchange.publicKey, protocol: { version: 3, min: 3 } });
        } else return fail();
      } else if (stage === "code") {
        if (message.method !== "auth.code" || !shared || !transcript || epoch !== this.epoch) return fail();
        this.prune();
        for (const candidate of this.codes.values()) {
          const key = await pairingSessionKey(candidate.material, shared, transcript);
          if (!sameSecret(await sessionProof(key, "extension"), params.proof)) continue;
          if (this.codes.get(candidate.profile) !== candidate || candidate.expiresAt <= Date.now() || epoch !== this.epoch) return fail();
          if (this.credentials.some(item => item.browser === browser && item.profile !== candidate.profile)) return fail();
          this.codes.delete(candidate.profile);
          if (this.credentials.length >= 256) return fail();
          credential = { profile: candidate.profile, browser, token: randomBytes(32).toString("base64url") };
          const old = this.connections.get(browser);
          old?.socket.close(4006, "Browser paired again");
          this.credentials = this.credentials.filter(item => item.browser !== browser);
          this.credentials.push(credential);
          await this.persist();
          const mask = createHmac("sha256", key).update(`${context}|wrap`).digest();
          const wrapped = Buffer.from(Buffer.from(credential.token, "base64url").map((byte, index) => byte ^ mask[index])).toString("base64url");
          stage = "response";
          send("auth.token", { proof: await sessionProof(key, "relay"), wrapped });
          return;
        }
        fail();
      } else if (stage === "response") {
        if (message.method !== "auth.response" || !credential || !this.credentials.includes(credential) || !sameSecret(await pairingProof(credential.token, "extension", this.port, extensionNonce, relayNonce, this.endpoint), params.proof)) return fail();
        stage = "ready";
      } else if (stage === "ready") {
        if (message.method === "debugger.attached") return;
        if (message.method !== "ready" || !credential || !this.credentials.includes(credential)) return fail();
        clearTimeout(timeout);
        const previous = this.connections.get(browser);
        previous?.socket.close(1000, "Reconnected");
        connection = { socket, browser, profile: credential.profile, tabs: new Set(), pending: new Map() };
        this.connections.set(browser, connection);
        stage = "connected";
        void this.rpc(connection, "relay.settings", { browser: { id: browser, name: credential.profile } }).catch(() => {});
      } else if (connection) {
        if (typeof message.id === "number") {
          const pending = connection.pending.get(message.id);
          if (pending) {
            connection.pending.delete(message.id); clearTimeout(pending.timer);
            if (typeof message.error === "string") pending.reject(new Error(message.error)); else pending.resolve(message.result);
          }
        } else if (message.method === "debugger.detached" || message.method === "tabs.removed") connection.tabs.delete(params.tabId);
        // Personal tabs are not automatically adopted. Only agent-created tabs are exposed.
      }
    };
    let queue = Promise.resolve();
    let queued = 0, queuedBytes = 0;
    socket.on("message", raw => {
      const text = raw.toString();
      const size = Buffer.byteLength(text);
      if (size > (stage === "connected" ? 8 * 1024 * 1024 : 16 * 1024) || queued >= 32 || queuedBytes + size > 8 * 1024 * 1024) return socket.close(1008, "Message queue limit");
      queued++; queuedBytes += size;
      queue = queue.then(() => socket.readyState === socket.OPEN ? receive(text) : undefined).catch(() => fail()).finally(() => { queued--; queuedBytes -= size; });
    });
    socket.on("error", () => socket.close());
    socket.on("close", () => {
      clearTimeout(timeout); clearInterval(heartbeat); this.sockets.delete(socket);
      if (connection) {
        if (this.connections.get(browser) === connection) this.connections.delete(browser);
        for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Browser disconnected")); }
      }
    });
  }
  connection(profile: string, browser?: string) {
    const candidates = [...this.connections.values()].filter(item => item.profile === profile && (!browser || browser === item.browser) && item.socket.readyState === item.socket.OPEN);
    if (candidates.length !== 1) throw new Error(candidates.length ? "Select a browser ID" : "No browser connected to this profile");
    return candidates[0];
  }
  rpc(connection: Connection, method: string, params: object): Promise<unknown> {
    if (connection.socket.readyState !== connection.socket.OPEN) return Promise.reject(new Error("Browser disconnected"));
    if (connection.pending.size >= 32) return Promise.reject(new Error("Too many browser commands"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.pending.delete(id); reject(new Error("Browser command timed out")); }, 30_000);
      connection.pending.set(id, { resolve, reject, timer });
      connection.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); connection.pending.delete(id); reject(error); }
      });
    });
  }
  async close() {
    this.stopped = true; this.epoch++;
    for (const socket of this.sockets) socket.terminate();
    this.codes.clear(); this.workerTokens.clear();
    await this.writes;
  }
}
