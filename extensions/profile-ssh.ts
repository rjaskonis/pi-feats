import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

const profileDirectory = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const validAlias = (value: string) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
const validHostname = (value: string) => /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
const validUser = (value: string) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);

type CommandResult = { code: number; stdout: string; stderr: string };
type SshHost = { alias: string; hostname?: string; ip?: string; port: number; user: string };

async function command(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: options.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function ask(label: string, defaultValue?: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(defaultValue === undefined ? `${label}: ` : `${label} [${defaultValue}]: `)).trim() || defaultValue || ""; }
  finally { prompt.close(); }
}

async function askPassword(): Promise<string> {
  if (!process.stdin.isTTY) return ask("Remote password (leave empty if key is already authorized)");
  process.stdout.write("Remote password (leave empty if key is already authorized): ");
  return await new Promise((resolve, reject) => {
    let value = "";
    const input = process.stdin;
    const restore = () => { input.off("data", onData); input.setRawMode?.(false); input.pause(); };
    const done = (error?: Error) => { restore(); process.stdout.write("\n"); error ? reject(error) : resolve(value); };
    const onData = (chunk: Buffer) => {
      const key = String(chunk);
      if (key === "\u0003") return done(new Error("cancelled"));
      if (key === "\r" || key === "\n") return done();
      if (key === "\u007f" || key === "\b") { value = value.slice(0, -1); return; }
      if (key >= " ") value += key;
    };
    input.setRawMode?.(true); input.resume(); input.on("data", onData);
  });
}

async function askpass(password: string): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-profile-ssh-"));
  const path = join(directory, "askpass");
  await writeFile(path, "#!/bin/sh\nprintf '%s' \"$PI_PROFILE_SSH_PASSWORD\"\n", { mode: 0o700 });
  return {
    env: { ...process.env, SSH_ASKPASS: path, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "pi-profile-ssh", PI_PROFILE_SSH_PASSWORD: password },
    cleanup: async () => { await rm(directory, { recursive: true, force: true }); },
  };
}

function hostTokens(host: Pick<SshHost, "alias" | "hostname" | "ip">): string[] {
  return [...new Set([host.alias, host.hostname, host.ip].filter((value): value is string => Boolean(value)))];
}

export function profileSshConfigBlock(host: SshHost, privateKey: string, knownHosts: string): string {
  const target = host.ip ?? host.hostname;
  if (!target) throw new Error("SSH host requires a hostname or IP address.");
  return `# pi-profile-ssh: ${host.alias}\nHost ${hostTokens(host).join(" ")}\n  HostName ${target}\n  User ${host.user}\n  Port ${host.port}\n  IdentityFile ${privateKey}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${knownHosts}\n  StrictHostKeyChecking yes\n`;
}

async function ensureKey(directory: string): Promise<{ privateKey: string; publicKey: string }> {
  const privateKey = join(directory, "id_ed25519"), publicKey = `${privateKey}.pub`;
  if (existsSync(privateKey) !== existsSync(publicKey)) throw new Error("The profile SSH key pair is incomplete. Restore it or remove both files before retrying.");
  if (!existsSync(privateKey)) {
    const generated = await command("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKey, "-C", `pi-profile@${profileDirectory()}`]);
    if (generated.code !== 0) throw new Error(`ssh-keygen failed: ${generated.stderr.trim() || "unknown error"}`);
  }
  await chmod(privateKey, 0o600); await chmod(publicKey, 0o644);
  return { privateKey, publicKey };
}

async function hostFingerprint(host: string, port: number): Promise<{ key: string; fingerprint: string }> {
  const scanned = await command("ssh-keyscan", ["-p", String(port), "-T", "10", host]);
  if (!scanned.stdout.trim()) throw new Error(`Could not retrieve an SSH host key: ${scanned.stderr.trim() || "connection failed"}`);
  const fingerprint = await command("ssh-keygen", ["-lf", "-"], { input: scanned.stdout });
  if (fingerprint.code !== 0) throw new Error(`Could not read the SSH host fingerprint: ${fingerprint.stderr.trim() || "invalid key"}`);
  return { key: scanned.stdout, fingerprint: fingerprint.stdout.trim() };
}

function configuredHostTokens(source: string): Set<string> {
  return new Set([...source.matchAll(/^\s*Host\s+(.+)$/gim)].flatMap((match) => match[1].trim().split(/\s+/)));
}

function assertHostTokensAvailable(source: string, tokens: string[]) {
  const existing = configuredHostTokens(source);
  const conflict = tokens.find((token) => existing.has(token));
  if (conflict) throw new Error(`SSH host '${conflict}' already exists in the profile SSH config.`);
}

async function appendConfig(path: string, block: string): Promise<void> {
  const current = existsSync(path) ? await readFile(path, "utf8") : "";
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}`, { mode: 0o600 });
  await rename(temporary, path); await chmod(path, 0o600);
}

async function writeKnownHosts(path: string, key: string): Promise<void> {
  const current = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${key}`, { mode: 0o644 });
  await chmod(path, 0o644);
}

async function listProfileSshHosts(): Promise<void> {
  const path = join(profileDirectory(), ".ssh", "config");
  if (!existsSync(path)) { process.stdout.write("No SSH hosts configured for this profile.\n"); return; }
  const config = await readFile(path, "utf8");
  const rows = [...config.matchAll(/^# pi-profile-ssh: ([^\r\n]+)\r?\nHost ([^\r\n]+)[\s\S]*?^  User ([^\r\n]+)\r?\n  Port (\d+)$/gim)]
    .map((match) => ({ alias: match[1], hosts: match[2], user: match[3], port: match[4] }));
  if (!rows.length) { process.stdout.write("No Pi-managed SSH hosts configured for this profile.\n"); return; }
  for (const row of rows) process.stdout.write(`${row.alias}\t${row.hosts}\t${row.user}\t${row.port}\n`);
}

export async function addProfileSshHost(alias: string): Promise<void> {
  if (!validAlias(alias)) throw new Error("Invalid host name. Use letters, numbers, hyphens, or underscores (max. 64 characters).");
  const hostname = await ask("Hostname (optional)");
  if (hostname && !validHostname(hostname)) throw new Error("Invalid hostname.");
  const ip = await ask("IP address (optional)");
  if (ip && !isIP(ip)) throw new Error("Invalid IP address.");
  if (!hostname && !ip) throw new Error("Provide a hostname, an IP address, or both.");
  const portText = await ask("Port", "22"), port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer between 1 and 65535.");
  const user = await ask("Remote user");
  if (!validUser(user)) throw new Error("Invalid remote user.");
  const password = await askPassword();

  const host: SshHost = { alias, ...(hostname ? { hostname } : {}), ...(ip ? { ip } : {}), port, user };
  const directory = join(profileDirectory(), ".ssh"), config = join(directory, "config"), knownHosts = join(directory, "known_hosts");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const currentConfig = existsSync(config) ? await readFile(config, "utf8") : "";
  assertHostTokensAvailable(currentConfig, hostTokens(host));
  const { privateKey, publicKey } = await ensureKey(directory);
  const fingerprint = await hostFingerprint(host.ip ?? host.hostname!, port);
  process.stdout.write(`\nSSH host fingerprint:\n${fingerprint.fingerprint}\n`);
  const confirmation = await ask("Trust this host key? [y/N]", "N");
  if (!/^(y|yes)$/i.test(confirmation)) throw new Error("SSH host key was not trusted.");

  const temporaryKnownHosts = join(directory, `known_hosts.${process.pid}.check`);
  const block = profileSshConfigBlock(host, privateKey, temporaryKnownHosts);
  const temporaryConfig = join(directory, `config.${process.pid}.check`);
  await writeKnownHosts(temporaryKnownHosts, fingerprint.key);
  await writeFile(temporaryConfig, block, { mode: 0o600 });
  const credentials = await askpass(password);
  try {
    if (password) {
      process.stdout.write("Installing the profile public key with ssh-copy-id...\n");
      const copied = await command("ssh-copy-id", ["-i", publicKey, "-p", String(port), "-o", `UserKnownHostsFile=${temporaryKnownHosts}`, "-o", "StrictHostKeyChecking=yes", `${user}@${host.ip ?? host.hostname}`], { env: credentials.env });
      if (copied.code !== 0) throw new Error(`ssh-copy-id failed: ${copied.stderr.trim() || copied.stdout.trim() || "unknown error"}`);
    } else {
      process.stdout.write("No password supplied; validating the profile key already authorized on the host...\n");
    }

    const verified = await command("ssh", ["-F", temporaryConfig, alias, "true"]);
    if (verified.code !== 0) throw new Error(`SSH key validation failed: ${verified.stderr.trim() || "connection failed"}`);
  } finally {
    await credentials.cleanup();
    await rm(temporaryConfig, { force: true });
    await rm(temporaryKnownHosts, { force: true });
  }

  await writeKnownHosts(knownHosts, fingerprint.key);
  await appendConfig(config, profileSshConfigBlock(host, privateKey, knownHosts));
  process.stdout.write(`SSH host '${alias}' added to ${config}.\n`);
}

export async function handleProfileSshCli(args: string[]): Promise<boolean> {
  if (args[0] !== "ssh") return false;
  if (args[1] === "add" && args[2] && !args[3]) {
    try { await addProfileSshHost(args[2]); }
    catch (error) { process.stderr.write(`SSH setup failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
    return true;
  }
  if (args[1] === "list" && !args[2]) {
    try { await listProfileSshHosts(); }
    catch (error) { process.stderr.write(`SSH setup failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
    return true;
  }
  process.stderr.write("Usage: pi ssh add <host-name> | pi ssh list\n"); process.exitCode = 1;
  return true;
}

export default async function (_pi: ExtensionAPI) {
  if (await handleProfileSshCli(process.argv.slice(2))) process.exit();
}
