import { SessionManager, type ExtensionAPI, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { Box, render, Text } from "ink";
import React from "react";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

type ListKind = "tools" | "skills" | "extensions";
type Row = [string, string, string];

const kindFromArgs = (args: string[]): ListKind | undefined => {
  for (let index = 0; index < args.length - 1; index += 1) {
    const kind = args[index];
    if (args[index + 1] === "list" && (kind === "tools" || kind === "skills" || kind === "extensions")) {
      return kind;
    }
  }
  return undefined;
};

const BUILTIN_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

type Action = "disable" | "enable";

interface ParsedAction {
  kind: ListKind;
  action: Action;
  target: string;
}

interface SessionRename { id: string; name: string; }
interface PackageAction { action: Action; target: string; }

const packageRequestedFromArgs = (args: string[]) => args.some((arg, index) => arg === "packages" && args[index + 1] === "list");
const packageActionFromArgs = (args: string[]): PackageAction | undefined => {
  for (let index = 0; index < args.length - 2; index += 1) if (args[index] === "packages" && (args[index + 1] === "enable" || args[index + 1] === "disable") && args[index + 2] && !args[index + 2].startsWith("--")) return { action: args[index + 1] as Action, target: args[index + 2] };
  return undefined;
};

const sessionRenameFromArgs = (args: string[]): SessionRename | undefined => {
  for (let index = 0; index < args.length - 3; index += 1) if (args[index] === "sessions" && args[index + 1] === "rename") {
    const [id, name] = [args[index + 2], args[index + 3]];
    if (!id || !name || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) throw new Error("usage: pi sessions rename <session-id> <name>");
    return { id, name: name.trim() };
  }
  return undefined;
};

const actionFromArgs = (args: string[]): ParsedAction | undefined => {
  for (let index = 0; index < args.length - 2; index += 1) {
    const kind = args[index];
    const action = args[index + 1];
    const target = args[index + 2];
    if ((kind === "tools" || kind === "skills" || kind === "extensions") &&
        (action === "disable" || action === "enable") &&
        target && !target.startsWith("--")) {
      return { kind, action, target };
    }
  }
  return undefined;
};

const clean = (value: string) => value.replaceAll("\n", " ").replaceAll("\t", " ");
const clip = (value: string, width: number) => value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;

function ResourceTable({ title, headers, rows, highlightStatus = false }: { title: string; headers: Row; rows: Row[]; highlightStatus?: boolean }) {
  const terminalWidth = Math.max(80, process.stdout.columns ?? 80);
  const available = terminalWidth - 10;
  const widths: [number, number, number] = [
    Math.max(12, Math.floor(available * 0.23)),
    Math.max(12, Math.floor(available * 0.18)),
    0,
  ];
  widths[2] = available - widths[0] - widths[1];
  const cell = (value: string, width: number) => clip(clean(value), width).padEnd(width);
  const line = `┼${"─".repeat(widths[0] + 2)}┼${"─".repeat(widths[1] + 2)}┼${"─".repeat(widths[2] + 2)}┼`;
  const top = line.replaceAll("┼", "┬").replace(/^┬/, "┌").replace(/┬$/, "┐");
  const bottom = line.replaceAll("┼", "┴").replace(/^┴/, "└").replace(/┴$/, "┘");
  const row = (values: Row) => `│ ${cell(values[0], widths[0])} │ ${cell(values[1], widths[1])} │ ${cell(values[2], widths[2])} │`;

  const renderedRow = (values: Row, index: number) => {
    const statusColor = values[1] === "enabled" ? "green" : "#f5c2d7";
    return React.createElement(
      Box,
      { flexDirection: "row", key: `${values.join("\0")}-${index}` },
      React.createElement(Text, { color: "gray" }, "│ "),
      React.createElement(Text, { color: "white" }, cell(values[0], widths[0])),
      React.createElement(Text, { color: "gray" }, " │ "),
      React.createElement(Text, { color: highlightStatus ? statusColor : "white" }, cell(values[1], widths[1])),
      React.createElement(Text, { color: "gray" }, " │ "),
      React.createElement(Text, { color: "white" }, cell(values[2], widths[2])),
      React.createElement(Text, { color: "gray" }, " │"),
    );
  };

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { color: "cyan", bold: true }, title),
    React.createElement(Text, { color: "gray" }, top),
    React.createElement(Text, { color: "cyan", bold: true }, row(headers)),
    React.createElement(Text, { color: "gray" }, line),
    ...rows.map(renderedRow),
    React.createElement(Text, { color: "gray" }, bottom),
  );
}

type SourceRow = [string, string, string, string];
function SourceTable({ title, detailHeader, rows }: { title: string; detailHeader: string; rows: SourceRow[] }) {
  const available = Math.max(80, process.stdout.columns ?? 80) - 13, widths: [number, number, number, number] = [Math.max(14, Math.floor(available * .20)), 10, Math.max(18, Math.floor(available * .27)), 0];
  widths[3] = available - widths[0] - widths[1] - widths[2];
  const cell = (value: string, width: number) => clip(clean(value), width).padEnd(width);
  const line = `┼${"─".repeat(widths[0] + 2)}┼${"─".repeat(widths[1] + 2)}┼${"─".repeat(widths[2] + 2)}┼${"─".repeat(widths[3] + 2)}┼`;
  const top = line.replaceAll("┼", "┬").replace(/^┬/, "┌").replace(/┬$/, "┐"), bottom = line.replaceAll("┼", "┴").replace(/^┴/, "└").replace(/┴$/, "┘");
  const row = (values: SourceRow) => `│ ${cell(values[0], widths[0])} │ ${cell(values[1], widths[1])} │ ${cell(values[2], widths[2])} │ ${cell(values[3], widths[3])} │`;
  const renderedRow = (values: SourceRow, index: number) => React.createElement(Box, { flexDirection: "row", key: `${values.join("\0")}-${index}` }, React.createElement(Text, { color: "gray" }, "│ "), React.createElement(Text, { color: "white" }, cell(values[0], widths[0])), React.createElement(Text, { color: "gray" }, " │ "), React.createElement(Text, { color: values[1] === "enabled" ? "green" : "#f5c2d7" }, cell(values[1], widths[1])), React.createElement(Text, { color: "gray" }, " │ "), React.createElement(Text, { color: "white" }, cell(values[2], widths[2])), React.createElement(Text, { color: "gray" }, " │ "), React.createElement(Text, { color: "white" }, cell(values[3], widths[3])), React.createElement(Text, { color: "gray" }, " │"));
  return React.createElement(Box, { flexDirection: "column" }, React.createElement(Text, { color: "cyan", bold: true }, title), React.createElement(Text, { color: "gray" }, top), React.createElement(Text, { color: "cyan", bold: true }, row(["NAME", "STATUS", "SOURCE", detailHeader])), React.createElement(Text, { color: "gray" }, line), ...rows.map(renderedRow), React.createElement(Text, { color: "gray" }, bottom));
}

function SessionTable({ sessions }: { sessions: SessionInfo[] }) {
  const terminalWidth = Math.max(80, process.stdout.columns ?? 80);
  const available = terminalWidth - 13;
  const widths = {
    id: Math.max(16, Math.floor(available * 0.27)),
    session: Math.max(16, Math.floor(available * 0.22)),
    activity: 20,
    path: 0,
  };
  widths.path = available - widths.id - widths.session - widths.activity;
  const cell = (value: string, width: number) => clip(clean(value), width).padEnd(width);
  const line = `┼${"─".repeat(widths.id + 2)}┼${"─".repeat(widths.session + 2)}┼${"─".repeat(widths.activity + 2)}┼${"─".repeat(widths.path + 2)}┼`;
  const top = line.replaceAll("┼", "┬").replace(/^┬/, "┌").replace(/┬$/, "┐");
  const bottom = line.replaceAll("┼", "┴").replace(/^┴/, "└").replace(/┴$/, "┘");
  const row = (values: [string, string, string, string]) => `│ ${cell(values[0], widths.id)} │ ${cell(values[1], widths.session)} │ ${cell(values[2], widths.activity)} │ ${cell(values[3], widths.path)} │`;
  const formatActivity = (date: Date) => new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(date);

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { color: "cyan", bold: true }, "SESSIONS"),
    React.createElement(Text, { color: "gray" }, top),
    React.createElement(Text, { color: "cyan", bold: true }, row(["ID", "SESSION", "LAST ACTIVITY", "PATH"])),
    React.createElement(Text, { color: "gray" }, line),
    ...sessions.map((session) => React.createElement(
      Text,
      { color: "white", key: session.path },
      row([session.id, session.name ?? session.firstMessage, formatActivity(session.modified), session.path]),
    )),
    React.createElement(Text, { color: "gray" }, bottom),
  );
}

function requestedProfile(): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf("--profile");
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith("--profile="))?.slice("--profile=".length);
}

async function readSettings() {
  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
  const rootAgentDir = process.env.PI_PROFILE_ROOT ?? configuredAgentDir;
  const profile = process.env.PI_ACTIVE_PROFILE ?? requestedProfile();
  // Sandboxed profiles execute directly in their own persistent directory.
  const agentDir = configuredAgentDir;
  const path = join(agentDir, "settings.json");
  if (!existsSync(path)) return { agentDir, resourceRoot: rootAgentDir, settings: {} as Record<string, unknown> };
  return { agentDir, resourceRoot: rootAgentDir, settings: JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> };
}

const isExcluded = (resourcePath: string, exclusions: string[]): boolean =>
  exclusions.includes(`!${resourcePath}`);

async function findSkillFiles(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  if (basename(path) === "SKILL.md") return [path];

  const files: string[] = [];
  const skillFile = join(path, "SKILL.md");
  if (existsSync(skillFile)) files.push(skillFile);
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(...await findSkillFiles(join(path, entry.name)));
    }
  } catch {}
  return files;
}

function skillEnabled(resourcePath: string, skillRoot: string, settings: Record<string, unknown>, exclusions: string[]): boolean {
  const policy = (settings.profile as { enabledSkills?: unknown } | undefined)?.enabledSkills;
  const name = relative(skillRoot, resourcePath).replaceAll("\\", "/");
  if (Array.isArray(policy)) return policy.includes("*") || policy.includes(name);
  return !isExcluded(resourcePath, exclusions);
}

async function skillRows(paths: string[], skillRoot: string, settings: Record<string, unknown>, exclusions: string[]): Promise<Row[]> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    for (const skillFile of await findSkillFiles(path)) {
      if (seen.has(skillFile)) continue;
      seen.add(skillFile);
      const resourcePath = dirname(skillFile);
      const name = relative(skillRoot, resourcePath).replaceAll("\\", "/");
      rows.push([name && !name.startsWith("..") ? name : basename(resourcePath), skillEnabled(resourcePath, skillRoot, settings, exclusions) ? "enabled" : "disabled", skillFile]);
    }
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]));
}

async function extensionRows(paths: string[], exclusions: string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if ([".ts", ".js"].includes(extname(path))) {
      rows.push([basename(path, extname(path)), isExcluded(path, exclusions) ? "disabled" : "enabled", path]);
      continue;
    }
    // A configured directory with index.ts/index.js is one extension. Its
    // sibling source/config files are implementation details, not extensions.
    if (existsSync(join(path, "index.ts")) || existsSync(join(path, "index.js"))) {
      rows.push([basename(path), isExcluded(path, exclusions) ? "disabled" : "enabled", path]);
      continue;
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isFile() && [".ts", ".js"].includes(extname(entry.name))) {
        const resourcePath = join(path, entry.name);
        rows.push([basename(entry.name, extname(entry.name)), isExcluded(resourcePath, exclusions) ? "disabled" : "enabled", resourcePath]);
      } else if (entry.isDirectory() && (existsSync(join(path, entry.name, "index.ts")) || existsSync(join(path, entry.name, "index.js")))) {
        const resourcePath = join(path, entry.name);
        rows.push([entry.name, isExcluded(resourcePath, exclusions) ? "disabled" : "enabled", resourcePath]);
      }
    }
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

type ConfiguredPackage = { source: string; base: string; name: string; manifest?: { version?: string; description?: string; pi?: { extensions?: unknown } } };

function packageBase(source: string, resourceRoot: string): string | undefined {
  if (source.startsWith("npm:")) return join(resourceRoot, "npm", "node_modules", source.slice(4));
  if (source.startsWith(".") || source.startsWith("/")) return resolve(resourceRoot, source);
  if (!source.startsWith("git:") && !/^(?:https?|ssh):\/\//.test(source)) return undefined;
  let remote = source.replace(/^git:/, "");
  const ref = remote.lastIndexOf("@");
  if (ref > remote.lastIndexOf("/")) remote = remote.slice(0, ref);
  remote = remote.replace(/^https?:\/\//, "").replace(/^ssh:\/\/git@/, "").replace(/^git@/, "").replace(/^([^/:]+):/, "$1/").replace(/\.git$/, "");
  return join(resourceRoot, "git", remote);
}

async function configuredPackages(resourceRoot: string, settings: Record<string, unknown>): Promise<ConfiguredPackage[]> {
  const sources = Array.isArray(settings.packages) ? settings.packages.filter((value): value is string => typeof value === "string") : [];
  const packages: ConfiguredPackage[] = [];
  for (const source of sources) {
    const base = packageBase(source, resourceRoot);
    if (!base) continue;
    try {
      const manifest = JSON.parse(await readFile(join(base, "package.json"), "utf8")) as ConfiguredPackage["manifest"] & { name?: string };
      packages.push({ source, base, name: manifest?.name ?? source, manifest });
    } catch {
      packages.push({ source, base, name: source.replace(/^npm:/, "") });
    }
  }
  return packages;
}

async function configuredPackageExtensions(resourceRoot: string, settings: Record<string, unknown>): Promise<Array<{ path: string; packageName: string }>> {
  const paths: Array<{ path: string; packageName: string }> = [];
  for (const pkg of await configuredPackages(resourceRoot, settings)) {
    for (const extension of Array.isArray(pkg.manifest?.pi?.extensions) ? pkg.manifest.pi.extensions : []) {
      if (typeof extension === "string") paths.push({ path: join(pkg.base, extension), packageName: pkg.name });
    }
  }
  return paths;
}

async function packageToolSources(resourceRoot: string, settings: Record<string, unknown>, names: string[]): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const { path, packageName } of await configuredPackageExtensions(resourceRoot, settings)) try { const source = await readFile(path, "utf8"); for (const name of names) if (source.includes(`"${name}"`) || source.includes(`'${name}'`) || source.includes(`\`${name}\``)) sources.set(name, packageName); } catch {}
  return sources;
}

async function packageRows(resourceRoot: string, settings: Record<string, unknown>): Promise<Row[]> {
  return (await configuredPackages(resourceRoot, settings))
    .map((pkg) => [pkg.name, existsSync(join(pkg.base, "package.json")) ? "enabled" : "disabled", pkg.manifest ? `${pkg.manifest.version ?? "unknown version"}${pkg.manifest.description ? ` · ${pkg.manifest.description}` : ""}` : "package metadata unavailable"] as Row)
    .sort((left, right) => left[0].localeCompare(right[0]));
}

async function applyPackageAction(action: PackageAction) {
  const { agentDir, resourceRoot, settings } = await readSettings();
  const name = action.target.replace(/^npm:/, "");
  if (!existsSync(join(resourceRoot, "npm", "node_modules", name, "package.json"))) throw new Error(`Package "${name}" is not installed in ${join(resourceRoot, "npm")}.`);
  const entry = `npm:${name}`, configured = Array.isArray(settings.packages) ? settings.packages.filter((value): value is string => typeof value === "string") : [];
  const packages = action.action === "enable" ? [...new Set([...configured.filter((value) => value !== name), entry])] : configured.filter((value) => value !== entry && value !== name);
  const updated = { ...settings, packages } as Record<string, unknown>; if (packages.length === 0) delete updated.packages;
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  console.log(`Package "${name}" ${action.action === "enable" ? "enabled" : "disabled"} in ${join(agentDir, "settings.json")}. Use /reload to apply.`);
}

async function renderAndClose(element: React.ReactElement) {
  const app = render(element, { stdout: process.stdout, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false });
  await new Promise((resolveRender) => setTimeout(resolveRender, 25));
  app.unmount();
}

function setExclusion(entries: string[], resourcePath: string, disable: boolean) {
  const exclusion = `!${resourcePath}`;
  if (disable) return entries.includes(exclusion) ? entries : [...entries, exclusion];
  return entries.filter((entry) => entry !== exclusion);
}

async function findResource(kind: "extensions" | "skills", target: string, settings: Record<string, unknown>, agentDir: string, resourceRoot: string) {
  if (existsSync(target)) {
    if (kind === "skills" && (basename(target) === "SKILL.md" || existsSync(join(target, "SKILL.md")))) {
      return basename(target) === "SKILL.md" ? dirname(target) : target;
    }
    if (kind === "extensions" && ([".ts", ".js"].includes(extname(target)) || existsSync(join(target, "index.ts")) || existsSync(join(target, "index.js")))) {
      return target;
    }
  }

  const rawEntries = Array.isArray(settings[kind]) ? settings[kind].filter((entry): entry is string => typeof entry === "string") : [];
  const roots = [join(agentDir, kind), ...(kind === "skills" ? [join(resourceRoot, "skills")] : []), ...rawEntries.filter((entry) => !/^[!+\-]/.test(entry)), join(process.cwd(), ".pi", kind)];
  const name = target.replace(/^[!+\-]+/, "");

  for (const root of [...new Set(roots)]) {
    if (!existsSync(root)) continue;
    if (kind === "skills") {
      for (const skillFile of await findSkillFiles(root)) {
        const resourcePath = dirname(skillFile);
        if (basename(resourcePath) === name) return resourcePath;
      }
      continue;
    }

    if ([".ts", ".js"].includes(extname(root)) && basename(root, extname(root)) === name) return root;
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && [".ts", ".js"].includes(extname(entry.name)) && basename(entry.name, extname(entry.name)) === name) {
          return join(root, entry.name);
        }
        if (entry.isDirectory() && entry.name === name && (existsSync(join(root, entry.name, "index.ts")) || existsSync(join(root, entry.name, "index.js")))) {
          return join(root, entry.name);
        }
      }
    } catch {}
  }
  return undefined;
}

function isWithin(path: string, root: string) {
  const value = relative(root, path);
  return value !== "" && !value.startsWith("../") && value !== ".." && !value.startsWith("..\\");
}

async function applyProfileSkillAction(action: ParsedAction, resourcePath: string, settings: Record<string, unknown>, agentDir: string, resourceRoot: string, settingsPath: string): Promise<boolean> {
  const profile = settings.profile;
  if (!profile || typeof profile !== "object" || agentDir === resourceRoot) return false;
  const sharedRoot = join(resourceRoot, "skills");
  const profileRoot = join(agentDir, "skills");
  const source = isWithin(resourcePath, sharedRoot) ? { root: sharedRoot, key: "enabledSkills" } : isWithin(resourcePath, profileRoot) ? { root: profileRoot, key: "enabledProfileSkills" } : undefined;
  if (!source) return false;

  const name = relative(source.root, resourcePath).replaceAll("\\", "/");
  const profileSettings = profile as Record<string, unknown>;
  const configuredValue = profileSettings[source.key];
  const configured = Array.isArray(configuredValue)
    ? configuredValue.filter((value): value is string => typeof value === "string")
    : undefined;
  let updated: string[];
  if (action.action === "enable") {
    updated = !configured || configured.includes("*") ? (configured ?? ["*"]) : [...new Set([...configured, name])];
  } else if (!configured || configured.includes("*")) {
    const names = [...new Set((await findSkillFiles(source.root)).map((file) => relative(source.root, dirname(file)).replaceAll("\\", "/")))];
    updated = names.filter((entry) => entry !== name);
  } else {
    updated = configured.filter((entry) => entry !== name);
  }

  if (configured && configured.length === updated.length && configured.every((entry, index) => entry === updated[index])) {
    console.log(`Skill "${name}" is already ${action.action}d for this profile.`);
    return true;
  }
  const updatedProfile = { ...(profile as Record<string, unknown>), [source.key]: updated };
  await writeFile(settingsPath, `${JSON.stringify({ ...settings, profile: updatedProfile }, null, 2)}\n`, "utf8");
  console.log(`Skill "${name}" ${action.action}d for this profile. Use /reload to apply.`);
  return true;
}

async function applyAction(action: ParsedAction) {
  const { agentDir, resourceRoot, settings } = await readSettings();
  const settingsPath = join(agentDir, "settings.json");
  const enable = action.action === "enable";

  if (action.kind === "tools") {
    if (!(BUILTIN_TOOLS as readonly string[]).includes(action.target)) {
      throw new Error(`\"${action.target}\" não é uma tool nativa. Desabilite a extension que fornece essa tool.`);
    }
    const configured = Array.isArray(settings.defaultTools)
      ? settings.defaultTools.filter((entry): entry is string => typeof entry === "string")
      : [...BUILTIN_TOOLS];
    const updatedTools = enable
      ? [...new Set([...configured, action.target])]
      : configured.filter((tool) => tool !== action.target);
    if (configured.length === updatedTools.length && configured.every((tool, index) => tool === updatedTools[index])) {
      console.log(`Tool \"${action.target}\" já está ${enable ? "habilitada" : "desabilitada"}.`);
      return;
    }
    const updatedSettings: Record<string, unknown> = { ...settings, defaultTools: updatedTools };
    if (updatedTools.length === BUILTIN_TOOLS.length && BUILTIN_TOOLS.every((tool) => updatedTools.includes(tool))) {
      delete updatedSettings.defaultTools;
    }
    await writeFile(settingsPath, `${JSON.stringify(updatedSettings, null, 2)}\n`, "utf8");
    console.log(`Tool \"${action.target}\" ${enable ? "habilitada" : "desabilitada"} em ${settingsPath}. Use /reload para aplicar.`);
    return;
  }

  const resourcePath = await findResource(action.kind, action.target, settings, agentDir, resourceRoot);
  if (!resourcePath) throw new Error(`${action.kind.slice(0, -1)} \"${action.target}\" não encontrada.`);
  if (action.kind === "skills" && await applyProfileSkillAction(action, resourcePath, settings, agentDir, resourceRoot, settingsPath)) return;
  const entries = Array.isArray(settings[action.kind])
    ? settings[action.kind].filter((entry): entry is string => typeof entry === "string")
    : [];
  const updatedEntries = setExclusion(entries, resourcePath, !enable);
  if (entries.length === updatedEntries.length && entries.every((entry, index) => entry === updatedEntries[index])) {
    console.log(`${action.kind.slice(0, -1)} \"${action.target}\" já está ${enable ? "habilitada" : "desabilitada"}.`);
    return;
  }
  const updatedSettings: Record<string, unknown> = { ...settings, [action.kind]: updatedEntries };
  if (updatedEntries.length === 0) delete updatedSettings[action.kind];
  await writeFile(settingsPath, `${JSON.stringify(updatedSettings, null, 2)}\n`, "utf8");
  console.log(`${action.kind.slice(0, -1)} \"${action.target}\" ${enable ? "habilitada" : "desabilitada"} em ${settingsPath}. Use /reload para aplicar.`);
}

export default async function (pi: ExtensionAPI) {
  pi.registerFlag("list-sessions", {
    description: "List saved Pi sessions",
    type: "boolean",
    default: false,
  });

  const args = process.argv.slice(2);
  // Remote commands must reach the profiles extension before this extension
  // creates its local --no-session helper process. The remote Pi will process
  // resource commands on its own host/runtime.
  if (args[0] === "profile" || args.some((arg) => /^remote:[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(arg))) return;
  const kind = kindFromArgs(args);
  const action = actionFromArgs(args);
  const packageRequested = packageRequestedFromArgs(args);
  const packageAction = packageActionFromArgs(args);
  const sessionRename = sessionRenameFromArgs(args);
  const sessionRequested = args.some((arg) => arg === "--list-sessions" || arg === "--list-sessions=true")
    || args.some((arg, index) => arg === "sessions" && args[index + 1] === "list");
  if (!kind && !action && !packageRequested && !packageAction && !sessionRequested && !sessionRename) return;

  // Run CLI operations in an ephemeral child so they never create an empty session.
  if (process.env.PI_CLI_RESOURCES !== "1" && !sessionRename) {
    const profile = requestedProfile();
    const root = process.env.PI_PROFILE_ROOT ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
    const target = profile ? join(root, "profiles", profile) : process.env.PI_CODING_AGENT_DIR;
    const child = spawn(process.execPath, [process.argv[1], "--no-session", ...args], {
      stdio: "inherit",
      env: { ...process.env, PI_CLI_RESOURCES: "1", PI_CODING_AGENT_DIR: target, PI_PROFILE_ROOT: root, ...(profile ? { PI_ACTIVE_PROFILE: profile } : {}) },
    });
    const code = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
    });
    process.exit(code);
  }

  if (sessionRename) {
    try {
      if (!sessionRename.name) throw new Error("Session name cannot be empty.");
      const profile = process.env.PI_ACTIVE_PROFILE ?? requestedProfile();
      const root = process.env.PI_PROFILE_ROOT ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
      const sessionDir = profile && profile !== "default" ? join(root, "profiles", profile, "sessions") : process.env.PI_CODING_AGENT_SESSION_DIR;
      const sessions = sessionDir ? await SessionManager.listAll(sessionDir) : await SessionManager.listAll();
      const existing = sessions.find((session) => session.id === sessionRename.id);
      if (!existing) throw new Error(`Session '${sessionRename.id}' not found.`);
      SessionManager.open(existing.path, sessionDir, process.cwd()).appendSessionInfo(sessionRename.name);
      console.log(`Session '${sessionRename.id}' renamed to '${sessionRename.name}'.`);
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  if (packageAction) {
    try {
      await applyPackageAction(packageAction);
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  if (action) {
    try {
      await applyAction(action);
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  pi.on("session_start", async () => {
    if (sessionRequested) {
      const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
      const sessions = sessionDir ? await SessionManager.listAll(sessionDir) : await SessionManager.listAll();
      await renderAndClose(React.createElement(SessionTable, { sessions }));
    } else if (packageRequested) {
      const { resourceRoot, settings } = await readSettings();
      await renderAndClose(React.createElement(ResourceTable, { title: "PACKAGES", headers: ["NAME", "STATUS", "VERSION / DESCRIPTION"], rows: await packageRows(resourceRoot, settings), highlightStatus: true }));
    } else if (kind === "tools") {
      const active = new Set(pi.getActiveTools());
      const { resourceRoot, settings } = await readSettings();
      const sources = await packageToolSources(resourceRoot, settings, pi.getAllTools().map((tool) => tool.name));
      const rows: SourceRow[] = pi.getAllTools()
        .map((tool) => [tool.name, active.has(tool.name) ? "enabled" : "disabled", sources.has(tool.name) ? `npm: ${sources.get(tool.name)}` : (BUILTIN_TOOLS as readonly string[]).includes(tool.name) ? "Built-in" : "Extension", tool.description] as SourceRow)
        .sort((a, b) => a[0].localeCompare(b[0]));
      await renderAndClose(React.createElement(SourceTable, { title: "TOOLS", detailHeader: "DESCRIPTION", rows }));
    } else {
      const { agentDir, resourceRoot, settings } = await readSettings();
      const rawEntries = Array.isArray(settings[kind]) ? settings[kind].filter((value): value is string => typeof value === "string") : [];
      const configuredPaths = rawEntries.filter((value) => !/^[!+\-]/.test(value));
      const exclusions = rawEntries.filter((value) => value.startsWith("!"));
      const catalogRoot = join(resourceRoot, kind);
      const packageExtensions = await configuredPackageExtensions(resourceRoot, settings);
      const packagePaths = new Map(packageExtensions.map(({ path, packageName }) => [path, packageName]));
      const paths = kind === "skills"
        ? [...new Set([catalogRoot, ...configuredPaths])]
        : [...new Set([...(configuredPaths.length > 0 ? configuredPaths : [catalogRoot]), ...packageExtensions.map(({ path }) => path)])];
      const rows: SourceRow[] = (kind === "skills" ? await skillRows(paths, catalogRoot, settings, exclusions) : await extensionRows(paths, exclusions)).map((row) => {
        const packageName = packagePaths.get(row[2]);
        const source = packageName ? `Package: ${packageName}` : (row[2].startsWith(join(resourceRoot, "skills")) ? "Shared" : row[2].includes("/profiles/") ? "Profile" : "Local");
        return [row[0], row[1], source, row[2]];
      });
      await renderAndClose(React.createElement(SourceTable, { title: kind.toUpperCase(), detailHeader: "PATH", rows }));
    }
    // This command always runs in an ephemeral child process.
    process.exit(0);
  });
}
