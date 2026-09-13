import { createJiti } from "jiti";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";
import { ApplicationLogStore } from "./application-log-store.ts";

type RecordValue = Record<string, any>;
export type Settings = { responseMode: "ack" | "result"; transformHandlers?: string[]; inboundHandler: string; outboundHandler?: string; defaultProfile?: string | null; messageCoalescing?: { enabled?: boolean; silenceDebounceSeconds?: number } };
type Handler = (payload: RecordValue, headers?: RecordValue | null, query?: RecordValue | null, context?: RecordValue | null, state?: RecordValue | null, env?: Record<string, string | undefined>) => Promise<any> | any;
type ApplicationApi = { agentSettings(): Promise<Record<string, unknown>>; listSessions(profile: string): Promise<Array<Record<string, unknown>>>; createSession(profile: string, input: unknown): Promise<Record<string, unknown>>; getSessionConversation(profile: string, sessionId: string): Promise<Record<string, unknown>>; complete(profile: string, prompt: string): Promise<string>; prompt(profile: string, sessionId: string, message: string, handoff?: string, applicationContext?: { application: string; identityKey: string }): Promise<{ profile: string; sessionId: string; response: string }>; getIdentityMapping(application: string, identityKey: string): Promise<{ profile: string; sessionMode: "fixed" | "automatic"; sessionPrefix: string | null } | undefined>; automaticApplicationSessionPrefix(application: string, identityKey: string): Promise<string>;  getApplicationSession(application: string, profile: string, prefix: string): Promise<{ sessionId: string } | undefined>; getActiveApplicationSession(application: string, profile: string, prefix: string): Promise<{ sessionId: string } | undefined>; nextApplicationSessionId(application: string, profile: string, prefix: string): Promise<string>; recordApplicationSession(application: string, profile: string, prefix: string, sessionId: string, rollover: boolean): Promise<void>; touchApplicationSession(application: string, profile: string, prefix: string, sessionId: string, from?: string): Promise<void>;  retargetPulseThreadSessions(profile: string, fromSessionId: string, toSessionId: string): Promise<void>; handlerEnvironment(profile: string): Promise<Record<string, string | undefined>> };
type Handoff = { sourceSessionId: string | null; summary: string; createdAt: string; targetCreatedAt: string };
type WorkingSession = { sessionId: string; updatedAt: string; reason: "message" | "rollover" };
export type ApplicationIdentity = { id: string; name: string; slug: string; enabled: boolean; responseMode: "ack" | "result"; defaultProfile: string | null; routingPolicy: "default_as_fallback" | "drop"; settings: Record<string, unknown> }; 

const safeName = (name: string) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
const day = () => new Date().toISOString().slice(0, 10);
const asRecord = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type TestLogs = { stdout: string[]; stderr: string[] };
const testConsoleLogs = new AsyncLocalStorage<TestLogs>();
let consoleCaptureInstalled = false;
const logValues = (values: unknown[]) => values.map((value) => typeof value === "string" ? value : inspect(value, { depth: 6, colors: false })).join(" ");
function installConsoleCapture(): void {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;
  for (const [method, stream] of [["log", "stdout"], ["info", "stdout"], ["debug", "stdout"], ["warn", "stderr"], ["error", "stderr"]] as const) {
    const original = console[method].bind(console);
    console[method] = (...values: any[]) => { const logs = testConsoleLogs.getStore(); if (logs) logs[stream].push(logValues(values)); else original(...values); };
  }
}

export class ApplicationRuntime {
  readonly name: string;
  readonly settings: Settings;
  private readonly jiti = createJiti(process.cwd(), { moduleCache: false, fsCache: false });
  private queues = new Map<string, Promise<void>>();

  readonly logs: ApplicationLogStore;
  constructor(readonly directory: string, settings: Settings, private readonly api: ApplicationApi, private readonly persistSettings: (settings: Settings) => Promise<void>, private readonly application: ApplicationIdentity) { this.name = application.slug; this.settings = settings; this.logs = new ApplicationLogStore(directory, this.name); }

  static async load(directory: string, api: ApplicationApi, settings: unknown, persistSettings: (settings: Settings) => Promise<void>, application: ApplicationIdentity): Promise<ApplicationRuntime> {
    validateApplicationSettings(settings);
    const runtime = new ApplicationRuntime(directory, settings, api, persistSettings, application); await runtime.logs.initialize(); return runtime;
  }

  async updateSettings(settings: Settings): Promise<void> {
    await this.persistSettings(settings);
    for (const key of Object.keys(this.settings)) delete (this.settings as Record<string, unknown>)[key];
    Object.assign(this.settings, settings);
  }

  private handler(kind: "inbound" | "outbound" | "transform", name: string): Handler {
    const path = kind === "transform" ? join(this.directory, "handlers", "transforms", `${name}.ts`) : join(this.directory, "handlers", `${name}.ts`);
    if (!existsSync(path)) throw new Error(`Handler not found: ${name}`);
    const loaded = this.jiti(path) as { handle?: Handler };
    if (typeof loaded.handle !== "function") throw new Error(`Handler "${name}" must export handle().`);
    return loaded.handle;
  }

  private profileFrom(value: unknown): string | undefined {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as RecordValue).profile === "string") return (value as RecordValue).profile;
    const mappings = (this.settings as any).mappings?.remoteJid as Record<string, { profile?: unknown }> | undefined;
    if (!mappings) return undefined;
    const pending: unknown[] = [value];
    const seen = new Set<object>();
    while (pending.length) {
      const current = pending.pop();
      if (typeof current === "string" && typeof mappings[current]?.profile === "string") return mappings[current].profile as string;
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) pending.push(...current);
      else pending.push(...Object.values(current));
    }
    return undefined;
  }

  private async environmentFor(...values: unknown[]): Promise<Record<string, string | undefined>> {
    const profile = values.map((value) => this.profileFrom(value)).find((value): value is string => Boolean(value)) ?? "default";
    return this.api.handlerEnvironment(profile);
  }

  private async withQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(key, previous.then(() => current));
    await previous;
    try { return await operation(); } finally { release(); if (this.queues.get(key) === current) this.queues.delete(key); }
  }

  private async resolveSession(profile: string, sessionPrefix: string): Promise<string> {
    if (!safeName(sessionPrefix)) throw Object.assign(new Error("Invalid sessionPrefix."), { status: 422 });
    return this.withQueue(`${this.application.slug}:${profile}:${sessionPrefix}:${day()}`, async () => {
      const current = await this.api.getApplicationSession(this.application.slug, profile, sessionPrefix); if (current) return current.sessionId;
      const id = await this.api.nextApplicationSessionId(this.application.slug, profile, sessionPrefix);
      await this.api.createSession(profile, { id }); await this.api.recordApplicationSession(this.application.slug, profile, sessionPrefix, id, false); return id;
    });
  }

  private handoffPath(profile: string, sessionId: string): string { return join(this.directory, "handoffs", profile, `${sessionId}.json`); }

  private async handoff(profile: string, sessionId: string, prefix: string | null | undefined, force = false): Promise<Handoff | undefined> {
    if (!prefix) return undefined;
    const path = this.handoffPath(profile, sessionId);
    const expression = new RegExp("^" + escapeRegExp(`${this.application.slug}_${prefix}`) + "_([0-9]{4}-[0-9]{2}-[0-9]{2})-([0-9]{2})$");
    const sessions = await this.api.listSessions(profile);
    const target = sessions.find((item) => item.id === sessionId);
    if (!target) return undefined;
    if (existsSync(path)) { const cached = JSON.parse(await readFile(path, "utf8")) as Handoff; if (cached.targetCreatedAt === String(target.createdAt)) return cached; }
    if (!force && Number(target?.messageCount ?? 0) > 0) return undefined;
    const prior = sessions.map((item) => ({ id: String(item.id), match: String(item.id).match(expression) })).filter((item): item is { id: string; match: RegExpMatchArray } => item.match !== null && item.id !== sessionId).sort((a, b) => `${b.match[1]}-${b.match[2]}`.localeCompare(`${a.match[1]}-${a.match[2]}`))[0];
    let summary = "";
    if (prior) {
      const conversation = await this.api.getSessionConversation(profile, prior.id);
      summary = await this.api.complete(profile, `Summarize this completed Application conversation for a future handoff. Return ONLY unresolved user-facing tasks, unanswered questions, promised follow-ups, and durable preferences that are necessary to continue them. Exclude completed work, casual discussion, speculation, and sensitive details that are not necessary. If nothing is pending, return exactly NONE.\n\nConversation:\n${JSON.stringify(conversation.entries ?? [])}`);
      if (/^\s*none\b/i.test(summary)) summary = "";
    }
    const value: Handoff = { sourceSessionId: prior?.id ?? null, summary, createdAt: new Date().toISOString(), targetCreatedAt: String(target.createdAt) };
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return value;
  }

  private async relevantHandoff(profile: string, sessionId: string, prefix: string | null | undefined, message: string): Promise<string | undefined> {
    const handoff = await this.handoff(profile, sessionId, prefix);
    if (!handoff?.summary) return undefined;
    const verdict = await this.api.complete(profile, `Reply with exactly YES or NO. Is the user message meaningfully related to any unresolved item in the handoff?\n\nHandoff:\n${handoff.summary}\n\nUser message:\n${message}`);
    return /^\s*yes\b/i.test(verdict) ? handoff.summary : undefined;
  }

  async testHandler(path: string, payload: RecordValue, content?: string): Promise<{ ok: boolean; output?: unknown; logs: { stdout: string[]; stderr: string[] }; durationMs: number; error?: string }> {
    const stdout: string[] = [], stderr: string[] = [];
    const started = performance.now();
    let temporaryPath: string | undefined;
    try {
      if (content !== undefined) {
        temporaryPath = join(dirname(path), `.pi-handler-test-${randomUUID()}.ts`);
        await writeFile(temporaryPath, content, "utf8");
      }
      const loaded = this.jiti(temporaryPath ?? path) as { handle?: Handler };
      if (typeof loaded.handle !== "function") throw new Error("Handler must export handle().");
      const context = { application: this.application, settings: await this.api.agentSettings(), request: { id: randomUUID(), headers: {}, query: {} }, test: true, log: { info: (...values: unknown[]) => stdout.push(logValues(values)), error: (...values: unknown[]) => stderr.push(logValues(values)) } };
      installConsoleCapture();
      const output = await testConsoleLogs.run({ stdout, stderr }, async () => loaded.handle(payload, {}, {}, context, {}, await this.environmentFor(payload)));
      return { ok: true, output, logs: { stdout, stderr }, durationMs: Math.round(performance.now() - started) };
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      stderr.push(message);
      return { ok: false, logs: { stdout, stderr }, durationMs: Math.round(performance.now() - started), error: message };
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  private async setWorkingSession(profile: string, _prefix: string, sessionId: string, _reason: WorkingSession["reason"]): Promise<void> {
    // The database is the authoritative active-session state. Pulses are retargeted by explicit rollover callers.
    void profile; void sessionId;
  }


  async rollover(input: unknown): Promise<RecordValue> {
    const body = asRecord(input); const profile = body.profile; const sessionPrefix = body.sessionPrefix ?? null;
    if (typeof profile !== "string" || !profile) throw Object.assign(new Error("The 'profile' field is required."), { status: 400 });
    if (typeof sessionPrefix !== "string" || !sessionPrefix) throw Object.assign(new Error("The 'sessionPrefix' field is required."), { status: 400 });
    if (!safeName(sessionPrefix)) throw Object.assign(new Error("Invalid sessionPrefix"), { status: 400 });
    return this.withQueue(`${this.application.slug}:${profile}:${sessionPrefix}:${day()}`, async () => {
      const previous = await this.api.getActiveApplicationSession(this.application.slug, profile, sessionPrefix); const sessionId = await this.api.nextApplicationSessionId(this.application.slug, profile, sessionPrefix);
      await this.api.createSession(profile, { id: sessionId }); await this.api.recordApplicationSession(this.application.slug, profile, sessionPrefix, sessionId, true); if (previous?.sessionId && previous.sessionId !== sessionId) await this.api.retargetPulseThreadSessions(profile, previous.sessionId, sessionId);
      try {
        const handoff = await this.handoff(profile, sessionId, sessionPrefix, true);
        return { profile, sessionId, messageCount: 0, handoff: { status: handoff?.summary ? "ready" : "none", sourceSessionId: handoff?.sourceSessionId ?? null } };
      } catch (error) {
        return { profile, sessionId, messageCount: 0, handoff: { status: "failed", sourceSessionId: null, error: error instanceof Error ? error.message : String(error) } };
      }
    });
  }

  async process(payload: unknown, headers: RecordValue, query: RecordValue): Promise<unknown> {
    const call = this.logs.start(payload, headers); let active: any; let current = asRecord(payload); let state: RecordValue = {};
    const context = { application: this.application, settings: await this.api.agentSettings(), request: { id: call.id, headers, query }, log: { info: (...values: unknown[]) => active?.stdout.push(values.map(String).join(" ")), error: (...values: unknown[]) => active?.stderr.push(values.map(String).join(" ")) } };
    const run = async (type: string, label: string, input: unknown, operation: () => Promise<any>) => { active = this.logs.stage(call, type, label, input); try { const output = await operation(); this.logs.complete(call, active, output); return output; } catch (error) { this.logs.fail(call, active, error); throw error; } finally { active = undefined; } };
    try {
      for (const name of this.settings.transformHandlers ?? []) { const result = await run("transform", `Transform: ${name}`, current, async () => this.handler("transform", name)(current, headers, query, context, state, await this.environmentFor(current, payload, query))); if (result && typeof result === "object" && "payload" in result) { current = asRecord(result.payload); state = { ...state, ...asRecord(result.state) }; } else current = asRecord(result); }
      const inbound = await run("inbound-handler", `Inbound handler: ${this.settings.inboundHandler}`, current, async () => this.handler("inbound", this.settings.inboundHandler)(current, headers, query, context, state, await this.environmentFor(current, payload, query)));
      const routed = asRecord(inbound); const hasIdentityKey = Object.prototype.hasOwnProperty.call(routed, "identityKey"); const identityKey = typeof routed.identityKey === "string" ? routed.identityKey.trim() : undefined; if (hasIdentityKey && !identityKey) throw Object.assign(new Error("identityKey must be a non-empty string when provided."), { status: 422 }); let profile: string | undefined, sessionPrefix: string | null | undefined; if (identityKey) { const mapped = await this.api.getIdentityMapping(this.application.slug, identityKey); if (!mapped) throw Object.assign(new Error("No Identity Key mapping was found for this Application."), { status: 422 }); profile = mapped.profile; sessionPrefix = mapped.sessionMode === "automatic" ? await this.api.automaticApplicationSessionPrefix(this.application.slug, identityKey) : mapped.sessionPrefix; if (!sessionPrefix) throw Object.assign(new Error("The Identity Key mapping has no session prefix."), { status: 422 }); } else { profile = typeof routed.profile === "string" && routed.profile.trim() ? routed.profile.trim() : undefined; sessionPrefix = typeof (routed.sessionPrefix ?? routed.session_prefix) === "string" ? String(routed.sessionPrefix ?? routed.session_prefix).trim() || undefined : undefined; if (!profile) throw Object.assign(new Error("Inbound must return profile when identityKey is not provided."), { status: 422 }); sessionPrefix ??= "default"; } if (!profile || !sessionPrefix) throw Object.assign(new Error("No Application route was resolved."), { status: 422 }); const message = asRecord(routed.payload).message; if (typeof message !== "string" || !message.trim()) throw Object.assign(new Error("The Application did not produce a text message."), { status: 422 }); state = { ...state, ...asRecord(routed.state) };
      const sessionId = await this.resolveSession(profile, sessionPrefix);
      let handoff: string | undefined;
      try { handoff = await run("handoff-relevance", "Handoff relevance", { profile, sessionId, message }, () => this.relevantHandoff(profile, sessionId, sessionPrefix, message)); }
      catch (error) { context.log.error("Handoff skipped:", error instanceof Error ? error.message : String(error)); }
      const result = await run("pi-agent", "Pi agent", { profile, sessionId, message, handoff: Boolean(handoff) }, () => this.api.prompt(profile, sessionId, message, handoff, identityKey ? { application: this.application.slug, identityKey } : undefined));
      await this.setWorkingSession(profile, sessionPrefix, sessionId, "message"); await this.api.touchApplicationSession(this.application.slug, profile, sessionPrefix, sessionId, identityKey);
      let output: unknown = result;
      if (this.settings.outboundHandler) {
        const outboundInput = { profile, sessionId, message: { content: result.response } };
        const handler = this.handler("outbound", this.settings.outboundHandler);
        output = await run("outbound-handler", `Outbound handler: ${this.settings.outboundHandler}`, outboundInput, async () => handler(outboundInput, headers, query, context, state, await this.api.handlerEnvironment(profile)));
      }
      this.logs.finish(call, output); return output;
    } catch (error) { if (call.status !== "error") this.logs.fail(call, undefined, error); throw error; }
  }
}

export function validateApplicationSettings(raw: unknown): asserts raw is Settings {
  const settings = raw as Settings;
  if (!settings || (settings.responseMode !== "ack" && settings.responseMode !== "result")) throw Object.assign(new Error("Invalid Application settings."), { status: 400 });
  if (!safeName(settings.inboundHandler)) throw Object.assign(new Error("Invalid inbound handler."), { status: 400 });
  if (settings.outboundHandler !== undefined && !safeName(settings.outboundHandler)) throw Object.assign(new Error("Invalid outbound handler."), { status: 400 });
  if (settings.transformHandlers !== undefined && (!Array.isArray(settings.transformHandlers) || settings.transformHandlers.some((name) => !safeName(name)))) throw Object.assign(new Error("Invalid transform handlers."), { status: 400 });
}

