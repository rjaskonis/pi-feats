import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { contextMemoryConfig, ensureDefaultProfileContextMemory, normalizeIdentity, resolveContextMemory, updateContextMemory } from "../extensions/lib/context-memory.ts";

test("new profiles default Context Memory to PROFILE.md without replacing an existing choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profile"); await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { model: "test" } }));
    await ensureDefaultProfileContextMemory(profile);
    assert.deepEqual(JSON.parse(await readFile(join(profile, "settings.json"), "utf8")).profile.contextMemory, { mode: "file", target: "profile" });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "identity" } } }));
    await ensureDefaultProfileContextMemory(profile);
    assert.deepEqual(JSON.parse(await readFile(join(profile, "settings.json"), "utf8")).profile.contextMemory, { mode: "file", target: "identity" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an explicit None choice survives session initialization and disables personal memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profiles", "support");
    await mkdir(join(profile, "context-memory"), { recursive: true });
    const settings = JSON.stringify({ profile: { contextMemory: { mode: "none" } } });
    await writeFile(join(profile, "settings.json"), settings);
    await writeFile(join(profile, "context-memory", "OPERATIONAL.md"), "Operational fact");
    await writeFile(join(profile, "context-memory", "PROFILE.md"), "Must not be included");
    assert.deepEqual(contextMemoryConfig({ mode: "none" }), { mode: "none" });
    assert.deepEqual(await ensureDefaultProfileContextMemory(profile), { mode: "none" });
    assert.equal(await readFile(join(profile, "settings.json"), "utf8"), settings);
    const memory = await resolveContextMemory(root, profile, { profile: "support" });
    assert.equal(memory.operational, "Operational fact");
    assert.equal(memory.personal, "");
    await assert.rejects(() => updateContextMemory(root, profile, { profile: "support" }, "read", "personal"), /disabled/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("personal target follows the configured profile memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profile"); await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "profile" } } }));
    const result = await updateContextMemory(root, profile, { profile: "profile" }, "replace", "personal", "Renne's daughter is Yasmin.");
    assert.equal(result.target, "profile");
    assert.equal((await resolveContextMemory(root, profile, { profile: "profile" })).personal, "Renne's daughter is Yasmin.");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identity paths are deterministic and do not expose the raw identity", () => {
  const value = normalizeIdentity("5519996034196@s.whatsapp.net");
  assert.equal(value, normalizeIdentity("5519996034196@s.whatsapp.net"));
  assert.match(value, /-[a-f0-9]{12}$/);
  assert.ok(!value.includes("@"));
});

test("identity mode has no fallback to PROFILE.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profiles", "support");
    await mkdir(join(profile, "context-memory"), { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "identity" } } }));
    await writeFile(join(profile, "context-memory", "OPERATIONAL.md"), "Operational fact");
    await writeFile(join(profile, "context-memory", "PROFILE.md"), "Must not leak");
    const memory = await resolveContextMemory(root, profile, { application: "assistant", identityKey: "person@example.com", profile: "support" });
    assert.equal(memory.operational, "Operational fact");
    assert.equal(memory.personal, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("direct Context Memory is transient and bypasses the configured personal source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profiles", "support");
    await mkdir(join(profile, "context-memory"), { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "profile" } } }));
    await writeFile(join(profile, "context-memory", "OPERATIONAL.md"), "Operational fact");
    await writeFile(join(profile, "context-memory", "PROFILE.md"), "Persistent profile fact");
    const memory = await resolveContextMemory(root, profile, { profile: "support", directContextMemory: "Request-only fact" });
    assert.equal(memory.operational, "Operational fact");
    assert.equal(memory.personal, "Request-only fact");
    assert.equal(await readFile(join(profile, "context-memory", "PROFILE.md"), "utf8"), "Persistent profile fact");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("updates are isolated to the current identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profiles", "support");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "identity" } } }));
    await updateContextMemory(root, profile, { application: "assistant", identityKey: "a@example.com", profile: "support" }, "insert", "personal", "Prefers Portuguese");
    const own = await resolveContextMemory(root, profile, { application: "assistant", identityKey: "a@example.com", profile: "support" });
    assert.equal(own.personal, "Prefers Portuguese");
    await assert.rejects(updateContextMemory(root, profile, { profile: "support" }, "read", "personal"), /requires an Application identity/);
    const other = await resolveContextMemory(root, profile, { application: "assistant", identityKey: "b@example.com", profile: "support" });
    assert.equal(other.personal, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reloaded handler modules share one console capture without crossing identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-handler-"));
  try {
    const profile = join(root, "profiles", "support"), handler = join(root, "applications", "assistant", "handlers", "context-memory");
    await mkdir(profile, { recursive: true }); await mkdir(handler, { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "handler", handler: "capture" } } }));
    await writeFile(join(handler, "capture.ts"), `export function resolveContextMemory(input) { console.log("memory", input.identityKey); return input.identityKey; }`);
    const load = () => createJiti(import.meta.url, { interopDefault: true, moduleCache: false })("../extensions/lib/context-memory.ts") as { resolveContextMemory: typeof resolveContextMemory };
    const first = await load().resolveContextMemory(root, profile, { application: "assistant", identityKey: "alice", profile: "support" });
    const wrapper = console.log;
    const second = await load().resolveContextMemory(root, profile, { application: "assistant", identityKey: "bob", profile: "support" });
    assert.equal(console.log, wrapper, "reloading must not retain another wrapper closure");
    assert.equal(first.personal, "alice"); assert.equal(second.personal, "bob");
    assert.deepEqual(first.handlerExecution?.stdout, ["memory alice"]);
    assert.deepEqual(second.handlerExecution?.stdout, ["memory bob"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("timed-out custom handlers mark resident workers unsafe for another identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-timeout-"));
  const oldWorker = process.env.PI_PROFILE_WORKER, oldRetire = process.env.PI_PROFILE_WORKER_RETIRE;
  const key = Symbol.for("pi-feats.test.handler-release");
  try {
    const profile = join(root, "profiles", "support"), handler = join(root, "applications", "assistant", "handlers", "context-memory");
    await mkdir(profile, { recursive: true }); await mkdir(handler, { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "handler", handler: "pending" } } }));
    await writeFile(join(handler, "pending.ts"), `export function resolveContextMemory() { return new Promise(resolve => { globalThis[Symbol.for("pi-feats.test.handler-release")] = resolve; }); }`);
    process.env.PI_PROFILE_WORKER = "1"; delete process.env.PI_PROFILE_WORKER_RETIRE;
    const memory = await resolveContextMemory(root, profile, { application: "assistant", identityKey: "alice", profile: "support" });
    assert.equal(memory.personal, ""); assert.match(memory.handlerExecution?.error ?? "", /timed out/);
    assert.equal(process.env.PI_PROFILE_WORKER_RETIRE, "1");
  } finally {
    (Reflect.get(globalThis, key) as (() => void) | undefined)?.(); Reflect.deleteProperty(globalThis, key);
    if (oldWorker === undefined) delete process.env.PI_PROFILE_WORKER; else process.env.PI_PROFILE_WORKER = oldWorker;
    if (oldRetire === undefined) delete process.env.PI_PROFILE_WORKER_RETIRE; else process.env.PI_PROFILE_WORKER_RETIRE = oldRetire;
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces character limits before writing Context Memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-memory-"));
  try {
    const profile = join(root, "profiles", "support");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "settings.json"), JSON.stringify({ profile: { contextMemory: { mode: "file", target: "profile" } } }));
    const context = { profile: "support" };
    const exact = await updateContextMemory(root, profile, context, "replace", "personal", "a".repeat(1375));
    assert.equal(exact.used, 1375);
    await assert.rejects(() => updateContextMemory(root, profile, context, "insert", "personal", "b"), /1375-character limit/);
    const read = await updateContextMemory(root, profile, context, "read", "personal");
    assert.equal(read.used, 1375);
  } finally { await rm(root, { recursive: true, force: true }); }
});
