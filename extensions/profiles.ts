import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, render, Text } from "ink";
import React from "react";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ensureNonoAvailable, ensureProfileSandbox, isSandboxEnabled, migrateLegacySandboxRuntime, sandboxedCommand } from "./lib/profile-sandbox.ts";
import { profileEnvironment } from "./lib/profile-env.ts";
import { handleRemoteCli, REMOTE_COMMAND_NAMES } from "./lib/remote-hosts.ts";

type ProfilePolicy = {
  enabledTools?: string[];
  enabledSkills?: string[];
  enabledProfileSkills?: string[];
  enabledExtensions?: string[];
  skillSources?: { shared?: boolean; profile?: boolean };
};

type ProfileSettings = Record<string, unknown> & { profile?: ProfilePolicy };

const defaultAgentDir = join(homedir(), ".pi", "agent");
const rootAgentDir = () => process.env.PI_PROFILE_ROOT ?? defaultAgentDir;
const profilesDir = () => join(rootAgentDir(), "profiles");
const profileDir = (name: string) => join(profilesDir(), name);
const validProfileName = (name: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
const reservedProfileNames = new Set([
  "add", "create", "delete", "disable", "enable", "extensions", "guardrails", "list", "open", "packages", "profile", "pulse", "remove", "rename", "resume", "sessions", "skills", "tools", "validate",
  ...REMOTE_COMMAND_NAMES,
]);

function fail(message: string): never {
  process.stderr.write(`Profile error: ${message}\n`);
  process.exit(1);
}

type GuardrailRow = { name: string; stage: string; mode: string; order: number; file: string; enabled?: boolean };

async function renderGuardrailTable(guardrails: GuardrailRow[]): Promise<void> {
  const columns: Array<[string, number]> = [["STATUS", 8], ["STAGE", 8], ["ORDER", 5], ["MODE", 9], ["NAME", 13], ["FILE", 18]];
  const clip = (value: string, width: number) => value.length <= width ? value : `${value.slice(0, width - 1)}…`;
  const cell = (value: string, width: number) => clip(value, width).padEnd(width);
  const line = `┼${columns.map(([, width]) => "─".repeat(width + 2)).join("┼")}┼`;
  const top = line.replaceAll("┼", "┬").replace(/^┬/, "┌").replace(/┬$/, "┐");
  const bottom = line.replaceAll("┼", "┴").replace(/^┴/, "└").replace(/┴$/, "┘");
  const row = (values: string[]) => `│ ${values.map((value, index) => cell(value, columns[index][1])).join(" │ ")} │`;
  const entries = guardrails.length
    ? guardrails.sort((a, b) => a.stage.localeCompare(b.stage) || a.order - b.order || a.name.localeCompare(b.name)).map((guardrail) => React.createElement(Text, { key: guardrail.name, color: guardrail.enabled === false ? "gray" : "white" }, row([guardrail.enabled === false ? "disabled" : "enabled", guardrail.stage, String(guardrail.order), guardrail.mode, guardrail.name, guardrail.file])))
    : [React.createElement(Text, { key: "empty", color: "gray" }, row(["—", "—", "—", "—", "No guardrails configured", "—"]))];
  const app = render(React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { color: "gray" }, top),
    React.createElement(Text, { color: "cyan", bold: true }, row(columns.map(([name]) => name))),
    React.createElement(Text, { color: "gray" }, line),
    ...entries,
    React.createElement(Text, { color: "gray" }, bottom),
  ), { stdout: process.stdout, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false });
  await new Promise((resolveRender) => setTimeout(resolveRender, 25));
  app.unmount();
}

async function handleGuardrailsCli(profile: string, args: string[]): Promise<void> {
  const directory = profile === "default" ? rootAgentDir() : profileDir(profile);
  const configPath = join(directory, "guardrails.json");
  let config: { guardrails: GuardrailRow[] };
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { fail(`could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(config.guardrails)) fail(`${configPath} must contain a guardrails array.`);
  const action = args[1] ?? "list";
  if (action === "list") return renderGuardrailTable(config.guardrails);
  if (action === "validate") {
    for (const guardrail of config.guardrails) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(guardrail.name) || !["input", "pre_tool", "post_tool", "output"].includes(guardrail.stage) || !["transform", "evaluate", "reflect"].includes(guardrail.mode) || !Number.isInteger(guardrail.order) || basename(guardrail.file) !== guardrail.file || !guardrail.file.endsWith(".md")) fail(`invalid guardrail '${guardrail.name}'.`);
      if (!existsSync(join(rootAgentDir(), "guardrails", guardrail.file))) fail(`guardrail prompt does not exist: ${guardrail.file}`);
    }
    return writeStdout("Guardrails are valid.\n");
  }
  if (action !== "enable" && action !== "disable") fail("usage: pi guardrails list | enable <name> | disable <name> | validate");
  const name = args[2];
  const guardrail = config.guardrails.find((item) => item.name === name);
  if (!guardrail) fail(`guardrail '${name ?? ""}' is not configured.`);
  guardrail.enabled = action === "enable";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeStdout(`Guardrail '${guardrail.name}' ${action}d.\n`);
}

async function writeStdout(text: string) {
  await new Promise<void>((resolveWrite, reject) => {
    process.stdout.write(text, (error) => error ? reject(error) : resolveWrite());
  });
}

async function readJson(path: string): Promise<ProfileSettings> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ProfileSettings;
  } catch (error) {
    throw new Error(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sharedResources(root: string, policy: ProfilePolicy = {}, localSkillsDir?: string) {
  // Extensions are loaded through Pi package settings. Do not materialize paths
  // from the native extensions directory: a Git package lives outside it.
  return {
    skills: [
      ...(policy.skillSources?.profile === true && localSkillsDir ? (!policy.enabledProfileSkills || policy.enabledProfileSkills.includes("*") ? [localSkillsDir] : policy.enabledProfileSkills.map((name) => join(localSkillsDir, name)).filter(existsSync)) : []),
      ...(policy.skillSources?.shared !== false ? (!policy.enabledSkills || policy.enabledSkills.includes("*") ? [join(root, "skills")] : policy.enabledSkills.map((name) => join(root, "skills", name)).filter(existsSync)) : []),
    ],
    prompts: [join(root, "prompts")],
    themes: [join(root, "themes")],
  };
}

function profilePackageSources(root: string, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  // Pi resolves a relative local package against the settings file that owns
  // it. Profiles have a different settings directory, so preserve the root
  // package target as an absolute path when they inherit it.
  return value.map((source) => typeof source === "string" && source.startsWith(".") && existsSync(resolve(root, source)) ? resolve(root, source) : source);
}

function profileSettings(root: string, base: ProfileSettings, localSkillsDir: string): ProfileSettings {
  const packages = profilePackageSources(root, base.packages);
  return {
    ...base,
    ...(packages === undefined ? {} : { packages }),
    ...sharedResources(root, { enabledTools: ["*"], enabledSkills: ["*"], enabledProfileSkills: ["*"], enabledExtensions: ["*"], skillSources: { shared: true, profile: false } }, localSkillsDir),
    defaultTools: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"],
    profile: {
      enabledTools: ["*"],
      enabledSkills: ["*"],
      enabledExtensions: ["*"],
      enabledProfileSkills: ["*"],
      skillSources: { shared: true, profile: false },
    },
  };
}

type ProfileRow = { name: string; path: string };

function ProfileTable({ profiles }: { profiles: ProfileRow[] }) {
  const terminalWidth = Math.max(60, process.stdout.columns ?? 80);
  const nameWidth = Math.min(24, Math.max(12, Math.floor((terminalWidth - 7) * 0.28)));
  const pathWidth = terminalWidth - nameWidth - 7;
  const clip = (value: string, width: number) => value.length <= width ? value : `${value.slice(0, width - 1)}…`;
  const cell = (value: string, width: number) => clip(value, width).padEnd(width);
  const line = `┼${"─".repeat(nameWidth + 2)}┼${"─".repeat(pathWidth + 2)}┼`;
  const top = line.replaceAll("┼", "┬").replace(/^┬/, "┌").replace(/┬$/, "┐");
  const bottom = line.replaceAll("┼", "┴").replace(/^┴/, "└").replace(/┴$/, "┘");
  const row = (name: string, path: string) => `│ ${cell(name, nameWidth)} │ ${cell(path, pathWidth)} │`;

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { color: "gray" }, top),
    React.createElement(Text, { color: "cyan", bold: true }, row("PROFILE", "PATH")),
    React.createElement(Text, { color: "gray" }, line),
    ...profiles.map((profile) => React.createElement(Text, { color: "white", key: profile.name }, row(profile.name, profile.path))),
    React.createElement(Text, { color: "gray" }, bottom),
  );
}

async function listProfiles() {
  const root = rootAgentDir();
  const profiles: ProfileRow[] = [{ name: "default", path: root }];
  if (existsSync(profilesDir())) {
    for (const entry of await readdir(profilesDir(), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(profilesDir(), entry.name, "settings.json"))) {
        profiles.push({ name: entry.name, path: profileDir(entry.name) });
      }
    }
  }
  const app = render(React.createElement(ProfileTable, { profiles }), {
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise((resolveRender) => setTimeout(resolveRender, 25));
  app.unmount();
}

async function removeLegacyBootstrapExtensions(destination: string) {
  const extensions = join(destination, "extensions");
  if (!existsSync(extensions)) return;
  const entries = await readdir(extensions, { withFileTypes: true });
  const legacyNames = new Set(["profiles.ts", "list-sessions", "node_modules"]);
  if (entries.every((entry) => legacyNames.has(entry.name) && entry.isSymbolicLink())) {
    await rm(extensions, { recursive: true, force: true });
  }
}

async function createProfile(name: string) {
  if (!validProfileName(name)) fail("invalid name; use letters, numbers, hyphens, or underscores (max. 64 characters).");
  if (name === "default") fail("default is the primary profile and cannot be created.");
  if (reservedProfileNames.has(name.toLowerCase())) fail(`'${name}' is reserved as a Pi command and cannot be used as a profile name.`);
  await ensureNonoAvailable();
  const root = rootAgentDir();
  const destination = profileDir(name);
  if (existsSync(destination)) fail(`profile '${name}' already exists.`);

  await mkdir(join(destination, "sessions"), { recursive: true });
  const baseSettingsPath = join(root, "settings.json");
  const base = existsSync(baseSettingsPath) ? await readJson(baseSettingsPath) : {};
  await writeFile(join(destination, "settings.json"), `${JSON.stringify({ ...profileSettings(root, base, join(destination, "skills")), sandbox: true }, null, 2)}\n`);
  await ensureProfileSandbox(destination, resolve(process.argv[1]));
  await writeFile(join(destination, "SOUL.md"), "");
  await writeFile(join(destination, "guardrails.json"), "{\n  \"guardrails\": []\n}\n");

  const authPath = join(root, "auth.json");
  if (existsSync(authPath)) await copyFile(authPath, join(destination, "auth.json"));

  const modelsPath = join(root, "models.json");
  if (existsSync(modelsPath)) {
    await symlink(modelsPath, join(destination, "models.json"));
  }

  await writeStdout(`Profile '${name}' created at ${destination}\n`);
}

async function deleteProfile(name: string, force: boolean) {
  if (!validProfileName(name) || name === "default") fail("default cannot be deleted.");
  const destination = profileDir(name);
  if (!existsSync(join(destination, "settings.json"))) fail(`profile '${name}' does not exist.`);
  if (!force) fail("deletion requires --force: pi profile delete <name> --force");
  await rm(destination, { recursive: true, force: false });
  await writeStdout(`Profile '${name}' deleted.\n`);
}

async function handleProfileCommand(args: string[]) {
  const action = args[1];
  if (action === "list" && args.length === 2) return listProfiles();
  if (action === "create" && args.length === 3) return createProfile(args[2]);
  if (action === "delete" && (args.length === 3 || (args.length === 4 && args[3] === "--force"))) {
    return deleteProfile(args[2], args[3] === "--force");
  }
  if (action === "resume" && args.length === 3) return reexecWithProfile(args[2], ["--resume"]);
  if (action === "open" && args.length === 4) return reexecWithProfile(args[2], ["--session", args[3]]);
  if (action && !reservedProfileNames.has(action.toLowerCase())) return reexecWithProfile(action, args.slice(2));
  fail("usage: pi profile <name> [pi arguments] | pi profile list | pi profile create <name> | pi profile delete <name> --force | pi profile resume <name> | pi profile open <name> <session-id>");
}

function extractResumeCommand(args: string[]) {
  if (args[0] === "resume" && args.length === 2) {
    return { profile: "default", sessionId: args[1] };
  }
  const requestedProfile = extractProfile(args);
  if (requestedProfile && requestedProfile.args[0] === "resume" && requestedProfile.args.length === 2) {
    return { profile: requestedProfile.name, sessionId: requestedProfile.args[1] };
  }
  return undefined;
}

function extractProfile(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--profile") {
      const name = args[index + 1];
      if (!name) fail("--profile requires a name.");
      return { name, args: [...args.slice(0, index), ...args.slice(index + 2)] };
    }
    if (args[index].startsWith("--profile=")) {
      const name = args[index].slice("--profile=".length);
      if (!name) fail("--profile requires a name.");
      return { name, args: [...args.slice(0, index), ...args.slice(index + 1)] };
    }
  }
  return undefined;
}

async function syncProfileResources(name: string) {
  if (name === "default") return;
  const settingsPath = join(profileDir(name), "settings.json");
  const root = rootAgentDir();
  const settings = await readJson(settingsPath);
  const packages = profilePackageSources(root, settings.packages);
  if (packages !== undefined) settings.packages = packages;
  Object.assign(settings, sharedResources(root, settings.profile, join(profileDir(name), "skills")));
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await removeLegacyBootstrapExtensions(profileDir(name));
}

async function reexecWithProfile(name: string, args: string[]) {
  if (name !== "default" && (!validProfileName(name) || !existsSync(join(profileDir(name), "settings.json")))) {
    fail(`profile '${name}' does not exist.`);
  }
  const root = rootAgentDir();
  const target = name === "default" ? root : profileDir(name);
  if (name !== "default") await migrateLegacySandboxRuntime(target);
  await syncProfileResources(name);
  // The profile inherits the package source recorded in its settings. Loading
  // it normally keeps Git, npm, and local package installations portable.
  const sessionArgs = name === "default" ? [] : ["--session-dir", join(target, "sessions")];
  const piArgs = [resolve(process.argv[1]), ...sessionArgs, ...args];
  // The default profile is intentionally never sandboxed. Named profiles run
  // directly in their own persistent directory; nono enforces their policy.
  const sandbox = await isSandboxEnabled(target, name === "default");
  const childEnv = {
    ...await profileEnvironment(target),
    PI_CODING_AGENT_DIR: target,
    PI_PROFILE_ROOT: root,
    PI_PROFILE_REEXEC: "1",
    PI_ACTIVE_PROFILE: name,
  };
  if (name === "default") delete childEnv.PI_CODING_AGENT_SESSION_DIR;
  else childEnv.PI_CODING_AGENT_SESSION_DIR = join(target, "sessions");
  const launch = sandbox
    ? sandboxedCommand(await ensureProfileSandbox(target, resolve(process.argv[1])), target, process.execPath, piArgs)
    : { command: process.execPath, args: piArgs };
  const child = spawn(launch.command, launch.args, {
    cwd: sandbox ? target : process.cwd(),
    stdio: "inherit",
    env: childEnv,
  });
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
  });
  process.exit(code);
}

export default async function (pi: ExtensionAPI) {
  // Capture the profile directory when this runtime is built. This also lets SDK
  // consumers host multiple profile runtimes in one process without later
  // process.env changes leaking between agent turns.
  const activeAgentDir = process.env.PI_CODING_AGENT_DIR ?? defaultAgentDir;
  pi.registerFlag("profile", {
    description: "Start Pi using a named profile",
    type: "string",
  });

  const args = process.argv.slice(2);
  if (await handleRemoteCli(args, rootAgentDir())) process.exit(0);
  const resume = extractResumeCommand(args);
  if (resume) {
    await reexecWithProfile(resume.profile, ["--session", resume.sessionId]);
  }

  if (args[0] === "profile") {
    await handleProfileCommand(args);
    process.exit(0);
  }

  const requestedProfile = extractProfile(args);
  const guardrailArgs = requestedProfile?.args ?? args;
  if (guardrailArgs[0] === "guardrails") {
    await handleGuardrailsCli(requestedProfile?.name ?? "default", guardrailArgs);
    process.exit(0);
  }
  if (guardrailArgs[0] === "pulse") {
    const { handlePulseCli } = await import("./pulse/index.ts");
    await handlePulseCli(guardrailArgs, requestedProfile?.name);
    process.exit(0);
  }
  if (process.env.PI_PROFILE_REEXEC !== "1") {
    await reexecWithProfile(requestedProfile?.name ?? "default", requestedProfile?.args ?? args);
  }

  pi.on("session_start", async () => {
    if (process.env.PI_PROFILE_DISCOVER_TOOLS === "1") {
      // Used by the host API gateway. Extensions are already loaded at this
      // point, so this reports their tools without ever evaluating them there.
      await writeStdout(`${JSON.stringify({ tools: pi.getAllTools().map((tool) => tool.name) })}\n`);
      process.exit(0);
    }
    const settings = await readJson(join(activeAgentDir, "settings.json")).catch(() => ({}));
    const enabledTools = settings.profile?.enabledTools;
    if (!enabledTools || enabledTools.includes("*")) return;
    const allowed = new Set(enabledTools);
    pi.setActiveTools(pi.getAllTools().filter((tool) => allowed.has(tool.name)).map((tool) => tool.name));
  });

  pi.on("before_agent_start", async (event) => {
    const sections: string[] = [];
    const soulPath = join(activeAgentDir, "SOUL.md");
    if (existsSync(soulPath)) { const soul = (await readFile(soulPath, "utf8")).trim(); if (soul) sections.push(`<profile_soul path="${soulPath}">\n${soul}\n</profile_soul>`); }
    const handoff = process.env.PI_APPLICATION_HANDOFF?.trim();
    if (handoff) sections.push(`<application_handoff>\nThe following is trusted pending context from the previous Application session. Use it only when it is relevant to the current user message. Do not mention this handoff unless needed to answer the user.\n\n${handoff}\n</application_handoff>`);
    if (!sections.length) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${sections.join("\n\n")}` };
  });
}
