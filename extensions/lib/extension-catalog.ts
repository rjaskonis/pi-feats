import { existsSync, globSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, matchesGlob, relative, resolve } from "node:path";
import { packageExtensions, type InstalledPackage } from "./package-resources.ts";

export type ExtensionIdentity = { name: string; aliases: string[] };
export type CatalogExtension = ExtensionIdentity & { path: string; packageName?: string; enabled: boolean; protected: boolean };
export const requiredRuntimeExtensions = new Set(["profiles", "api-server", "conversation-search"]);
const genericNames = new Set(["index", "pi", "dist", "extension"]);
const technicalName = (path: string) => basename(path, extname(path));
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function packageBase(root: string, source: string): string | undefined {
  if (source.startsWith("npm:")) return join(root, "npm", "node_modules", source.slice(4));
  if (source.startsWith(".") || source.startsWith("/")) return resolve(root, source);
  if (!source.startsWith("git:") && !/^(?:https?|ssh):\/\//.test(source)) return undefined;
  let remote = source.replace(/^git:/, "");
  const ref = remote.lastIndexOf("@");
  if (ref > remote.lastIndexOf("/")) remote = remote.slice(0, ref);
  remote = remote.replace(/^https?:\/\//, "").replace(/^ssh:\/\/git@/, "").replace(/^git@/, "").replace(/^([^/:]+):/, "$1/").replace(/\.git$/, "");
  return join(root, "git", remote);
}

async function discover(path: string): Promise<string[]> {
  if (/[*?\[{}]/.test(path)) {
    const paths = await Promise.all(globSync(path).map(discover));
    return paths.flat();
  }
  if (!existsSync(path)) return [];
  if (/\.(?:ts|js)$/.test(path) || existsSync(join(path, "index.ts")) || existsSync(join(path, "index.js"))) return [path];
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const child = join(path, entry.name);
      return entry.isFile() && /\.(?:ts|js)$/.test(entry.name) || entry.isDirectory() && (existsSync(join(child, "index.ts")) || existsSync(join(child, "index.js"))) ? [child] : [];
    });
  } catch { return []; }
}

// Only the nearest package boundary owns a local entrypoint. Never execute
// extension code to discover its identity, and never cross node_modules.
async function localPackage(path: string): Promise<string | undefined> {
  let directory = /\.(?:ts|js)$/.test(path) ? dirname(path) : path;
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      try {
        const value = JSON.parse(await readFile(manifest, "utf8"));
        return typeof value.name === "string" && value.name.length ? value.name : undefined;
      } catch { return undefined; }
    }
    const parent = dirname(directory);
    if (parent === directory || basename(directory) === "node_modules") return undefined;
    directory = parent;
  }
}

function matchesPattern(path: string, pattern: string, root: string): boolean {
  const normalized = pattern.replace(/^\.\//, "");
  return [path, relative(root, path), basename(path), dirname(path), relative(root, dirname(path)), basename(dirname(path))]
    .some((value) => matchesGlob(value, normalized));
}

function allowedByPatterns(path: string, entries: string[], root: string, restrict = false): boolean {
  const includes = entries.filter((entry) => !/^[!+\-]/.test(entry));
  let allowed = !restrict || includes.some((entry) => matchesPattern(path, entry, root));
  if (entries.some((entry) => entry.startsWith("!") && matchesPattern(path, entry.slice(1), root))) allowed = false;
  if (entries.some((entry) => entry.startsWith("+") && resolve(root, entry.slice(1)) === path)) allowed = true;
  if (entries.some((entry) => entry.startsWith("-") && resolve(root, entry.slice(1)) === path)) allowed = false;
  return allowed;
}

export function extensionEnabled(settings: Record<string, unknown>, extension: ExtensionIdentity & { path: string }, root = "."): boolean {
  const entries = strings(settings.extensions);
  if (!allowedByPatterns(extension.path, entries, root)) return false;
  const policy = (settings.profile as { enabledExtensions?: unknown } | undefined)?.enabledExtensions;
  return !Array.isArray(policy) || policy.includes("*") || extension.aliases.some((alias) => policy.includes(alias));
}

/** One identity and state model for administration and profile injection. */
export async function extensionCatalog(root: string, settings: Record<string, unknown>, extraRoots: string[] = []): Promise<CatalogExtension[]> {
  root = resolve(root);
  const resources = new Map<string, { path: string; packageName?: string; identity?: ExtensionIdentity; packageEnabled?: boolean }>();
  const add = (path: string, packageName?: string, identity?: ExtensionIdentity, packageEnabled?: boolean) => {
    path = resolve(root, path);
    if (existsSync(path)) resources.set(path, { ...resources.get(path), path, ...(packageName ? { packageName } : {}), ...(identity ? { identity } : {}), ...(packageEnabled !== undefined ? { packageEnabled } : {}) });
  };
  for (const declaration of Array.isArray(settings.packages) ? settings.packages : []) {
    const source = typeof declaration === "string" ? declaration : declaration?.source;
    if (typeof source !== "string") continue;
    const base = packageBase(root, source);
    if (!base) continue;
    try {
      const manifest = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
      const pkg: InstalledPackage = { base, name: manifest.name ?? source, manifest };
      const extensions = packageExtensions([pkg]);
      const overrides = typeof declaration === "object" && Array.isArray(declaration.extensions) ? strings(declaration.extensions) : undefined;
      if (Array.isArray(manifest.pi?.extensions)) {
        const manifestEntries = strings(manifest.pi.extensions);
        for (const entry of extensions.filter((entry) => !/^[!+\-]/.test(relative(base, entry.path)))) {
          for (const path of await discover(entry.path)) {
            const identity = /[*?\[{}]/.test(entry.path) ? undefined : entry;
            if (allowedByPatterns(path, manifestEntries, base)) add(path, entry.packageName, identity, !overrides || allowedByPatterns(path, overrides, base, true));
          }
        }
      } else for (const path of await discover(join(base, "extensions"))) add(path, pkg.name, undefined, !overrides || allowedByPatterns(path, overrides, base, true));
    } catch { /* Missing packages do not contribute loadable resources. */ }
  }
  const configured = strings(settings.extensions).filter((entry) => !/^[!+\-]/.test(entry));
  for (const directory of [join(root, "extensions"), ...configured.map((entry) => resolve(root, entry)), ...extraRoots]) {
    for (const path of await discover(directory)) add(path);
  }
  const candidates = await Promise.all([...resources.values()].map(async (resource) => {
    const technical = technicalName(resource.path);
    const packageName = resource.packageName ?? (genericNames.has(technical) ? await localPackage(resource.path) : undefined);
    const shortName = packageName?.replace(/^@[^/]+\//, "");
    // A multi-extension package retains clear entry names; generic entries are
    // qualified below if their preferred package identity collides.
    const name = genericNames.has(technical) && shortName ? shortName : resource.identity?.name ?? technical;
    const aliases = [...new Set([name, ...(resource.identity?.aliases ?? []), technical, ...(genericNames.has(technical) && packageName ? [packageName] : [])])];
    return { name, aliases, path: resource.path, packageEnabled: resource.packageEnabled, ...(packageName ? { packageName } : {}) };
  }));
  const counts = new Map<string, number>();
  for (const entry of candidates) for (const alias of entry.aliases) counts.set(alias, (counts.get(alias) ?? 0) + 1);
  return candidates.map((entry) => {
    // An absolute path is always an unambiguous CLI identifier, even when two
    // installations have identical package and entrypoint names.
    const name = counts.get(entry.name)! > 1 ? entry.path : entry.name;
    const { packageEnabled, ...candidate } = entry;
    const identity = { ...candidate, name, aliases: [...new Set([name, ...entry.aliases])] };
    const protectedExtension = requiredRuntimeExtensions.has(entry.name);
    return { ...identity, enabled: packageEnabled !== false && extensionEnabled(protectedExtension ? { ...settings, profile: undefined } : settings, identity, root), protected: protectedExtension };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveExtension(catalog: CatalogExtension[], target: string): CatalogExtension | undefined {
  const pathMatch = catalog.find((entry) => entry.path === target);
  if (pathMatch) return pathMatch;
  const matches = catalog.filter((entry) => entry.aliases.includes(target));
  if (matches.length > 1) throw Object.assign(new Error(`Extension name "${target}" is ambiguous; use one of these paths:\n${matches.map((entry) => entry.path).join("\n")}`), { status: 409 });
  return matches[0];
}

export function updatedExtensionSettings(settings: Record<string, unknown>, resourcePath: string, identity: ExtensionIdentity & { protected?: boolean }, enable: boolean, root = ".", catalog?: CatalogExtension[]): Record<string, unknown> {
  if (!enable && (identity.protected || requiredRuntimeExtensions.has(identity.name))) throw new Error(`Extension "${identity.name}" is required and cannot be disabled.`);
  const entries = strings(settings.extensions);
  const extensions = entries.filter((entry) => !((entry.startsWith("-") || entry.startsWith("!")) && resolve(root, entry.slice(1)) === resourcePath));
  if (!enable) extensions.push(`-${resourcePath}`);
  else if (!allowedByPatterns(resourcePath, extensions, root)) extensions.push(`+${resourcePath}`);
  const updated = { ...settings };
  if (enable && Array.isArray(settings.packages)) {
    updated.packages = settings.packages.map((declaration) => {
      if (!declaration || typeof declaration !== "object" || typeof declaration.source !== "string" || !Array.isArray(declaration.extensions)) return declaration;
      const base = packageBase(root, declaration.source);
      if (!base) return declaration;
      const local = relative(base, resourcePath);
      if (local.startsWith("..") || resolve(base, local) !== resourcePath) return declaration;
      const patterns = strings(declaration.extensions).filter((entry) => !(entry.startsWith("-") && resolve(base, entry.slice(1)) === resourcePath));
      if (allowedByPatterns(resourcePath, patterns, base, true)) return patterns.length === declaration.extensions.length ? declaration : { ...declaration, extensions: patterns };
      return { ...declaration, extensions: [...patterns, `+${local}`] };
    });
  }
  if (extensions.length) updated.extensions = extensions;
  else delete updated.extensions;
  const profile = settings.profile as Record<string, unknown> | undefined;
  const policy = profile?.enabledExtensions;
  if (Array.isArray(policy) && !policy.includes("*")) {
    const selected = new Set(strings(policy));
    if (catalog) {
      // Expand legacy aliases before changing one resource so a shared alias
      // does not accidentally change the state of a different extension.
      for (const entry of catalog) if (entry.aliases.some((alias) => policy.includes(alias))) selected.add(entry.name);
      for (const entry of catalog) for (const alias of entry.aliases) if (!catalog.some((other) => other.name === alias)) selected.delete(alias);
      selected.delete(identity.name);
    } else for (const alias of identity.aliases) selected.delete(alias);
    if (enable) selected.add(identity.name);
    updated.profile = { ...profile, enabledExtensions: [...selected].sort() };
  }
  return updated;
}
