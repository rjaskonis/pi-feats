import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

export const REMOTE_COMMAND_NAMES = ["remote", "add", "remove", "delete", "list"] as const;

type RemoteRuntime = "host" | "docker";
type RemoteHost = {
  host: string;
  port: number;
  user: string;
  piAgentDirectory: string;
  runtime: RemoteRuntime;
  container?: string;
};
type LegacyRemoteHost = Omit<RemoteHost, "piAgentDirectory"> & { piDataDirectory: string };
type RemoteStore = { version: 2; remotes: Record<string, RemoteHost> };
type RemoteSecrets = { version: 1; passwords: Record<string, string> };
type DockerContainer = { id: string; name: string; image: string };
type CommandResult = { code: number; stdout: string; stderr: string };

const validName = (name: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const remoteDirectory = (root: string) => join(root, "remote-hosts");
const storePath = (root: string) => join(remoteDirectory(root), "remotes.json");
const secretsPath = (root: string) => join(remoteDirectory(root), "secrets.json");
const knownHostsPath = (root: string) => join(remoteDirectory(root), "known_hosts");

function fail(message: string): never {
  process.stderr.write(`Remote error: ${message}\n`);
  process.exit(1);
}

async function ensureDirectory(root: string) {
  await mkdir(remoteDirectory(root), { recursive: true, mode: 0o700 });
  await chmod(remoteDirectory(root), 0o700);
}

function legacyPiAgentDirectory(directory: string) {
  if (directory.endsWith("/agent")) return directory;
  return directory === "~" ? "~/agent" : `${directory}/agent`;
}

async function readStore(root: string): Promise<RemoteStore> {
  const path = storePath(root);
  if (!existsSync(path)) return { version: 2, remotes: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; remotes?: unknown };
    if (!parsed.remotes || typeof parsed.remotes !== "object") throw new Error("invalid format");
    if (parsed.version === 2) return { version: 2, remotes: parsed.remotes as Record<string, RemoteHost> };
    if (parsed.version === 1) {
      const remotes = Object.fromEntries(Object.entries(parsed.remotes as Record<string, LegacyRemoteHost>).map(([name, remote]) => [name, {
        ...remote,
        piAgentDirectory: legacyPiAgentDirectory(remote.piDataDirectory),
      }]));
      const migrated = { version: 2 as const, remotes };
      await writePrivateJson(path, migrated);
      return migrated;
    }
    throw new Error("unsupported format version");
  } catch (error) {
    fail(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readSecrets(root: string): Promise<RemoteSecrets> {
  const path = secretsPath(root);
  if (!existsSync(path)) return { version: 1, passwords: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RemoteSecrets>;
    if (parsed.version !== 1 || !parsed.passwords || typeof parsed.passwords !== "object") throw new Error("invalid format");
    return { version: 1, passwords: parsed.passwords as Record<string, string> };
  } catch (error) {
    fail(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writePrivateJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function ask(label: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue === undefined ? `${label}: ` : `${label} [${defaultValue}]: `;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(prompt)).trim();
    return answer || defaultValue || "";
  } finally {
    readline.close();
  }
}

async function askSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(label);
  process.stdout.write(`${label}: `);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const restore = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    const done = (result?: string, error?: Error) => {
      restore();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(result ?? "");
    };
    const onData = (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003") return done(undefined, new Error("cancelled"));
      if (key === "\r" || key === "\n") return done(value);
      if (key === "\u007f" || key === "\b") {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (key >= " ") {
        value += key;
        process.stdout.write("*");
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function validateHost(value: string) {
  if (!value || /\s/.test(value)) fail("host must not be empty or contain whitespace.");
}

function validateUser(value: string) {
  if (!value || /\s/.test(value)) fail("user must not be empty or contain whitespace.");
}

function validatePiAgentDirectory(value: string) {
  if (!value || (!value.startsWith("/") && value !== "~" && !value.startsWith("~/"))) {
    fail("Pi agent directory must be an absolute path or start with '~/'.");
  }
}

function piAgentDirectoryExpression(directory: string): string {
  if (directory === "~") return '"$HOME"';
  if (directory.startsWith("~/")) return `"$HOME"/${shellQuote(directory.slice(2))}`;
  return shellQuote(directory);
}

async function createAskpass(password: string): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  if (!password) return { env: {}, cleanup: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-askpass-"));
  const path = join(directory, "askpass");
  await writeFile(path, "#!/bin/sh\nprintf '%s' \"$PI_REMOTE_SSH_PASSWORD\"\n", { mode: 0o700 });
  return {
    env: { SSH_ASKPASS: path, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "pi-remote", PI_REMOTE_SSH_PASSWORD: password },
    cleanup: async () => { await rm(directory, { recursive: true, force: true }); },
  };
}

async function runSsh(root: string, remote: Pick<RemoteHost, "host" | "port" | "user">, password: string, command: string, options: { acceptNewHost?: boolean; interactive?: boolean } = {}): Promise<CommandResult> {
  await ensureDirectory(root);
  const askpass = await createAskpass(password);
  const args = [
    ...(options.interactive ? ["-tt"] : ["-T"]),
    "-p", String(remote.port),
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", `UserKnownHostsFile=${knownHostsPath(root)}`,
    "-o", `StrictHostKeyChecking=${options.acceptNewHost ? "accept-new" : "yes"}`,
    "-o", "PreferredAuthentications=publickey,password,keyboard-interactive",
    `${remote.user}@${remote.host}`,
    command,
  ];
  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn("ssh", args, { stdio: options.interactive ? "inherit" : ["ignore", "pipe", "pipe"], env: { ...process.env, ...askpass.env } });
      if (options.interactive) {
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code: code ?? 1, stdout: "", stderr: "" }));
        return;
      }
      let stdout = "", stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  } finally {
    await askpass.cleanup();
  }
}

function remotePiExecutable() {
  return `PI_REMOTE_PI="$(command -v pi 2>/dev/null || for candidate in "$HOME/.local/bin/pi" "$HOME/.hermes/node/bin/pi"; do [ -x "$candidate" ] && { printf '%s\\n' "$candidate"; break; }; done)"; [ -n "$PI_REMOTE_PI" ] || { echo "Pi executable was not found on the remote host." >&2; exit 127; }; PATH="$(dirname "$PI_REMOTE_PI"):$PATH"; export PATH`;
}

function hostPiCommand(remote: RemoteHost, args: string[]) {
  return `${remotePiExecutable()}; env PI_CODING_AGENT_DIR=${piAgentDirectoryExpression(remote.piAgentDirectory)} "$PI_REMOTE_PI"${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`;
}

function runtimeCommand(remote: RemoteHost, args: string[]) {
  const piCommand = hostPiCommand(remote, args);
  if (remote.runtime === "host") return piCommand;
  if (!remote.container) fail("docker remote is missing its container name.");
  return `docker exec -it ${shellQuote(remote.container)} sh -lc ${shellQuote(piCommand)}`;
}

function profileRuntimeCommand(remote: RemoteHost, profile: string, args: string[]) {
  const root = piAgentDirectoryExpression(remote.piAgentDirectory);
  const directory = `${root}/profiles/${shellQuote(profile)}`;
  const piCommand = `${remotePiExecutable()}; env PI_CODING_AGENT_DIR=${directory} PI_PROFILE_ROOT=${root} PI_ACTIVE_PROFILE=${shellQuote(profile)} "$PI_REMOTE_PI" --extension ${root}/extensions/cli-resources.ts${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`;
  if (remote.runtime === "host") return piCommand;
  if (!remote.container) fail("docker remote is missing its container name.");
  return `docker exec -it ${shellQuote(remote.container)} sh -lc ${shellQuote(piCommand)}`;
}

function runtimeBashCommand(remote: RemoteHost, args: string[]) {
  const bashArgs = args.map(shellQuote).join(" ");
  const shell = `cd ${piAgentDirectoryExpression(remote.piAgentDirectory)} && exec bash${bashArgs ? ` ${bashArgs}` : ""}`;
  if (remote.runtime === "host") return shell;
  if (!remote.container) fail("docker remote is missing its container name.");
  return `docker exec -it ${shellQuote(remote.container)} sh -lc ${shellQuote(shell)}`;
}

async function testSsh(root: string, remote: Pick<RemoteHost, "host" | "port" | "user">, password: string) {
  const result = await runSsh(root, remote, password, "true", { acceptNewHost: true });
  if (result.code !== 0) fail(`SSH authentication failed: ${result.stderr.trim() || "connection failed"}`);
}

async function dockerAvailable(root: string, remote: Pick<RemoteHost, "host" | "port" | "user">, password: string) {
  const result = await runSsh(root, remote, password, "command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1", { acceptNewHost: true });
  return result.code === 0;
}

async function dockerContainers(root: string, remote: Pick<RemoteHost, "host" | "port" | "user">, password: string): Promise<DockerContainer[]> {
  const result = await runSsh(root, remote, password, "docker ps --filter status=running --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}'", { acceptNewHost: true });
  if (result.code !== 0) fail(`could not list Docker containers: ${result.stderr.trim() || "docker command failed"}`);
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [id = "", name = "", image = ""] = line.split("\t");
    return { id, name, image };
  }).filter((container) => container.name.toLowerCase().includes("pi"));
}

async function chooseRuntime(dockerIsAvailable: boolean): Promise<RemoteRuntime> {
  if (!dockerIsAvailable) return "host";
  process.stdout.write("\nRuntime:\n  1. Host\n  2. Docker\n");
  while (true) {
    const choice = (await ask("Runtime", "1")).toLowerCase();
    if (choice === "1" || choice === "host") return "host";
    if (choice === "2" || choice === "docker") return "docker";
    process.stderr.write("Enter 1 for Host or 2 for Docker.\n");
  }
}

async function chooseContainer(containers: DockerContainer[]): Promise<string> {
  if (containers.length) {
    process.stdout.write("\nDetected running Pi containers:\n");
    containers.forEach((container, index) => process.stdout.write(`  ${index + 1}. ${container.name}  ${container.id.slice(0, 12)}  ${container.image}\n`));
  }
  const defaultValue = containers.length === 1 ? "1" : undefined;
  while (true) {
    const value = await ask("Container name or number", defaultValue);
    const selected = /^\d+$/.test(value) ? containers[Number(value) - 1]?.name : value;
    if (selected && !/\s/.test(selected)) return selected;
    process.stderr.write("Enter a valid container name or one of the listed numbers.\n");
  }
}

async function verifyPi(root: string, remote: RemoteHost, password: string) {
  const command = remote.runtime === "host"
    ? hostPiCommand(remote, ["--version"])
    : `docker exec ${shellQuote(remote.container ?? "")} sh -lc ${shellQuote(hostPiCommand(remote, ["--version"]))}`;
  const result = await runSsh(root, remote, password, command, { acceptNewHost: true });
  if (result.code !== 0) fail(`Pi is not available in the selected ${remote.runtime} runtime: ${result.stderr.trim() || "pi --version failed"}`);
  process.stdout.write(`Pi detected: ${result.stdout.trim()}\n`);
}

async function addRemote(root: string, name: string) {
  if (!validName(name)) fail("invalid remote name; use letters, numbers, hyphens, or underscores (max. 64 characters).");
  const store = await readStore(root);
  if (store.remotes[name]) fail(`remote '${name}' already exists.`);

  const host = await ask("Host"); validateHost(host);
  const portText = await ask("Port", "22");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("port must be an integer between 1 and 65535.");
  const user = await ask("User"); validateUser(user);
  const password = await askSecret("Password (leave empty to use SSH key)");
  const connection = { host, port, user };

  process.stdout.write("Validating SSH access...\n");
  await testSsh(root, connection, password);
  const hasDocker = await dockerAvailable(root, connection, password);
  if (hasDocker) process.stdout.write("Docker is available on the remote host.\n");
  else process.stdout.write("Docker is not available to the remote user; Host runtime will be used.\n");

  const runtime = await chooseRuntime(hasDocker);
  const container = runtime === "docker" ? await chooseContainer(await dockerContainers(root, connection, password)) : undefined;
  const piAgentDirectory = await ask("Pi agent directory", "~/.pi/agent"); validatePiAgentDirectory(piAgentDirectory);
  const remote: RemoteHost = { ...connection, runtime, ...(container ? { container } : {}), piAgentDirectory };

  process.stdout.write(`Validating Pi in the ${runtime} runtime...\n`);
  await verifyPi(root, remote, password);
  await ensureDirectory(root);
  store.remotes[name] = remote;
  await writePrivateJson(storePath(root), store);
  const secrets = await readSecrets(root);
  if (password) secrets.passwords[name] = password;
  else delete secrets.passwords[name];
  await writePrivateJson(secretsPath(root), secrets);
  process.stdout.write(`Remote '${name}' added.\n`);
}

async function listRemotes(root: string) {
  const store = await readStore(root);
  const entries = Object.entries(store.remotes).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    process.stdout.write("No remotes configured.\n");
    return;
  }
  for (const [name, remote] of entries) {
    process.stdout.write(`${name}\t${remote.runtime}\t${remote.user}@${remote.host}:${remote.port}\t${remote.container ?? "-"}\t${remote.piAgentDirectory}\n`);
  }
}

async function deleteRemote(root: string, name: string, force: boolean) {
  if (!force) fail("deletion requires --force: pi remote delete <name> --force");
  const store = await readStore(root);
  if (!store.remotes[name]) fail(`remote '${name}' does not exist.`);
  delete store.remotes[name];
  await writePrivateJson(storePath(root), store);
  const secrets = await readSecrets(root);
  delete secrets.passwords[name];
  await writePrivateJson(secretsPath(root), secrets);
  process.stdout.write(`Remote '${name}' deleted.\n`);
}

const profileManagementActions = new Set(["add", "create", "delete", "list", "open", "remove", "resume"]);
const profileResourceCommands = new Set(["extensions", "packages", "sessions", "skills", "tools"]);

function requestedProfile(args: string[]): string | undefined {
  if (args[0] !== "profile" || !args[1] || profileManagementActions.has(args[1].toLowerCase())) return undefined;
  return args[1];
}

function profileExistsCommand(remote: RemoteHost, profile: string) {
  if (profile === "default") return "true";
  const check = `test -f ${piAgentDirectoryExpression(remote.piAgentDirectory)}/profiles/${shellQuote(profile)}/settings.json`;
  if (remote.runtime === "host") return check;
  if (!remote.container) fail("docker remote is missing its container name.");
  return `docker exec ${shellQuote(remote.container)} sh -lc ${shellQuote(check)}`;
}

async function connectRemote(root: string, name: string, args: string[]) {
  const store = await readStore(root);
  const remote = store.remotes[name];
  if (!remote) fail(`remote '${name}' does not exist.`);
  const secrets = await readSecrets(root);
  const password = secrets.passwords[name] ?? "";
  const profile = requestedProfile(args);
  if (profile) {
    const exists = await runSsh(root, remote, password, profileExistsCommand(remote, profile));
    if (exists.code !== 0) fail(`profile '${profile}' does not exist on remote '${name}'.`);
  }
  const command = args[0] === "bash"
    ? runtimeBashCommand(remote, args.slice(1))
    : profile && profileResourceCommands.has(args[2] ?? "")
      ? profileRuntimeCommand(remote, profile, args.slice(2))
      : runtimeCommand(remote, args);
  const result = await runSsh(root, remote, password, command, { interactive: true });
  process.exit(result.code);
}

export async function handleRemoteCli(args: string[], root: string): Promise<boolean> {
  const remoteTarget = args[0]?.match(/^remote:([a-zA-Z][a-zA-Z0-9_-]{0,63})$/);
  if (remoteTarget) {
    await connectRemote(root, remoteTarget[1], args.slice(1));
    return true;
  }
  if (args[0] !== "remote") return false;
  const action = args[1];
  if (action === "add" && args.length === 3) await addRemote(root, args[2]);
  else if (action === "list" && args.length === 2) await listRemotes(root);
  else if (action === "delete" && (args.length === 3 || (args.length === 4 && args[3] === "--force"))) await deleteRemote(root, args[2], args[3] === "--force");
  else fail("usage: pi remote add <name> | pi remote list | pi remote delete <name> --force | pi remote:<name> [pi arguments]");
  return true;
}
