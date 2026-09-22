import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, render, Text } from "ink";
import React from "react";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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

async function interactiveCommand(command: string, args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

export function profileSshVerificationArgs(config: string, alias: string): string[] {
  return [
    "-F", config,
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ConnectTimeout=15",
    alias,
    "true",
  ];
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

async function replaceConfig(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path); await chmod(path, 0o600);
}

async function appendConfig(path: string, block: string): Promise<void> {
  const current = existsSync(path) ? await readFile(path, "utf8") : "";
  await replaceConfig(path, `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}`);
}

async function writeKnownHosts(path: string, key: string): Promise<void> {
  const current = existsSync(path) ? await readFile(path, "utf8") : "";
  await writeFile(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${key}`, { mode: 0o644 });
  await chmod(path, 0o644);
}

type SshHostRow = { alias: string; hosts: string; user: string; port: string };

function SshHostTable({ hosts }: { hosts: SshHostRow[] }) {
  const width = Math.max(80, process.stdout.columns ?? 80);
  const available = width - 13;
  const columns: Array<[string, number]> = [["ALIAS", Math.max(14, Math.floor(available * 0.2))], ["HOSTS", 0], ["USER", Math.max(12, Math.floor(available * 0.18))], ["PORT", 6]];
  columns[1][1] = Math.max(16, available - columns[0][1] - columns[2][1] - columns[3][1]);
  const clip = (value: string, columnWidth: number) => value.length <= columnWidth ? value : `${value.slice(0, Math.max(0, columnWidth - 1))}…`;
  const cell = (value: string, columnWidth: number) => clip(value, columnWidth).padEnd(columnWidth);
  const line = `┼${columns.map(([, columnWidth]) => "─".repeat(columnWidth + 2)).join("┼")}┼`;
  const top = line.replaceAll("┼", "┬").replace(/^┬/, "┌").replace(/┬$/, "┐");
  const bottom = line.replaceAll("┼", "┴").replace(/^┴/, "└").replace(/┴$/, "┘");
  const row = (values: string[]) => `│ ${values.map((value, index) => cell(value, columns[index][1])).join(" │ ")} │`;
  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Text, { color: "cyan", bold: true }, "PROFILE SSH HOSTS"),
    React.createElement(Text, { color: "gray" }, top),
    React.createElement(Text, { color: "cyan", bold: true }, row(columns.map(([name]) => name))),
    React.createElement(Text, { color: "gray" }, line),
    ...(hosts.length
      ? hosts.map((host) => React.createElement(Text, { color: "white", key: host.alias }, row([host.alias, host.hosts, host.user, host.port])))
      : [React.createElement(Text, { color: "gray", key: "empty" }, row(["—", "No Pi-managed SSH hosts configured", "—", "—"]))]),
    React.createElement(Text, { color: "gray" }, bottom),
  );
}

export function removeProfileSshConfigBlock(config: string, alias: string): { config: string; hostName: string } {
  const lines = config.split(/\r?\n/);
  const marker = `# pi-profile-ssh: ${alias}`;
  const start = lines.findIndex((line) => line === marker);
  if (start < 0) throw new Error(`Pi-managed SSH host '${alias}' was not found.`);
  const end = lines.findIndex((line, index) => index > start && line === "  StrictHostKeyChecking yes");
  if (end < 0) throw new Error(`Pi-managed SSH host '${alias}' has an incomplete config block.`);
  const hostLine = lines.slice(start, end + 1).find((line) => line.startsWith("  HostName "));
  if (!hostLine) throw new Error(`Pi-managed SSH host '${alias}' has no HostName.`);
  const remaining = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { config: remaining ? `${remaining}\n` : "", hostName: hostLine.slice("  HostName ".length) };
}

async function deleteProfileSshHost(alias: string): Promise<void> {
  if (!validAlias(alias)) throw new Error("Invalid host name. Use letters, numbers, hyphens, or underscores (max. 64 characters).");
  const directory = join(profileDirectory(), ".ssh"), configPath = join(directory, "config"), knownHosts = join(directory, "known_hosts");
  if (!existsSync(configPath)) throw new Error(`Pi-managed SSH host '${alias}' was not found.`);
  const removed = removeProfileSshConfigBlock(await readFile(configPath, "utf8"), alias);
  await replaceConfig(configPath, removed.config);
  if (existsSync(knownHosts)) await command("ssh-keygen", ["-R", removed.hostName, "-f", knownHosts]);
  process.stdout.write(`SSH host '${alias}' deleted from ${configPath}.\n`);
}

async function listProfileSshHosts(): Promise<void> {
  const path = join(profileDirectory(), ".ssh", "config");
  const config = existsSync(path) ? await readFile(path, "utf8") : "";
  const hosts = [...config.matchAll(/^# pi-profile-ssh: ([^\r\n]+)\r?\nHost ([^\r\n]+)[\s\S]*?^  User ([^\r\n]+)\r?\n  Port (\d+)$/gim)]
    .map((match) => ({ alias: match[1], hosts: match[2], user: match[3], port: match[4] }));
  const app = render(React.createElement(SshHostTable, { hosts }), { stdout: process.stdout, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false });
  await new Promise((resolveRender) => setTimeout(resolveRender, 25));
  app.unmount();
}

export async function addProfileSshHost(alias: string): Promise<void> {
  if (!validAlias(alias)) throw new Error("Invalid host name. Use letters, numbers, hyphens, or underscores (max. 64 characters).");
  const hostname = await ask("Hostname", alias);
  if (!validHostname(hostname)) throw new Error("Invalid hostname.");
  const ip = await ask("IP address");
  if (!isIP(ip)) throw new Error("Invalid IP address.");
  const portText = await ask("Port", "22"), port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer between 1 and 65535.");
  const user = await ask("Remote user");
  if (!validUser(user)) throw new Error("Invalid remote user.");
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
  try {
    let verified = await command("ssh", profileSshVerificationArgs(temporaryConfig, alias));
    if (verified.code !== 0) {
      if (!process.stdin.isTTY) throw new Error(`Profile key is not authorized and a password cannot be requested without a terminal: ${verified.stderr.trim() || "connection failed"}`);
      process.stdout.write("The profile key is not authorized yet. ssh-copy-id will request the remote password once.\n");
      const copied = await interactiveCommand("ssh-copy-id", ["-i", publicKey, "-F", temporaryConfig, alias]);
      if (copied !== 0) throw new Error("ssh-copy-id failed.");
      verified = await command("ssh", profileSshVerificationArgs(temporaryConfig, alias));
    }
    if (verified.code !== 0) throw new Error(`SSH key validation failed: ${verified.stderr.trim() || "connection failed"}`);
  } finally {
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
  if ((args[1] === "delete" || args[1] === "remove") && args[2] && !args[3]) {
    try { await deleteProfileSshHost(args[2]); }
    catch (error) { process.stderr.write(`SSH setup failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
    return true;
  }
  process.stderr.write("Usage: pi ssh add <host-name> | pi ssh list | pi ssh delete <host-name>\n"); process.exitCode = 1;
  return true;
}

export default async function (_pi: ExtensionAPI) {
  if (await handleProfileSshCli(process.argv.slice(2))) process.exit();
}
