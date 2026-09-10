import { existsSync, realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export type ProfileSandboxSettings = { sandbox?: boolean; profile?: { skillSources?: { shared?: boolean; profile?: boolean } } };
const managedDescription = "Pi profile runtime sandbox";
export const nonoConfigPath = (profileDir: string) => join(profileDir, "nono.json");

function runtimePaths(runtimeEntry: string) {
  // Pi may be installed by pi-node, a system package manager, or a managed
  // Node distribution (for example, Hermes). Grant only the active runtime
  // and its package root instead of assuming the pi-node installation path.
  const paths = new Set<string>(["$HOME/.local/share/pi-node/node-*", dirname(process.execPath)]);
  const entry = (() => { try { return realpathSync(runtimeEntry); } catch { return runtimeEntry; } })();
  const nodeModules = entry.indexOf("/lib/node_modules/");
  if (nodeModules > 0) paths.add(entry.slice(0, nodeModules));
  return [...paths];
}

function nonoPolicy(profileDir: string, runtimeEntry: string, skillSources: { shared: boolean; profile: boolean }, sharedRuntimeSources: string[]) {
  const agentDir = dirname(dirname(profileDir));
  // This module is distributed inside <package>/extensions/lib. Allow the
  // package root, not only ~/.pi/agent/extensions, so Git and npm packages
  // remain readable inside a profile sandbox.
  const packageRoot = dirname(dirname(__dirname));
  const pulseFiles = [join(agentDir, "pulse.db"), join(agentDir, "pulse.db-wal"), join(agentDir, "pulse.db-shm")];
  return {
    extends: "node-dev",
    meta: { name: `pi-${profileDir.split("/").pop() || "profile"}`, description: managedDescription },
    workdir: { access: "readwrite" },
    network: { network_profile: null },
    filesystem: {
      read: [
        packageRoot,
        // The default runtime owns extensions and packages. Profiles may read
        // them to execute shared commands and tools, but never write to them.
        join(agentDir, "extensions"),
        join(agentDir, "git"),
        join(agentDir, "npm"),
        join(agentDir, "prompts"),
        join(agentDir, "themes"),
        join(agentDir, "guardrails"),
        join(agentDir, "AGENTS.md"),
        // Resource commands need the default runtime's package and extension
        // configuration while operating on the named profile.
        join(agentDir, "settings.json"),
        ...sharedRuntimeSources,
        ...(skillSources.shared ? [join(agentDir, "skills")] : []),
        // SSH resolves the current UID through these public account maps.
        // This does not expose credentials or private keys.
        "/etc/passwd",
        "/etc/group",
        ...runtimePaths(runtimeEntry),
        ...pulseFiles,
      ],
      // The profile directory is the sandbox workdir, so Pi can persist its
      // profile-scoped authentication, models, settings, and local state.
      allow: ["$WORKDIR", join(profileDir, "sessions"), ...(skillSources.profile ? [join(profileDir, "skills")] : []), "$TMPDIR", "/dev/pts"],
      // Allows password-driven SSH helpers (e.g. pexpect) without exposing
      // the host user's SSH keys or agent.
      allow_file: ["/dev/ptmx", ...pulseFiles],
    },
  };
}

async function run(command: string, args: string[], stdio: "ignore" | "inherit" = "ignore"): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { stdio });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(command + " exited with " + String(code)));
    });
  });
}

function nonoExecutable(): string {
  const local = join(homedir(), ".local", "bin", "nono");
  return existsSync(local) ? local : "nono";
}

async function hasNono(): Promise<boolean> {
  try { await run(nonoExecutable(), ["--version"]); return true; }
  catch { return false; }
}

async function confirmNonoInstall(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Nono is required for sandboxed Profiles. Install it with: curl -fsSL https://nono.sh/install.sh | sh");
  }
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Nono is required for sandboxed Profiles. Install it now? [y/N] ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function installNono(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-feats-nono-"));
  const installer = join(directory, "install.sh");
  try {
    await run("curl", ["--fail", "--show-error", "--silent", "--location", "--proto", "=https", "--tlsv1.2", "https://nono.sh/install.sh", "--output", installer], "inherit");
    await run("sh", [installer], "inherit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Ensures the Nono binary required by sandboxed Profiles is available. */
export async function ensureNonoAvailable(): Promise<void> {
  if (await hasNono()) return;
  if (!await confirmNonoInstall()) throw new Error("Nono is required for sandboxed Profiles. Profile operation cancelled.");
  await installNono();
  if (!await hasNono()) throw new Error("Nono installation completed but the executable is unavailable. Add ~/.local/bin to PATH and retry.");
}

export async function ensureProfileSandbox(profileDir: string, runtimeEntry: string, sharedRuntimeSources: string[] = []): Promise<string> {
  await ensureNonoAvailable();
  const path = nonoConfigPath(profileDir);
  let settings: ProfileSandboxSettings = {};
  try { settings = JSON.parse(await readFile(join(profileDir, "settings.json"), "utf8")) as ProfileSandboxSettings; } catch {}
  const skillSources = { shared: settings.profile?.skillSources?.shared !== false, profile: settings.profile?.skillSources?.profile === true };
  const policy = nonoPolicy(profileDir, runtimeEntry, skillSources, sharedRuntimeSources);
  const writePolicy = async (value: unknown) => {
    const temporary = path + "." + process.pid + ".tmp";
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 384 });
    await rename(temporary, path);
  };
  if (!existsSync(path)) {
    await mkdir(profileDir, { recursive: true });
    await writePolicy(policy);
  } else {
    const current = JSON.parse(await readFile(path, "utf8")) as any;
    // Only migrate policies generated by us; administrator-authored policies
    // remain authoritative.
    if (current?.meta?.description === managedDescription) await writePolicy(policy);
  }
  await access(path);
  await run(nonoExecutable(), ["profile", "validate", path]);
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeJson(persisted: unknown, legacy: unknown): unknown {
  if (!isRecord(persisted) || !isRecord(legacy)) return legacy;
  const merged: Record<string, unknown> = { ...persisted };
  for (const [key, value] of Object.entries(legacy)) merged[key] = key in merged ? mergeJson(merged[key], value) : value;
  return merged;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`could not migrate legacy sandbox state from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Migrates state saved by pre-direct-workdir releases, then removes .runtime. */
export async function migrateLegacySandboxRuntime(profileDir: string): Promise<void> {
  const legacyDir = join(profileDir, ".runtime");
  if (!existsSync(legacyDir)) return;
  for (const name of ["auth.json", "models.json", "models-store.json"]) {
    const legacyPath = join(legacyDir, name);
    if (!existsSync(legacyPath)) continue;
    const targetPath = join(profileDir, name);
    const merged = mergeJson(existsSync(targetPath) ? await readJson(targetPath) : {}, await readJson(legacyPath));
    const temporary = `${targetPath}.migration-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, targetPath);
  }
  await rm(legacyDir, { recursive: true, force: true });
}

export async function isSandboxEnabled(profileDir: string, isDefault: boolean): Promise<boolean> {
  if (isDefault) return false;
  try { return (JSON.parse(await readFile(join(profileDir, "settings.json"), "utf8")) as ProfileSandboxSettings).sandbox === true; }
  catch { return false; }
}

export function sandboxedCommand(nonoProfile: string, runtimeDir: string, executable: string, args: string[]) {
  return { command: "nono", args: ["run", "--silent", "--allow-cwd", "--profile", nonoProfile, "--workdir", runtimeDir, "--", executable, ...args] };
}
