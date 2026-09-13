import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { ProfileStore, RESOURCE_KINDS, type ProfileSettings, type ResourceKind } from "./profile-store.ts";
import { ApplicationRuntime, type Settings as ApplicationSettings } from "./application-runtime.ts";
import { ApplicationStore, type ApplicationRecord } from "./application-store.ts";
import { applicationHandlerTemplate } from "../lib/application-handler-templates.ts";
import { applicationExecutionContext } from "../lib/application-context.ts";
import { contextMemoryConfig, memoryPath, readMemory } from "../lib/context-memory.ts";
import { isSandboxEnabled } from "../lib/profile-sandbox.ts";
import { handlerEnvironment, HOST_SSH_CREDENTIAL_KEYS, parseProfileEnv, profileEnvironment } from "../lib/profile-env.ts";
import { PulseStore } from "../pulse/store.ts";
import { SkillSourceStore } from "../skill-sources/store.ts";

type ApiConfig = {
  host: string;
  port: number;
  apiToken: string;
  cors: { origin: string };
  publicBaseUrl?: string;
};
type SessionHandle = { session: AgentSession; busy: boolean; profile: string; sessionId: string };
type ServerOptions = { agentDir: string; cwd: string };
type ChatBody = { message: string };
type ChatParams = { profile?: string; sessionId: string };

const MAX_BODY_BYTES = 1_048_576;
let serverPromise: Promise<FastifyInstance> | undefined;
// Some third-party extensions read PI_CODING_AGENT_DIR while loading.
// Only bootstrap is serialized so each runtime captures its own profile.
let profileBootstrap = Promise.resolve();

async function loadConfig(agentDir: string): Promise<ApiConfig> {
  const api = JSON.parse(await readFile(join(agentDir, "api-server.json"), "utf8")) as Partial<ApiConfig>;
  if (!api.apiToken || typeof api.apiToken !== "string") throw new Error("apiToken is missing from api-server.json");
  return {
    host: typeof api.host === "string" && api.host ? api.host : "0.0.0.0",
    port: typeof api.port === "number" ? api.port : 8767,
    apiToken: api.apiToken,
    cors: { origin: typeof process.env.PI_API_CORS_ORIGIN === "string" && process.env.PI_API_CORS_ORIGIN ? process.env.PI_API_CORS_ORIGIN : api.cors?.origin ?? "*" },
    publicBaseUrl: typeof process.env.PI_PUBLIC_BASE_URL === "string" && process.env.PI_PUBLIC_BASE_URL ? process.env.PI_PUBLIC_BASE_URL : typeof api.publicBaseUrl === "string" && api.publicBaseUrl ? api.publicBaseUrl : undefined,
  };
}

function apiError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function authorized(request: FastifyRequest, token: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function chatBody(input: unknown): ChatBody {
  if (!input || typeof input !== "object" || typeof (input as { message?: unknown }).message !== "string" || !(input as ChatBody).message.trim()) {
    throw Object.assign(new Error("The 'message' field must be a non-empty string."), { status: 400 });
  }
  return { message: (input as ChatBody).message };
}

function objectBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("The request body must be a JSON object."), { status: 400 });
  return input as Record<string, unknown>;
}

function resourceKind(value: string): ResourceKind {
  if (!(RESOURCE_KINDS as readonly string[]).includes(value)) throw Object.assign(new Error("Unknown resource type."), { status: 404 });
  return value as ResourceKind;
}
function skillSourceIdentifier(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, ""); }

function textFromMessage(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

class ApiServer {
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly sandboxBusy = new Set<string>();
  private readonly runtimes = new Map<string, Promise<ModelRuntime>>();
  readonly profiles: ProfileStore;
  readonly pulses: PulseStore;
  readonly applications: ApplicationStore;
  readonly skillSources: SkillSourceStore;

  constructor(private readonly options: ServerOptions, private readonly config: ApiConfig) {
    this.profiles = new ProfileStore(options.agentDir);
    this.pulses = new PulseStore(join(options.agentDir, "pulse.db"));
    this.applications = new ApplicationStore(join(options.agentDir, "applications.db"));
    this.skillSources = new SkillSourceStore(options.agentDir);
  }

  private profileDirectory(profile: string): string {
    return this.profiles.directory(profile);
  }

  async agentSettings(): Promise<Record<string, unknown>> {
    try { const value = JSON.parse(await readFile(join(this.options.agentDir, "settings.json"), "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings.json must contain a JSON object."); return value as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }

  private async withProfileEnvironment<T>(agentDir: string, operation: () => Promise<T>, injected: NodeJS.ProcessEnv = {}): Promise<T> {
    const previous = profileBootstrap;
    let release!: () => void;
    profileBootstrap = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const old = { ...process.env };
    try {
      const environment = await profileEnvironment(agentDir, old);
      Object.assign(environment, injected);
      environment.PI_CODING_AGENT_DIR = agentDir;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, environment);
      return await operation();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, old);
      release();
    }
  }

  async handlerEnvironment(profile: string): Promise<Record<string, string | undefined>> {
    await this.profiles.readSettings(profile);
    return handlerEnvironment(this.profileDirectory(profile));
  }

  async getIdentityMapping(application: string, identityKey: string) { return this.applications.identityMapping(application, identityKey); }
  async automaticApplicationSessionPrefix(application: string, identityKey: string) { return this.applications.automaticPrefix(application, identityKey); }
  async getApplicationSession(application: string, profile: string, prefix: string) { return this.applications.session(application, profile, prefix); }
  async getActiveApplicationSession(application: string, profile: string, prefix: string) { return this.applications.activeSession(application, profile, prefix); }
  async nextApplicationSessionId(application: string, profile: string, prefix: string) { return this.applications.nextSessionId(application, profile, prefix); }
  async recordApplicationSession(application: string, profile: string, prefix: string, sessionId: string, rollover: boolean) { this.applications.createSession(application, profile, prefix, sessionId, rollover); }
  async touchApplicationSession(application: string, profile: string, prefix: string, sessionId: string, identityKey?: string) { this.applications.touchSession(application, profile, prefix, sessionId, identityKey); }
  async getApplicationWorkingSessions(profile: string, application: string) { return this.profiles.readApplicationWorkingSessions(profile, application); }
  async setApplicationWorkingSession(profile: string, application: string, key: string, session: { sessionId: string; updatedAt: string; reason: "message" | "rollover" }): Promise<void> { await this.profiles.setApplicationWorkingSession(profile, application, key, session); }
  async retargetPulseThreadSessions(profile: string, fromSessionId: string, toSessionId: string): Promise<void> { this.pulses.retarget(profile, fromSessionId, toSessionId); }

  private async getSession(profile: string, id: string): Promise<SessionHandle> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) throw Object.assign(new Error("Invalid sessionId"), { status: 400 });
    const key = `${profile}:${id}`;
    const current = this.sessions.get(key);
    if (current) return current;

    const agentDir = this.profileDirectory(profile);
    await this.profiles.readSettings(profile);
    const sessionDir = profile === "default" ? undefined : join(agentDir, "sessions");
    const known = await this.listProfileSessions(profile);
    const existing = known.find((session) => session.id === id);
    const sessionManager = existing
      ? SessionManager.open(existing.path, sessionDir, this.options.cwd)
      : SessionManager.create(this.options.cwd, sessionDir, { id });
    const session = await this.withProfileEnvironment(agentDir, async () => {
      const settingsManager = SettingsManager.create(this.options.cwd, agentDir);
      const loader = new DefaultResourceLoader({ cwd: this.options.cwd, agentDir, settingsManager });
      await loader.reload();
      let runtime = this.runtimes.get(agentDir);
      if (!runtime) {
        runtime = ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
        this.runtimes.set(agentDir, runtime);
      }
      return (await createAgentSession({ cwd: this.options.cwd, agentDir, sessionManager, settingsManager, resourceLoader: loader, modelRuntime: await runtime })).session;
    });
    const handle = { session, busy: false, profile, sessionId: id };
    this.sessions.set(key, handle);
    return handle;
  }

  private sessionDirectory(profile: string): string | undefined {
    return profile === "default" ? undefined : join(this.profileDirectory(profile), "sessions");
  }

  // Profile session directories contain conversations from several working
  // directories. The Console is profile-scoped, not cwd-scoped.
  private async listProfileSessions(profile: string) {
    const sessionDir = this.sessionDirectory(profile);
    return SessionManager.listAll(sessionDir);
  }

  async listSessions(profile: string): Promise<Array<Record<string, unknown>>> {
    await this.profiles.readSettings(profile);
    const sessions = await this.listProfileSessions(profile);
    return sessions.map((session) => ({
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      createdAt: session.created.toISOString(),
      updatedAt: session.modified.toISOString(),
      messageCount: session.messageCount,
      preview: session.firstMessage,
    }));
  }

  async createSession(profile: string, input: unknown): Promise<Record<string, unknown>> {
    await this.profiles.readSettings(profile);
    const body = objectBody(input);
    if (body.name !== undefined && typeof body.name !== "string") throw Object.assign(new Error("The 'name' field must be a string."), { status: 400 });
    if (body.id !== undefined && (typeof body.id !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(body.id))) throw Object.assign(new Error("The 'id' field is invalid."), { status: 400 });
    const id = typeof body.id === "string" ? body.id : randomUUID();
    if ((await this.listProfileSessions(profile)).some((item) => item.id === id)) throw Object.assign(new Error("Session already exists."), { status: 409 });
    // A profile session must use its profile directory as CWD. Pi resolves an
    // ID relative to CWD, while API workers themselves run from `/` in Docker.
    const session = SessionManager.create(this.profileDirectory(profile), this.sessionDirectory(profile), { id });
    if (typeof body.name === "string" && body.name.trim()) session.appendSessionInfo(body.name.trim());
    const file = session.getSessionFile();
    const header = session.getHeader();
    if (!file || !header) throw new Error("Unable to create a persistent session.");
    // Pi normally defers writing until an assistant response. This endpoint explicitly
    // registers an empty session by atomically writing its native session entries.
    await writeFile(file, [...[header], ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
    return { id: session.getSessionId(), name: session.getSessionName() ?? null, createdAt: header.timestamp, updatedAt: header.timestamp, messageCount: 0, preview: "" };
  }

  async renameSession(profile: string, id: string, name: string): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) throw Object.assign(new Error("Invalid sessionId"), { status: 400 });
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) throw Object.assign(new Error("Session name must contain 1 to 200 characters."), { status: 400 });
    const key = `${profile}:${id}`, active = this.sessions.get(key);
    if (active) active.session.setSessionName(trimmed);
    else {
      const existing = (await this.listProfileSessions(profile)).find((session) => session.id === id);
      if (!existing) throw Object.assign(new Error("Session not found"), { status: 404 });
      SessionManager.open(existing.path, this.sessionDirectory(profile), this.options.cwd).appendSessionInfo(trimmed);
    }
    return { id, name: trimmed };
  }

  async deleteSession(profile: string, id: string): Promise<void> {
    await this.profiles.readSettings(profile);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) throw Object.assign(new Error("Invalid sessionId"), { status: 400 });
    const key = `${profile}:${id}`;
    const active = this.sessions.get(key);
    if (active?.busy) throw Object.assign(new Error("The session is busy."), { status: 409 });
    const sessions = await this.listProfileSessions(profile);
    const existing = sessions.find((session) => session.id === id);
    if (!existing) throw Object.assign(new Error("Session not found"), { status: 404 });
    active?.session.dispose();
    this.sessions.delete(key);
    await rm(existing.path);
  }

  async getSessionConversation(profile: string, id: string, before?: string, requestedLimit = 16): Promise<Record<string, unknown>> {
    const sessions = await this.listProfileSessions(profile);
    const info = sessions.find((session) => session.id === id);
    if (!info) throw Object.assign(new Error("Session not found"), { status: 404 });
    const session = SessionManager.open(info.path, this.sessionDirectory(profile), this.options.cwd);
    const entries = session.getBranch().filter((entry) => entry.type !== "session_info").map((entry) => {
      if (entry.type === "message") {
        const message = entry.message as { role?: string; content?: unknown; toolName?: string; isError?: boolean; timestamp?: number };
        const blocks = Array.isArray(message.content) ? message.content : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
        return {
          id: entry.id, type: "message", timestamp: entry.timestamp, role: message.role,
          content: blocks.filter((block: any) => block?.type === "text" || block?.type === "thinking").map((block: any) => ({ type: block.type, text: block.text ?? block.thinking ?? "" })),
          tools: blocks.filter((block: any) => block?.type === "toolCall").map((block: any) => ({ name: block.name, arguments: block.arguments })),
          toolName: message.toolName, isError: message.isError,
        };
      }
      if (entry.type === "compaction" || entry.type === "branch_summary") return { id: entry.id, type: entry.type, timestamp: entry.timestamp, summary: (entry as any).summary };
      return { id: entry.id, type: entry.type, timestamp: entry.timestamp };
    });
    const limit = Math.max(1, Math.min(16, Math.floor(requestedLimit) || 16));
    const end = before ? entries.findIndex((entry) => entry.id === before) : entries.length;
    if (before && end < 0) throw Object.assign(new Error("Conversation cursor not found."), { status: 400 });
    const start = Math.max(0, end - limit), page = entries.slice(start, end);
    return { session: { id: info.id, name: info.name, cwd: info.cwd, createdAt: info.created.toISOString(), updatedAt: info.modified.toISOString() }, entries: page, hasMore: start > 0, nextBefore: start > 0 ? page[0]?.id ?? null : null };
  }

  private async discoverSandboxedExtensionTools(profile: string): Promise<void> {
    const agentDir = this.profileDirectory(profile);
    const environment = { ...(await profileEnvironment(agentDir)), PI_PROFILE_ROOT: this.options.agentDir, PI_PROFILE_DISCOVER_TOOLS: "1" };
    const output = await new Promise<string>((resolveRun, reject) => {
      delete environment.PI_API_WORKER;
      const child = spawn(process.execPath, [process.argv[1], "profile", profile, "--no-session", "--print", ""], {
        cwd: agentDir,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolveRun(stdout) : reject(new Error(stderr.trim() || `Sandboxed tool discovery exited with ${code ?? "unknown"}`)));
    });
    const line = output.split(/\r?\n/).map((value) => value.trim()).find((value) => value.startsWith("{\"tools\":"));
    if (!line) throw new Error("Sandboxed tool discovery returned no tool list.");
    const value = JSON.parse(line) as { tools?: unknown };
    if (!Array.isArray(value.tools) || value.tools.some((name) => typeof name !== "string")) throw new Error("Sandboxed tool discovery returned an invalid tool list.");
    this.profiles.registerExtensionTools(value.tools);
  }

  async complete(profile: string, prompt: string): Promise<string> {
    const agentDir = this.profileDirectory(profile);
    if (await this.sandboxed(profile)) {
      const environment = { ...(await profileEnvironment(agentDir)), PI_PROFILE_ROOT: this.options.agentDir };
      delete environment.PI_API_WORKER;
      return new Promise<string>((resolveRun, reject) => {
        const child = spawn(process.execPath, [process.argv[1], "profile", profile, "--no-session", "--print", prompt], { cwd: agentDir, env: environment, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject); child.once("exit", (code) => code === 0 ? resolveRun(stdout.trim()) : reject(new Error(stderr.trim() || `Handoff completion exited with ${code ?? "unknown"}`)));
      });
    }
    return this.withProfileEnvironment(agentDir, async () => {
      const settingsManager = SettingsManager.create(this.options.cwd, agentDir);
      const loader = new DefaultResourceLoader({ cwd: this.options.cwd, agentDir, settingsManager }); await loader.reload();
      let runtime = this.runtimes.get(agentDir); if (!runtime) { runtime = ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }); this.runtimes.set(agentDir, runtime); }
      const { session } = await createAgentSession({ cwd: this.options.cwd, agentDir, sessionManager: SessionManager.inMemory(this.options.cwd), settingsManager, resourceLoader: loader, modelRuntime: await runtime });
      try { await session.prompt(prompt, { source: "rpc" }); return textFromMessage([...session.messages].reverse().find((item) => item.role === "assistant")); } finally { session.dispose(); }
    });
  }

  async discoverExtensionTools(profile: string): Promise<void> {
    const agentDir = this.profileDirectory(profile);
    await this.profiles.readSettings(profile);
    if (await this.sandboxed(profile)) return this.discoverSandboxedExtensionTools(profile);
    await this.withProfileEnvironment(agentDir, async () => {
      const settingsManager = SettingsManager.create(this.options.cwd, agentDir);
      const loader = new DefaultResourceLoader({ cwd: this.options.cwd, agentDir, settingsManager });
      await loader.reload();
      let runtime = this.runtimes.get(agentDir);
      if (!runtime) {
        runtime = ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
        this.runtimes.set(agentDir, runtime);
      }
      const { session } = await createAgentSession({
        cwd: this.options.cwd,
        agentDir,
        sessionManager: SessionManager.inMemory(this.options.cwd),
        settingsManager,
        resourceLoader: loader,
        modelRuntime: await runtime,
      });
      try {
        this.profiles.registerExtensionTools(session.agent.state.tools.map((tool) => tool.name));
      } finally {
        session.dispose();
      }
    });
  }

  private async sandboxed(profile: string): Promise<boolean> {
    return isSandboxEnabled(this.profileDirectory(profile), profile === "default");
  }

  private async runSandboxedPrompt(profile: string, id: string, message: string, onData?: (text: string) => void, handoff?: string, applicationContext?: { application: string; identityKey: string }): Promise<string> {
    const key = `${profile}:${id}`;
    if (this.sandboxBusy.has(key)) throw Object.assign(new Error("The session is already processing a request."), { status: 409 });
    this.sandboxBusy.add(key);
    try {
      const session = (await this.listProfileSessions(profile)).find((item) => item.id === id);
      if (!session) throw Object.assign(new Error(`No session found matching '${id}'`), { status: 404 });
      const workerEnv: NodeJS.ProcessEnv = { ...(await profileEnvironment(this.profileDirectory(profile))), PI_PROFILE_ROOT: this.options.agentDir, ...(handoff ? { PI_APPLICATION_HANDOFF: handoff } : {}), ...(applicationContext ? { PI_APPLICATION_IDENTITY_KEY: applicationContext.identityKey, PI_APPLICATION_SLUG: applicationContext.application } : {}) };
      // The HTTP gateway is an API worker itself. Its children are agent
      // runtimes, not additional HTTP servers.
      delete workerEnv.PI_API_WORKER;
      const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolveRun, reject) => {
        // Supply the native file path, not only its ID. The session manager
        // otherwise scopes an ID lookup to the API worker CWD (`/` in Docker).
        const child = spawn(process.execPath, [process.argv[1], "profile", profile, "--session", session.path, "--print", message], {
          // The sandboxed agent sees its profile directory as CWD, never the
          // HTTP server's CWD or the caller's project directory.
          cwd: this.profileDirectory(profile),
          env: workerEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (chunk) => { const text = String(chunk); stdout += text; onData?.(text); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("exit", (code) => resolveRun({ stdout, stderr, code: code ?? 1 }));
      });
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Sandboxed Pi exited with ${result.code}`);
      return result.stdout.trim();
    } finally { this.sandboxBusy.delete(key); }
  }

  async prompt(profile: string, id: string, message: string, handoff?: string, applicationContext?: { application: string; identityKey: string }): Promise<{ profile: string; sessionId: string; response: string }> {
    if (await this.sandboxed(profile)) return { profile, sessionId: id, response: await this.runSandboxedPrompt(profile, id, message, undefined, handoff, applicationContext) };
    const handle = await this.getSession(profile, id);
    if (handle.busy || !handle.session.isIdle) throw Object.assign(new Error("The session is already processing a request."), { status: 409 });
    handle.busy = true;
    try {
      const promptSession = () => this.withProfileEnvironment(this.profileDirectory(profile), () => handle.session.prompt(message, { source: "rpc" }), handoff ? { PI_APPLICATION_HANDOFF: handoff } : {});
      if (applicationContext) await applicationExecutionContext.run({ ...applicationContext, profile, sessionId: id }, promptSession);
      else await promptSession();
      const assistant = [...handle.session.messages].reverse().find((item) => item.role === "assistant");
      return { profile, sessionId: id, response: textFromMessage(assistant) };
    } finally { handle.busy = false; }
  }

  private async chat(profile: string, id: string, message: string, reply: FastifyReply, stream: boolean): Promise<void> {
    if (await this.sandboxed(profile)) {
      if (!stream) { reply.send({ profile, sessionId: id, response: await this.runSandboxedPrompt(profile, id, message) }); return; }
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      reply.raw.write(`event: session\ndata: ${JSON.stringify({ profile, sessionId: id })}\n\n`);
      try {
        const response = await this.runSandboxedPrompt(profile, id, message, (text) => reply.raw.write(`event: token\ndata: ${JSON.stringify({ text })}\n\n`));
        reply.raw.write(`event: done\ndata: ${JSON.stringify({ response, sessionId: id, profile })}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      }
      reply.raw.end(); return;
    }
    const handle = await this.getSession(profile, id);
    if (handle.busy || !handle.session.isIdle) {
      apiError(reply, 409, "SESSION_BUSY", "The session is already processing a request.");
      return;
    }
    handle.busy = true;
    let unsubscribe = () => {};
    let closed = false;
    try {
      if (stream) {
        reply.hijack();
        const response = reply.raw;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(`event: session\ndata: ${JSON.stringify({ profile, sessionId: id })}\n\n`);
        unsubscribe = handle.session.subscribe((event) => {
          if (!closed && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            response.write(`event: token\ndata: ${JSON.stringify({ text: event.assistantMessageEvent.delta })}\n\n`);
          }
        });
        response.once("close", () => { closed = true; void handle.session.abort(); });
      }
      await this.withProfileEnvironment(this.profileDirectory(profile), () => handle.session.prompt(message, { source: "rpc" }));
      const assistant = [...handle.session.messages].reverse().find((item) => item.role === "assistant");
      const response = textFromMessage(assistant);
      if (stream) {
        if (!closed) {
          reply.raw.write(`event: done\ndata: ${JSON.stringify({ response, sessionId: id, profile })}\n\n`);
          reply.raw.end();
        }
      } else {
        reply.send({ profile, sessionId: id, response });
      }
    } finally {
      unsubscribe();
      handle.busy = false;
    }
  }

  async handleChat(request: FastifyRequest<{ Params: ChatParams }>, reply: FastifyReply, stream: boolean): Promise<void> {
    if (!authorized(request, this.config.apiToken)) {
      apiError(reply, 401, "UNAUTHORIZED", "Bearer token is missing or invalid.");
      return;
    }
    try {
      const input = chatBody(request.body);
      await this.chat(request.params.profile ?? "default", request.params.sessionId, input.message, reply, stream);
    } catch (cause) {
      const exception = cause as Error & { status?: number };
      if (!reply.sent) apiError(reply, exception.status ?? 500, exception.status ? "BAD_REQUEST" : "INTERNAL_ERROR", exception.status ? exception.message : "Internal API error.");
      else if (!reply.raw.writableEnded) reply.raw.end();
    }
  }
}

export async function startApiServer(options: ServerOptions): Promise<FastifyInstance> {
  if (serverPromise) return serverPromise;
  serverPromise = (async () => {
    const config = await loadConfig(options.agentDir);
    const api = new ApiServer(options, config);
    const server = Fastify({ bodyLimit: MAX_BODY_BYTES, logger: false });
    await server.register(websocket);
    const applicationLogTickets = new Map<string, { slug: string; expiresAt: number }>();
    const terminalTickets = new Map<string, { expiresAt: number }>();
    const terminalEnabled = process.env.PI_CONSOLE_TERMINAL_ENABLED !== "false";
    const terminalCwd = process.env.PI_CONSOLE_TERMINAL_CWD ?? options.agentDir;
    const terminalShell = process.env.PI_CONSOLE_TERMINAL_SHELL ?? "/bin/bash";
    const terminalUrl = (ticket: string) => { const base = new URL(config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`); base.protocol = base.protocol === "https:" ? "wss:" : "ws:"; base.pathname = "/api/terminal/stream"; base.search = `ticket=${encodeURIComponent(ticket)}`; return base.toString(); }; 

    server.addHook("onRequest", async (_request, reply) => {
      reply.header("access-control-allow-origin", config.cors.origin);
      reply.header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("access-control-allow-headers", "Authorization, Content-Type");
    });
    server.options("/*", async (_request, reply) => reply.code(204).send());
    server.get("/api/health", async () => ({ ok: true, service: "pi-api", status: "running" }));

    const chat = (url: string, stream = false) => {
      server.post<{ Params: ChatParams }>(url, async (request, reply) => api.handleChat(request, reply, stream));
    };
    chat("/api/sessions/:sessionId/chat");
    chat("/api/sessions/:sessionId/chat/stream", true);
    chat("/profile/:profile/api/sessions/:sessionId/chat");
    chat("/profile/:profile/api/sessions/:sessionId/chat/stream", true);
    // Compatibility routes retained for existing API clients.
    chat("/profile/:profile/sessions/:sessionId/chat");
    chat("/profile/:profile/sessions/:sessionId/chat/stream", true);

    const guard = (request: FastifyRequest, reply: FastifyReply): boolean => {
      if (authorized(request, config.apiToken)) return true;
      apiError(reply, 401, "UNAUTHORIZED", "Bearer token is missing or invalid.");
      return false;
    };
    const profileName = (request: FastifyRequest<{ Params: { profile: string } }>) => request.params.profile;
    const pulseTick = async (action: "start" | "stop" | "status") => new Promise<string>((resolveRun, reject) => {
      const child = spawn(process.execPath, [process.argv[1], "pulse", action], { cwd: options.cwd, env: { ...process.env, PI_API_WORKER: "" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += String(chunk)); child.stderr.on("data", (chunk) => stderr += String(chunk));
      child.once("error", reject); child.once("exit", (code) => code === 0 ? resolveRun(stdout.trim()) : reject(new Error(stderr.trim() || `Pulse command exited with ${code}`)));
    });
    const pulseTickStatus = async () => {
      try { const state = JSON.parse(await readFile(join(options.agentDir, "pulse-tick.state.json"), "utf8")) as { pid?: unknown; startedAt?: unknown }; const pid = typeof state.pid === "number" ? state.pid : 0; let running = false; try { process.kill(pid, 0); running = pid > 0; } catch {} return { running, status: running ? `Pulse tick running (PID ${pid}).` : "Pulse tick stopped." }; }
      catch { return { running: false, status: "Pulse tick stopped." }; }
    };
    server.get("/api/pulse/tick/status", async (request, reply) => {
      if (!guard(request, reply)) return;
      return pulseTickStatus();
    });
    server.post<{ Body: { enabled?: unknown } }>("/api/pulse/tick", async (request, reply) => {
      if (!guard(request, reply)) return;
      if (typeof request.body?.enabled !== "boolean") throw Object.assign(new Error("The 'enabled' field must be a boolean."), { status: 400 });
      await pulseTick(request.body.enabled ? "start" : "stop"); return pulseTickStatus();
    });

    server.get("/api/profiles",  async (request, reply) => {
      if (!guard(request, reply)) return;
      return { profiles: await api.profiles.list() };
    });
    server.post("/api/profiles", async (request, reply) => {
      if (!guard(request, reply)) return;
      const name = objectBody(request.body).name;
      if (typeof name !== "string") throw Object.assign(new Error("The 'name' field must be a string."), { status: 400 });
      const profile = await api.profiles.create(name);
      return reply.code(201).send(profile);
    });
    server.get<{ Params: { profile: string } }>("/api/profiles/:profile", async (request, reply) => {
      if (!guard(request, reply)) return;
      const settings = await api.profiles.readSettings(profileName(request));
      return { name: profileName(request), path: api.profiles.directory(profileName(request)), hasSoul: true, hasRefine: true, policy: settings.profile ?? {} };
    });
    server.delete<{ Params: { profile: string } }>("/api/profiles/:profile", async (request, reply) => {
      if (!guard(request, reply)) return;
      if (objectBody(request.body).force !== true) throw Object.assign(new Error('Profile deletion requires { "force": true }.'), { status: 400 });
      await api.profiles.delete(profileName(request));
      return reply.code(204).send();
    });

    server.get<{ Params: { profile: string } }>("/api/profiles/:profile/settings", async (request, reply) => {
      if (!guard(request, reply)) return;
      return { settings: await api.profiles.readSettings(profileName(request)) };
    });
    server.put<{ Params: { profile: string } }>("/api/profiles/:profile/settings", async (request, reply) => {
      if (!guard(request, reply)) return;
      const settings = objectBody(request.body) as ProfileSettings;
      return { settings: await api.profiles.writeSettings(profileName(request), settings) };
    });

    const documentRoute = (name: "soul" | "refine", file: "SOUL.md" | "REFINE.md") => {
      server.get<{ Params: { profile: string } }>(`/api/profiles/:profile/${name}`, async (request, reply) => {
        if (!guard(request, reply)) return;
        return { content: await api.profiles.readDocument(profileName(request), file) };
      });
      server.put<{ Params: { profile: string } }>(`/api/profiles/:profile/${name}`, async (request, reply) => {
        if (!guard(request, reply)) return;
        const content = objectBody(request.body).content;
        if (typeof content !== "string") throw Object.assign(new Error("The 'content' field must be a string."), { status: 400 });
        await api.profiles.writeDocument(profileName(request), file, content);
        return { content };
      });
    };
    documentRoute("soul", "SOUL.md");
    documentRoute("refine", "REFINE.md");

    server.get<{ Params: { profile: string } }>("/api/profiles/:profile/context-memory", async (request, reply) => {
      if (!guard(request, reply)) return;
      const profile = profileName(request);
      const settings = await api.profiles.readSettings(profile);
      return { config: contextMemoryConfig((settings.profile as { contextMemory?: unknown } | undefined)?.contextMemory) };
    });
    server.put<{ Params: { profile: string } }>("/api/profiles/:profile/context-memory", async (request, reply) => {
      if (!guard(request, reply)) return;
      const profile = profileName(request), body = objectBody(request.body);
      const config = body.config === null ? undefined : contextMemoryConfig(body.config);
      if (body.config !== null && !config) throw Object.assign(new Error("Invalid Context Memory configuration."), { status: 400 });
      const settings = await api.profiles.readSettings(profile);
      const policy = { ...((settings.profile as Record<string, unknown> | undefined) ?? {}) };
      if (config) policy.contextMemory = config; else delete policy.contextMemory;
      await api.profiles.writeSettings(profile, { ...settings, profile: policy });
      return { config: config ?? null };
    });
    for (const target of ["operational", "profile"] as const) {
      server.get<{ Params: { profile: string } }>(`/api/profiles/:profile/context-memory/${target}`, async (request, reply) => {
        if (!guard(request, reply)) return;
        const profile = profileName(request), directory = api.profiles.directory(profile);
        return { content: await readMemory(memoryPath(options.agentDir, directory, target)) };
      });
      server.put<{ Params: { profile: string } }>(`/api/profiles/:profile/context-memory/${target}`, async (request, reply) => {
        if (!guard(request, reply)) return;
        const content = objectBody(request.body).content;
        if (typeof content !== "string") throw Object.assign(new Error("Content must be a string."), { status: 400 });
        if (Buffer.byteLength(content, "utf8") > 64 * 1024) throw Object.assign(new Error("Context Memory exceeds its size limit."), { status: 413 });
        const profile = profileName(request), directory = api.profiles.directory(profile), path = memoryPath(options.agentDir, directory, target);
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${content.trim()}${content.trim() ? "\n" : ""}`, { mode: 0o600 });
        return { content: content.trim() };
      });
    }

    server.get<{ Params: { profile: string } }>("/api/profiles/:profile/env", async (request, reply) => {
      if (!guard(request, reply)) return;
      const path = join(api.profiles.directory(profileName(request)), ".env");
      try {
        return { content: await readFile(path, "utf8"), exists: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", exists: false };
        throw error;
      }
    });
    server.put<{ Params: { profile: string } }>("/api/profiles/:profile/env", async (request, reply) => {
      if (!guard(request, reply)) return;
      const content = objectBody(request.body).content;
      if (typeof content !== "string") throw Object.assign(new Error("The 'content' field must be a string."), { status: 400 });
      if (Buffer.byteLength(content, "utf8") > MAX_BODY_BYTES) throw Object.assign(new Error("The .env file exceeds the 1 MiB limit."), { status: 413 });
      const path = join(api.profiles.directory(profileName(request)), ".env");
      let values: Record<string, string>;
      try {
        values = parseProfileEnv(content, path);
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
      const blocked = Object.keys(values).filter((key) => HOST_SSH_CREDENTIAL_KEYS.includes(key as typeof HOST_SSH_CREDENTIAL_KEYS[number]));
      if (blocked.length) throw Object.assign(new Error(`The following SSH credential variables are not allowed: ${blocked.join(", ")}.`), { status: 400 });
      const temporary = join(dirname(path), `.${randomUUID()}.env.tmp`);
      try {
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return { content, exists: true };
    });

    server.get<{ Params: { profile: string } }>("/api/profiles/:profile/guardrails", async (request, reply) => {
      if (!guard(request, reply)) return;
      return { content: await api.profiles.readGuardrailsConfig(profileName(request)) };
    });
    server.put<{ Params: { profile: string } }>("/api/profiles/:profile/guardrails", async (request, reply) => {
      if (!guard(request, reply)) return;
      const content = objectBody(request.body).content;
      if (typeof content !== "string") throw Object.assign(new Error("The 'content' field must be a string."), { status: 400 });
      try { await api.profiles.writeGuardrailsConfig(profileName(request), content); }
      catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 }); }
      return { content };
    });
    server.get<{ Params: { profile: string; file: string } }>("/api/profiles/:profile/guardrails/:file/document", async (request, reply) => {
      if (!guard(request, reply)) return;
      return { content: await api.profiles.readGuardrailDocument(profileName(request), request.params.file) };
    });
    server.put<{ Params: { profile: string; file: string } }>("/api/profiles/:profile/guardrails/:file/document", async (request, reply) => {
      if (!guard(request, reply)) return;
      const content = objectBody(request.body).content;
      if (typeof content !== "string") throw Object.assign(new Error("The 'content' field must be a string."), { status: 400 });
      await api.profiles.writeGuardrailDocument(profileName(request), request.params.file, content);
      return { content };
    });

    server.get<{ Params: { profile: string } }>("/api/profiles/:profile/sessions", async (request, reply) => {
      if (!guard(request, reply)) return;
      return { sessions: await api.listSessions(profileName(request)) };
    });
    server.post<{ Params: { profile: string } }>("/api/profiles/:profile/sessions", async (request, reply) => {
      if (!guard(request, reply)) return;
      return reply.code(201).send(await api.createSession(profileName(request), request.body));
    });
    server.get<{ Params: { profile: string; sessionId: string }; Querystring: { before?: string; limit?: string } }>("/api/profiles/:profile/sessions/:sessionId", async (request, reply) => {
      if (!guard(request, reply)) return;
      const limit = request.query.limit === undefined ? 16 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw Object.assign(new Error("The 'limit' query parameter must be an integer from 1 to 16."), { status: 400 });
      return api.getSessionConversation(profileName(request), request.params.sessionId, request.query.before, limit);
    });
    server.patch<{ Params: { profile: string; sessionId: string } }>("/api/profiles/:profile/sessions/:sessionId", async (request, reply) => {
      if (!guard(request, reply)) return;
      const name = objectBody(request.body).name;
      if (typeof name !== "string") throw Object.assign(new Error("The 'name' field must be a string."), { status: 400 });
      return api.renameSession(profileName(request), request.params.sessionId, name);
    });
    server.delete<{ Params: { profile: string; sessionId: string } }>("/api/profiles/:profile/sessions/:sessionId", async (request, reply) => {
      if (!guard(request, reply)) return;
      await api.deleteSession(profileName(request), request.params.sessionId);
      return reply.code(204).send();
    });

    server.get<{ Params: { profile: string } }>("/api/profiles/:profile/pulses", async (request, reply) => {
      if (!guard(request, reply)) return;
      await api.profiles.readSettings(profileName(request));
      return { pulses: api.pulses.list(profileName(request)) };
    });
    server.get<{ Params: { profile: string } }>("/api/profiles/:profile/pulses/history", async (request, reply) => {
      if (!guard(request, reply)) return;
      await api.profiles.readSettings(profileName(request));
      return { pulses: api.pulses.history(profileName(request)) };
    });
    server.post<{ Params: { profile: string } }>("/api/profiles/:profile/pulses", async (request, reply) => {
      if (!guard(request, reply)) return;
      await api.profiles.readSettings(profileName(request));
      const body = objectBody(request.body), fields = ["name", "description", "schedule", "prompt"] as const;
      for (const field of fields) if (typeof body[field] !== "string" || !String(body[field]).trim()) throw Object.assign(new Error(`The '${field}' field must be a non-empty string.`), { status: 400 });
      const sessionId = typeof body.thread_session_id === "string" ? body.thread_session_id : "";
      if (sessionId && !(await api.listSessions(profileName(request))).some((session) => session.id === sessionId)) throw Object.assign(new Error("The thread_session_id session was not found."), { status: 404 });
      try { return reply.code(201).send({ pulse: api.pulses.create({ name: body.name as string, description: body.description as string, schedule: body.schedule as string, prompt: body.prompt as string, thread_session_id: sessionId, profile: profileName(request) }) }); }
      catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 }); }
    });
    server.patch<{ Params: { profile: string; name: string } }>("/api/profiles/:profile/pulses/:name", async (request, reply) => {
      if (!guard(request, reply)) return;
      const enabled = objectBody(request.body).enabled; if (typeof enabled !== "boolean") throw Object.assign(new Error("The 'enabled' field must be a boolean."), { status: 400 });
      try { return { pulse: api.pulses.setEnabled(request.params.name, enabled, profileName(request)) }; } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 404 }); }
    });
    server.put<{ Params: { profile: string; name: string } }>("/api/profiles/:profile/pulses/:name", async (request, reply) => {
      if (!guard(request, reply)) return;
      const body = objectBody(request.body), fields = ["description", "schedule", "prompt"] as const;
      for (const field of fields) if (typeof body[field] !== "string" || !String(body[field]).trim()) throw Object.assign(new Error(`The '${field}' field must be a non-empty string.`), { status: 400 });
      const sessionId = typeof body.thread_session_id === "string" ? body.thread_session_id : "";
      if (sessionId && !(await api.listSessions(profileName(request))).some((session) => session.id === sessionId)) throw Object.assign(new Error("The thread_session_id session was not found."), { status: 404 });
      try { return { pulse: api.pulses.update(request.params.name, profileName(request), { description: body.description as string, schedule: body.schedule as string, prompt: body.prompt as string, thread_session_id: sessionId }) }; }
      catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 }); }
    });
    server.delete<{ Params: { profile: string; name: string } }>("/api/profiles/:profile/pulses/:name", async (request, reply) => {
      if (!guard(request, reply)) return;
      try { api.pulses.delete(request.params.name, profileName(request)); return reply.code(204).send(); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 404 }); }
    });

    server.get("/api/skill-sources", async (request, reply) => { if (!guard(request, reply)) return; return { sources: api.skillSources.list() }; });
    server.post("/api/skill-sources", async (request, reply) => { if (!guard(request, reply)) return; const body=objectBody(request.body); if (typeof body.name !== "string" || typeof body.repoUrl !== "string") throw Object.assign(new Error("name and repoUrl are required."),{status:400}); const identifier=typeof body.identifier === "string" && body.identifier ? body.identifier : skillSourceIdentifier(body.name); if (typeof body.originalIdentifier === "string" && body.originalIdentifier && body.originalIdentifier !== identifier) await api.skillSources.rename(body.originalIdentifier, identifier); return reply.code(201).send({ source: api.skillSources.save({ identifier,name:body.name,repoUrl:body.repoUrl,branch:typeof body.branch === "string" ? body.branch : undefined,basePath:typeof body.basePath === "string" ? body.basePath : undefined,username:typeof body.username === "string" ? body.username : undefined,accessToken:typeof body.accessToken === "string" && body.accessToken ? body.accessToken : undefined,enabled:body.enabled !== false }) }); });
    server.patch<{ Params: { identifier: string } }>("/api/skill-sources/:identifier", async (request, reply) => { if (!guard(request, reply)) return; const current=api.skillSources.get(request.params.identifier); if (!current) throw Object.assign(new Error("Skill Source not found."),{status:404}); const body=objectBody(request.body); return { source:api.skillSources.save({ ...current, identifier:current.identifier, name:typeof body.name === "string" ? body.name : current.name, repoUrl:typeof body.repoUrl === "string" ? body.repoUrl : current.repoUrl, branch:typeof body.branch === "string" ? body.branch : current.branch, basePath:typeof body.basePath === "string" ? body.basePath : current.basePath, username:typeof body.username === "string" ? body.username : current.username ?? undefined,accessToken:typeof body.accessToken === "string" && body.accessToken ? body.accessToken : undefined, enabled:typeof body.enabled === "boolean" ? body.enabled : current.enabled }) }; });
    server.delete<{ Params: { identifier: string } }>("/api/skill-sources/:identifier", async (request, reply) => { if (!guard(request, reply)) return; await api.skillSources.remove(request.params.identifier); return reply.code(204).send(); });
    server.post<{ Params: { identifier: string } }>("/api/skill-sources/:identifier/sync", async (request, reply) => { if (!guard(request, reply)) return; return { sync:await api.skillSources.sync(request.params.identifier) }; });
    server.get<{ Params: { identifier: string } }>("/api/skill-sources/:identifier/skills", async (request, reply) => { if (!guard(request, reply)) return; return { skills:api.skillSources.skills(request.params.identifier) }; });
    server.get<{ Params: { identifier: string; name: string } }>("/api/skill-sources/:identifier/skills/:name/document", async (request, reply) => { if (!guard(request, reply)) return; return api.skillSources.document(request.params.identifier, request.params.name); });
    server.post<{ Params: { profile: string; identifier: string; name: string } }>("/api/profiles/:profile/skills/from-source/:identifier/:name", async (request, reply) => { if (!guard(request, reply)) return; const profile=profileName(request); await api.profiles.readSettings(profile); const destination=api.profiles.skillImportDirectory(profile); const skill=await api.skillSources.install(request.params.identifier,request.params.name,destination,profile); await api.profiles.refreshSkills(profile); return reply.code(201).send({ skill, destination }); });
    server.post<{ Params: { profile: string; name: string }; Querystring: { source?: string } }>("/api/profiles/:profile/skills/:name/publish", async (request, reply) => { if (!guard(request, reply)) return; const profile=profileName(request), body=objectBody(request.body), source=skillSource(request.query.source); if (typeof body.identifier !== "string" || !body.identifier) throw Object.assign(new Error("A Skill Source is required."), { status: 400 }); const skill=await api.profiles.resource(profile, "skills", request.params.name, source); if (!skill.path) throw Object.assign(new Error("Skill path is not available."), { status: 404 }); if (source === "shared" && profile !== "default") throw Object.assign(new Error("Shared Skills can only be published by the default profile."), { status: 403 }); const publication=await api.skillSources.publish(body.identifier, profile, request.params.name, skill.path); await api.profiles.refreshSkills(profile); return reply.code(publication.action === "created" ? 201 : 200).send({ publication }); });
    server.post<{ Params: { profile: string; name: string }; Querystring: { source?: string } }>("/api/profiles/:profile/skills/:name/sync", async (request, reply) => { if (!guard(request, reply)) return; const profile=profileName(request), source=skillSource(request.query.source), skill=await api.profiles.resource(profile, "skills", request.params.name, source); if (!skill.path) throw Object.assign(new Error("Skill path is not available."), { status: 404 }); const synchronization=await api.skillSources.syncInstallation(profile, request.params.name, skill.path); await api.profiles.refreshSkills(profile); return { synchronization }; });

    const skillSource = (value: unknown): "shared" | "profile" | undefined => {
      if (value === undefined) return undefined;
      if (value === "shared" || value === "profile") return value;
      throw Object.assign(new Error("Invalid skill source."), { status: 400 });
    };
    server.get<{ Params: { profile: string } }>("/api/profiles/:profile/skills/sources", async (request, reply) => {
      if (!guard(request, reply)) return;
      return { sources: await api.profiles.readSkillSources(profileName(request)) };
    });
    server.put<{ Params: { profile: string } }>("/api/profiles/:profile/skills/sources", async (request, reply) => {
      if (!guard(request, reply)) return;
      const sources = objectBody(request.body);
      return { sources: await api.profiles.writeSkillSources(profileName(request), { shared: sources.shared as boolean, profile: sources.profile as boolean }) };
    });
    server.get<{ Params: { profile: string; name: string }; Querystring: { source?: string } }>("/api/profiles/:profile/skills/:name/document", async (request, reply) => {
      if (!guard(request, reply)) return;
      return api.profiles.readSkillDocument(profileName(request), request.params.name, skillSource(request.query.source));
    });

    server.get<{ Params: { profile: string } }>("/api/profiles/:profile/packages", async (request, reply) => {
      if (!guard(request, reply)) return;
      return { packages: await api.profiles.packages(profileName(request)) };
    });
    server.patch<{ Params: { profile: string; name: string }; Body: { enabled?: unknown } }>("/api/profiles/:profile/packages/:name", async (request, reply) => {
      if (!guard(request, reply)) return;
      if (typeof request.body?.enabled !== "boolean") return reply.code(400).send({ error: "'enabled' must be a boolean." });
      return { package: await api.profiles.setPackage(profileName(request), decodeURIComponent(request.params.name), request.body.enabled) };
    });

    server.get<{ Params: { profile: string; kind: string } }>("/api/profiles/:profile/resources/:kind", async (request, reply) => {
      if (!guard(request, reply)) return;
      const kind = resourceKind(request.params.kind);
      if (kind === "tools") await api.discoverExtensionTools(profileName(request)).catch(() => {});
      return { resources: await api.profiles.resources(profileName(request), kind) };
    });
    server.get<{ Params: { profile: string; kind: string; name: string }; Querystring: { source?: string } }>("/api/profiles/:profile/resources/:kind/:name", async (request, reply) => {
      if (!guard(request, reply)) return;
      const kind = resourceKind(request.params.kind);
      if (kind === "tools") await api.discoverExtensionTools(profileName(request));
      return api.profiles.resource(profileName(request), kind, request.params.name, kind === "skills" ? skillSource(request.query.source) : undefined);
    });
    server.patch<{ Params: { profile: string; kind: string; name: string }; Querystring: { source?: string } }>("/api/profiles/:profile/resources/:kind/:name", async (request, reply) => {
      if (!guard(request, reply)) return;
      const kind = resourceKind(request.params.kind);
      if (kind === "tools") await api.discoverExtensionTools(profileName(request));
      const enabled = objectBody(request.body).enabled;
      if (typeof enabled !== "boolean") throw Object.assign(new Error("The 'enabled' field must be a boolean."), { status: 400 });
      return api.profiles.setResource(profileName(request), kind, request.params.name, enabled, kind === "skills" ? skillSource(request.query.source) : undefined);
    });

    server.delete<{ Params: { profile: string; kind: string; name: string }; Querystring: { source?: string } }>("/api/profiles/:profile/resources/:kind/:name", async (request, reply) => {
      if (!guard(request, reply)) return;
      const kind = resourceKind(request.params.kind);
      if (kind !== "skills") throw Object.assign(new Error("Only Skills can be deleted from a profile."), { status: 405 });
      const profile = profileName(request);
      await api.profiles.deleteSkill(profile, request.params.name, skillSource(request.query.source));
      api.skillSources.forgetInstallation(profile, request.params.name);
      return reply.code(204).send();
    });

    const applicationStore = api.applications;
    const applicationsRoot = join(options.agentDir, "applications");
    const applicationBySlug = new Map<string, { record: ApplicationRecord; runtime: ApplicationRuntime }>();
    const applicationSettings = (record: ApplicationRecord): ApplicationSettings => ({ ...record.settings, responseMode: record.responseMode, defaultProfile: record.defaultProfile }) as ApplicationSettings;
    const ensureApplicationFiles = async (slug: string) => { const handlers = join(applicationsRoot, slug, "handlers"); await mkdir(join(handlers, "transforms"), { recursive: true }); await mkdir(join(handlers, "context-memory"), { recursive: true }); const inbound = join(handlers, "inbound.ts"); if (!existsSync(inbound)) await writeFile(inbound, applicationHandlerTemplate("inbound"), "utf8"); };
    const loadApplication = async (record: ApplicationRecord) => { const directory = join(applicationsRoot, record.slug); await ensureApplicationFiles(record.slug); const runtime = await ApplicationRuntime.load(directory, api, applicationSettings(record), async (settings) => { const saved = applicationStore.update(record.slug, { settings, responseMode: settings.responseMode, defaultProfile: settings.defaultProfile ?? null }); applicationBySlug.set(saved.slug, { record: saved, runtime }); }, record); applicationBySlug.set(record.slug, { record, runtime }); };
    for (const record of applicationStore.list()) await loadApplication(record);
    const registeredApplication = (slug: string) => { const application = applicationBySlug.get(slug); if (!application) throw Object.assign(new Error("Application not found."), { status: 404 }); return application; };
    const handlerFiles = async (directory: string, prefix = ""): Promise<string[]> => { const entries = await readdir(directory, { withFileTypes: true }); const files: string[] = []; for (const entry of entries) { const path = join(directory, entry.name), name = `${prefix}${entry.name}`; if (entry.isDirectory()) files.push(...await handlerFiles(path, `${name}/`)); else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(name); } return files; };
    const applicationHandlerPath = (slug: string, file: unknown) => {
      if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./-]*\.ts$/.test(file) || file.includes("..")) throw Object.assign(new Error("Invalid handler path."), { status: 400 });
      return join(applicationsRoot, slug, "handlers", file);
    };
    const handlerTestPayloads = (settings: Record<string, unknown>): Record<string, unknown> => {
      const value = settings.handlerTestPayloads;
      return value && typeof value === "object" && !Array.isArray(value) ? { ...value as Record<string, unknown> } : {};
    };
    const updateApplicationSettings = (application: { record: ApplicationRecord }, settings: Record<string, unknown>) => applicationStore.update(application.record.slug, {
      name: application.record.name,
      enabled: application.record.enabled,
      responseMode: application.record.responseMode,
      defaultProfile: application.record.defaultProfile,
      routingPolicy: application.record.routingPolicy,
      settings,
    });
    server.get("/api/applications", async (request, reply) => { if (!guard(request, reply)) return; return { applications: applicationStore.list().map((record) => ({ ...record, mappingCount: Object.keys((record.settings as any).mappings?.remoteJid ?? {}).length })) }; });
    server.post("/api/applications", async (request, reply) => {
      if (!guard(request, reply)) return; const body = objectBody(request.body);
      if (typeof body.name !== "string" || typeof body.slug !== "string") throw Object.assign(new Error("name and slug are required."), { status: 400 });
      const responseMode = body.responseMode === "result" ? "result" : "ack"; const defaults: ApplicationSettings = { responseMode, inboundHandler: "inbound", transformHandlers: [] }; const record = applicationStore.create({ name: body.name, slug: body.slug, enabled: body.enabled !== false, responseMode, defaultProfile: typeof body.defaultProfile === "string" && body.defaultProfile ? body.defaultProfile : null, routingPolicy: body.routingPolicy === "drop" ? "drop" : "default_as_fallback", settings: body.settings && typeof body.settings === "object" && !Array.isArray(body.settings) ? body.settings as Record<string, unknown> : defaults });
      await loadApplication(record); return reply.code(201).send({ application: record });
    });
    server.get<{ Params: { slug: string } }>("/api/applications/:slug", async (request, reply) => { if (!guard(request, reply)) return; return { application: registeredApplication(request.params.slug).record }; });
    server.put<{ Params: { slug: string } }>("/api/applications/:slug", async (request, reply) => {
      if (!guard(request, reply)) return; const current = registeredApplication(request.params.slug).record, body = objectBody(request.body);
      const record = applicationStore.update(current.slug, { name: typeof body.name === "string" ? body.name : current.name, enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled, responseMode: body.responseMode === "result" || body.responseMode === "ack" ? body.responseMode : current.responseMode, defaultProfile: typeof body.defaultProfile === "string" ? body.defaultProfile || null : current.defaultProfile, routingPolicy: body.routingPolicy === "drop" || body.routingPolicy === "default_as_fallback" ? body.routingPolicy : current.routingPolicy, settings: body.settings && typeof body.settings === "object" && !Array.isArray(body.settings) ? body.settings as Record<string, unknown> : current.settings });
      await loadApplication(record); return { application: record };
    });
    server.delete<{ Params: { slug: string } }>("/api/applications/:slug", async (request, reply) => { if (!guard(request, reply)) return; applicationStore.delete(request.params.slug); applicationBySlug.delete(request.params.slug); await rm(join(applicationsRoot, request.params.slug), { recursive: true, force: true }); return reply.code(204).send(); });
    server.get<{ Params: { slug: string } }>("/api/applications/:slug/identity-mappings", async (request, reply) => { if (!guard(request, reply)) return; registeredApplication(request.params.slug); return { mappings: applicationStore.identityMappings(request.params.slug) }; });
    server.put<{ Params: { slug: string; identityKey: string } }>("/api/applications/:slug/identity-mappings/:identityKey", async (request, reply) => { if (!guard(request, reply)) return; registeredApplication(request.params.slug); const body = objectBody(request.body), previousIdentityKey = request.params.identityKey, identityKey = typeof body.identityKey === "string" ? body.identityKey.trim() : previousIdentityKey, automatic = identityKey === "*" || body.sessionMode === "automatic", prefix = automatic ? null : body.sessionPrefix; if (identityKey === "*" && identityKey !== previousIdentityKey && applicationStore.identityMapping(request.params.slug, "*")) throw Object.assign(new Error("Only one wildcard (*) Identity Key mapping is allowed per Application."), { status: 409 }); if (!identityKey || typeof body.profile !== "string" || !body.profile || (!automatic && typeof prefix !== "string")) throw Object.assign(new Error("profile and a fixed sessionPrefix are required."), { status: 400 }); if (typeof prefix === "string" && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(prefix)) throw Object.assign(new Error("Invalid sessionPrefix."), { status: 400 }); await api.profiles.readSettings(body.profile); return { mapping: typeof body.previousIdentityKey === "string" ? applicationStore.renameIdentityMapping(request.params.slug, previousIdentityKey, identityKey, body.profile, automatic ? "automatic" : "fixed", automatic ? null : prefix) : applicationStore.saveIdentityMapping(request.params.slug, identityKey, body.profile, automatic ? "automatic" : "fixed", automatic ? null : prefix) }; });
    server.delete<{ Params: { slug: string; identityKey: string } }>("/api/applications/:slug/identity-mappings/:identityKey", async (request, reply) => { if (!guard(request, reply)) return; try { applicationStore.deleteIdentityMapping(request.params.slug, request.params.identityKey); return reply.code(204).send(); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 404 }); } });
    server.get<{ Querystring: { profile?: string; application?: string; identityKey?: string; prefix?: string; session?: string } }>("/api/application-sessions", async (request, reply) => { if (!guard(request, reply)) return; const filters = request.query; return { sessions: applicationStore.activeSessions(filters) }; });
    server.delete<{ Params: { sessionId: string }; Querystring: { application?: string; profile?: string } }>("/api/application-sessions/:sessionId", async (request, reply) => { if (!guard(request, reply)) return; const { application, profile } = request.query; if (!application || !profile) throw Object.assign(new Error("application and profile are required."), { status: 400 }); applicationStore.removeActiveSession(application, profile, request.params.sessionId); return reply.code(204).send(); });
    server.get<{ Params: { slug: string } }>("/api/applications/:slug/handlers", async (request, reply) => { if (!guard(request, reply)) return; registeredApplication(request.params.slug); return { files: await handlerFiles(join(applicationsRoot, request.params.slug, "handlers")) }; });
    server.get<{ Params: { slug: string }; Querystring: { path?: string } }>("/api/applications/:slug/handler", async (request, reply) => { if (!guard(request, reply)) return; const application = registeredApplication(request.params.slug); const path = applicationHandlerPath(request.params.slug, request.query.path), file = String(request.query.path); return { path: request.query.path, content: await readFile(path, "utf8"), testPayload: handlerTestPayloads(application.record.settings)[file] }; });
    server.put<{ Params: { slug: string }; Querystring: { path?: string } }>("/api/applications/:slug/handler", async (request, reply) => { if (!guard(request, reply)) return; registeredApplication(request.params.slug); const content = objectBody(request.body).content; if (typeof content !== "string") throw Object.assign(new Error("content must be a string."), { status: 400 }); const path = applicationHandlerPath(request.params.slug, request.query.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content, "utf8"); return { ok: true }; });
    server.patch<{ Params: { slug: string }; Querystring: { path?: string } }>("/api/applications/:slug/handler", async (request, reply) => { if (!guard(request, reply)) return; const application = registeredApplication(request.params.slug), oldPath = applicationHandlerPath(request.params.slug, request.query.path), newFile = objectBody(request.body).newPath; const newPath = applicationHandlerPath(request.params.slug, newFile); if (dirname(oldPath) !== dirname(newPath)) throw Object.assign(new Error("Handlers must remain in their current folder."), { status: 400 }); if (existsSync(newPath)) throw Object.assign(new Error("A handler with this name already exists."), { status: 409 }); await rename(oldPath, newPath); const oldFile = String(request.query.path), oldName = oldFile.replace(/^transforms\//, "").replace(/\.ts$/, ""), newName = String(newFile).replace(/^transforms\//, "").replace(/\.ts$/, ""), settings = structuredClone(application.record.settings) as ApplicationSettings & Record<string, unknown>, testPayloads = handlerTestPayloads(settings); if (oldFile in testPayloads) { testPayloads[String(newFile)] = testPayloads[oldFile]; delete testPayloads[oldFile]; } settings.handlerTestPayloads = testPayloads; if (settings.inboundHandler === oldName) settings.inboundHandler = newName; if (settings.outboundHandler === oldName) settings.outboundHandler = newName; settings.transformHandlers = settings.transformHandlers?.map((value) => value === oldName ? newName : value); const record = updateApplicationSettings(application, settings); await loadApplication(record); return { ok: true, path: newFile, settingsUpdated: true }; });
    server.delete<{ Params: { slug: string }; Querystring: { path?: string } }>("/api/applications/:slug/handler", async (request, reply) => { if (!guard(request, reply)) return; const application = registeredApplication(request.params.slug), path = applicationHandlerPath(request.params.slug, request.query.path), file = String(request.query.path), handlerName = file.replace(/^transforms\//, "").replace(/\.ts$/, ""), settings = structuredClone(application.record.settings) as ApplicationSettings & Record<string, unknown>; if (settings.inboundHandler === handlerName || settings.outboundHandler === handlerName || settings.transformHandlers?.includes(handlerName)) throw Object.assign(new Error("This handler is active in Application Settings."), { status: 409 }); await rm(path); const testPayloads = handlerTestPayloads(settings); if (file in testPayloads) { delete testPayloads[file]; settings.handlerTestPayloads = testPayloads; const record = updateApplicationSettings(application, settings); applicationBySlug.set(record.slug, { record, runtime: application.runtime }); } return reply.code(204).send(); });
    server.post<{ Params: { slug: string }; Querystring: { path?: string } }>("/api/applications/:slug/handler/test",  async (request, reply) => { if (!guard(request, reply)) return; const application = registeredApplication(request.params.slug); const body = objectBody(request.body); if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) throw Object.assign(new Error("The 'payload' field must be a JSON object."), { status: 400 }); applicationHandlerPath(request.params.slug, request.query.path); const settings = structuredClone(application.record.settings) as Record<string, unknown>, testPayloads = handlerTestPayloads(settings); testPayloads[String(request.query.path)] = body.payload; settings.handlerTestPayloads = testPayloads; const record = updateApplicationSettings(application, settings); applicationBySlug.set(record.slug, { record, runtime: application.runtime }); return application.runtime.testHandler(applicationHandlerPath(request.params.slug, request.query.path), body.payload as Record<string, unknown>, typeof body.content === "string" ? body.content : undefined); });
    server.get<{ Params: { slug: string } }>("/api/applications/:slug/logs", async (request, reply) => { if (!guard(request, reply)) return; return { calls: registeredApplication(request.params.slug).runtime.logs.list() }; });
    server.delete<{ Params: { slug: string } }>("/api/applications/:slug/logs", async (request, reply) => { if (!guard(request, reply)) return; await registeredApplication(request.params.slug).runtime.logs.clear(); return reply.code(204).send(); });
    server.post<{ Params: { slug: string } }>("/api/applications/:slug/logs/ticket", async (request, reply) => { if (!guard(request, reply)) return; const application = registeredApplication(request.params.slug), ticket = randomUUID(); applicationLogTickets.set(ticket, { slug: application.record.slug, expiresAt: Date.now() + 60_000 }); const base = new URL(config.publicBaseUrl ?? `http://127.0.0.1:${config.port}`); base.protocol = base.protocol === "https:" ? "wss:" : "ws:"; base.pathname = `/api/applications/${encodeURIComponent(application.record.slug)}/logs/stream`; base.search = `ticket=${encodeURIComponent(ticket)}`; return { ticket, url: base.toString() }; });
    server.get("/api/applications/:slug/logs/stream", { websocket: true }, (socket, request) => { const ticket = (request.query as { ticket?: string }).ticket; const value = ticket && applicationLogTickets.get(ticket); if (!value || value.slug !== (request.params as { slug: string }).slug || value.expiresAt < Date.now()) return socket.close(1008, "Invalid ticket"); applicationLogTickets.delete(ticket!); const unsubscribe = registeredApplication(value.slug).runtime.logs.on((event) => socket.send(JSON.stringify(event))); socket.on("close", unsubscribe); });
    server.post("/api/terminal/ticket", async (request, reply) => { if (!guard(request, reply)) return; if (!terminalEnabled) throw Object.assign(new Error("Console terminal is disabled."), { status: 403 }); const ticket = randomUUID(); terminalTickets.set(ticket, { expiresAt: Date.now() + 30_000 }); return { url: terminalUrl(ticket), cwd: terminalCwd }; });
    server.get("/api/terminal/stream", { websocket: true }, (socket, request) => { const ticket = (request.query as { ticket?: string }).ticket; const value = ticket && terminalTickets.get(ticket); if (!terminalEnabled || !value || value.expiresAt < Date.now()) return socket.close(1008, "Invalid ticket"); terminalTickets.delete(ticket!); let child: pty.IPty; try { child = pty.spawn(terminalShell, ["-l"], { name: "xterm-256color", cols: 80, rows: 24, cwd: terminalCwd, env: process.env }); } catch (error) { socket.send(JSON.stringify({ type: "error", data: (error as Error).message })); return socket.close(1011); } const send = (type: string, data: string) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type, data })); }; child.onData((data) => send("output", data)); child.onExit(() => socket.close()); socket.on("message", (raw) => { try { const message = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number }; if (message.type === "input" && typeof message.data === "string") child.write(message.data); if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols! > 0 && message.rows! > 0) child.resize(message.cols!, message.rows!); } catch { /* ignore malformed terminal messages */ } }); socket.on("close", () => child.kill()); });
    server.post<{ Params: { slug: string } }>("/api/applications/:slug/session-rollover", async (request, reply) => { if (!guard(request, reply)) return; return reply.code(201).send(await registeredApplication(request.params.slug).runtime.rollover(request.body)); });
    server.post<{ Params: { slug: string } }>("/api/message/app/:slug", async (request, reply) => {
      const application = registeredApplication(request.params.slug); if (!application.record.enabled) return apiError(reply, 404, "NOT_FOUND", "Application is disabled.");
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])); const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
      if (application.record.responseMode === "ack") { void application.runtime.process(request.body, headers, query).catch((error) => console.error(`[application:${application.record.slug}]`, error)); return reply.code(202).send({ ok: true, accepted: true }); }
      return application.runtime.process(request.body, headers, query);
    });

    server.setNotFoundHandler(async (request, reply) => {
      if (!authorized(request, config.apiToken)) return apiError(reply, 401, "UNAUTHORIZED", "Bearer token is missing or invalid.");
      return apiError(reply, 404, "NOT_FOUND", "Route not found.");
    });
    server.setErrorHandler(async (error, _request, reply) => {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return apiError(reply, 413, "BAD_REQUEST", "payload exceeds 1 MiB");
      const typed = error as Error & { status?: number };
      if (typed.status) return apiError(reply, typed.status, "BAD_REQUEST", typed.message);
      console.error("[pi-api]", error);
      return apiError(reply, 500, "INTERNAL_ERROR", "Internal API error.");
    });

    await server.listen({ port: config.port, host: config.host });
    return server;
  })();
  try { return await serverPromise; } catch (error) { serverPromise = undefined; throw error; }
}
