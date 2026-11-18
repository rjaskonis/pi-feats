import { existsSync } from "node:fs";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extensionCatalog } from "./extension-catalog.ts";
import { profileEnvironment } from "./profile-env.ts";
import { ensureProfileSandbox, migrateLegacySandboxRuntime, sandboxedCommand } from "./profile-sandbox.ts";

export type ProfilePolicy = {
  enabledTools?: string[];
  enabledSkills?: string[];
  enabledProfileSkills?: string[];
  enabledExtensions?: string[];
  skillSources?: { shared?: boolean; profile?: boolean };
  contextMemory?: { mode: "none" } | { mode: "file"; target: "profile" | "identity" } | { mode: "handler"; handler: string };
};
export type ProfileSettings = Record<string, unknown> & { profile?: ProfilePolicy };

export async function readProfileSettings(path: string): Promise<ProfileSettings> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a settings object");
    return value;
  } catch (error) {
    throw new Error(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function packageSkillRoots(root: string, settings?: ProfileSettings): Promise<string[]> {
  if (!settings) try { settings = await readProfileSettings(join(root, "settings.json")); } catch { return []; }
  const roots: string[] = [];
  if (!Array.isArray(settings.packages)) return roots;
  for (const entry of settings.packages) {
    const source = typeof entry === "object" && entry !== null ? (entry as { source?: unknown }).source : entry;
    if (typeof source !== "string") continue;
    const packagePath = packageInstallPath(root, source);
    if (!packagePath) continue;
    try {
      const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as { pi?: { skills?: unknown } };
      if (Array.isArray(manifest.pi?.skills)) for (const skill of manifest.pi.skills) if (typeof skill === "string" && existsSync(join(packagePath, skill))) roots.push(join(packagePath, skill));
    } catch { /* Ignore missing or malformed package manifests. */ }
  }
  return roots;
}

export async function sharedResources(root: string, policy: ProfilePolicy = {}, localSkillsDir?: string, rootSettings?: ProfileSettings) {
  // Named profiles omit packages, so materialize only the installed skill paths.
  const selectedSharedSkills = !policy.enabledSkills || policy.enabledSkills.includes("*");
  const packageSkills = policy.skillSources?.shared === false ? [] : (await packageSkillRoots(root, rootSettings)).flatMap((skillRoot) => selectedSharedSkills ? [skillRoot] : policy.enabledSkills!.map((name) => join(skillRoot, name)).filter(existsSync));
  return {
    skills: [
      ...(policy.skillSources?.profile === true && localSkillsDir ? (!policy.enabledProfileSkills || policy.enabledProfileSkills.includes("*") ? [localSkillsDir] : policy.enabledProfileSkills.map((name) => join(localSkillsDir, name)).filter(existsSync)) : []),
      ...(policy.skillSources?.shared !== false ? (selectedSharedSkills ? [join(root, "skills")] : policy.enabledSkills!.map((name) => join(root, "skills", name)).filter(existsSync)) : []),
      ...packageSkills,
    ],
    prompts: [join(root, "prompts")],
    themes: [join(root, "themes")],
  };
}

function packageInstallPath(root: string, source: string): string | undefined {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    const versionAt = spec.lastIndexOf("@");
    const packageName = versionAt > (spec.startsWith("@") ? spec.indexOf("/") : -1) ? spec.slice(0, versionAt) : spec;
    const path = join(root, "npm", "node_modules", packageName);
    return existsSync(join(path, "package.json")) ? path : undefined;
  }
  if (!source.startsWith("git:") && !/^(?:https?|ssh|git):\/\//.test(source)) return undefined;
  let remote = source.replace(/^git:/, "");
  const refAt = remote.lastIndexOf("@");
  if (refAt > remote.lastIndexOf("/")) remote = remote.slice(0, refAt);
  remote = remote.replace(/^(?:https?|git):\/\//, "").replace(/^ssh:\/\/git@/, "").replace(/^git@/, "").replace(/^([^/:]+):/, "$1/").replace(/\.git$/, "");
  const path = join(root, "git", remote);
  return existsSync(join(path, "package.json")) ? path : undefined;
}

export async function rootRuntimeSources(root: string, settings: ProfileSettings): Promise<string[]> {
  return (await extensionCatalog(root, settings)).filter(entry => entry.enabled).map(entry => entry.path);
}

export async function removeProfileRuntimeArtifacts(destination: string) {
  await Promise.all(["extensions", "git", "npm", "node_modules"].map(name => rm(join(destination, name), { recursive: true, force: true })));
}

export async function linkSharedModels(root: string, destination: string): Promise<void> {
  const source = join(root, "models.json"), target = join(destination, "models.json");
  await rm(target, { force: true });
  if (existsSync(source)) await symlink(source, target);
}

export const validProfileName = (name: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
const contextKeys = ["PI_OPENAI_WORKER", "PI_OPENAI_CLIENT_TOOLS_WORKER", "PI_PROFILE_WORKER", "PI_APPLICATION_IDENTITY_KEY", "PI_APPLICATION_SLUG", "PI_APPLICATION_SESSION_ID", "PI_APPLICATION_DIRECT_CONTEXT_MEMORY", "PI_APPLICATION_HANDOFF"] as const;

export function forwardedProfileExecutionEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(contextKeys.flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]!] ]));
}

export type ProfileLaunch = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
export async function prepareProfileLaunch(options: {
  root: string; name: string; cwd: string; runtimeEntry: string; environment?: NodeJS.ProcessEnv;
  interactive?: boolean; signal?: AbortSignal;
  extraEnvironment?: () => Promise<NodeJS.ProcessEnv>;
  arguments(extensionArgs: string[], sessionArgs: string[]): string[];
}): Promise<ProfileLaunch> {
  const { root, name, runtimeEntry, environment = process.env, signal } = options;
  if (!validProfileName(name)) throw new Error("Invalid profile name.");
  signal?.throwIfAborted();
  const isDefault = name === "default", target = isDefault ? root : join(root, "profiles", name);
  let runtimeSources: string[] = [], sandbox = false;
  if (!isDefault) {
    await migrateLegacySandboxRuntime(target);
    const settingsPath = join(target, "settings.json"), settings = await readProfileSettings(settingsPath);
    const rootPath = join(root, "settings.json"), rootSettings = existsSync(rootPath) ? await readProfileSettings(rootPath) : {};
    delete settings.packages;
    delete settings.extensions;
    if (settings.profile) delete settings.profile.enabledExtensions;
    Object.assign(settings, await sharedResources(root, settings.profile, join(target, "skills"), rootSettings));
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    await removeProfileRuntimeArtifacts(target);
    await linkSharedModels(root, target);
    runtimeSources = await rootRuntimeSources(root, rootSettings);
    sandbox = settings.sandbox === true;
  }
  signal?.throwIfAborted();
  const extensionArgs = runtimeSources.flatMap(source => ["--extension", source]);
  const sessionArgs = isDefault ? [] : ["--session-dir", join(target, "sessions")];
  const env: NodeJS.ProcessEnv = {
    ...await profileEnvironment(target, environment),
    ...forwardedProfileExecutionEnvironment(environment),
    ...await options.extraEnvironment?.(),
    PI_CODING_AGENT_DIR: target, PI_PROFILE_ROOT: root, PI_PROFILE_REEXEC: "1", PI_ACTIVE_PROFILE: name,
  };
  if (isDefault) delete env.PI_CODING_AGENT_SESSION_DIR;
  else env.PI_CODING_AGENT_SESSION_DIR = join(target, "sessions");
  signal?.throwIfAborted();
  const args = options.arguments(extensionArgs, sessionArgs);
  const launch = sandbox
    ? sandboxedCommand(await ensureProfileSandbox(target, runtimeEntry, runtimeSources, { interactive: options.interactive, signal }), target, process.execPath, args)
    : { command: process.execPath, args };
  signal?.throwIfAborted();
  return { ...launch, cwd: sandbox ? target : options.cwd, env };
}
