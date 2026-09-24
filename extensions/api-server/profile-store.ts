import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ensureProfileSandbox } from "../lib/profile-sandbox.ts";
import { BUILTIN_TOOLS, activeBuiltinTools, updatedBuiltinTools } from "../lib/builtin-tools.ts";

export { BUILTIN_TOOLS } from "../lib/builtin-tools.ts";
export const RESOURCE_KINDS = ["tools", "skills", "extensions"] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];
type PolicyKey = "enabledTools" | "enabledSkills" | "enabledProfileSkills" | "enabledExtensions";
type SkillSources = { shared?: boolean; profile?: boolean };
type SkillResourceSource = "shared" | "profile" | "package";
export type ProfileMetadata = { description: string; tags: string[] };
type ProfilePolicy = Partial<Record<PolicyKey, string[]>> & Partial<ProfileMetadata> & { skillSources?: SkillSources; contextMemory?: { mode: "file"; target: "profile" | "identity" } | { mode: "handler"; handler: string } };
export type ProfileSettings = Record<string, unknown> & { profile?: ProfilePolicy; sandbox?: boolean };
export type Resource = { name: string; kind: ResourceKind; path?: string; source: "builtin" | "shared" | "profile" | "extension" | "package"; package?: string; enabled: boolean; protected?: boolean };
export type Package = { name: string; version?: string; description?: string; enabled: boolean; installed: boolean };

const validName = (name: string) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name);
const maxProfileDescriptionLength = 500;
const maxProfileTags = 20;
const maxProfileTagLength = 50;
const profileMetadata = (value: unknown): ProfileMetadata => {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > maxProfileDescriptionLength)) throw Object.assign(new Error(`description must be a string of at most ${maxProfileDescriptionLength} characters.`), { status: 400 });
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))) throw Object.assign(new Error("tags must be an array of strings."), { status: 400 });
  const tags = [...new Map((input.tags as string[] | undefined ?? []).map((tag) => tag.trim()).filter(Boolean).map((tag) => [tag.toLocaleLowerCase(), tag])).values()];
  if (tags.length > maxProfileTags || tags.some((tag) => tag.length > maxProfileTagLength)) throw Object.assign(new Error(`Use at most ${maxProfileTags} tags of at most ${maxProfileTagLength} characters.`), { status: 400 });
  return { description: (input.description as string | undefined ?? "").trim(), tags };
};
const policyKey: Record<ResourceKind, PolicyKey> = {
  tools: "enabledTools",
  skills: "enabledSkills",
  extensions: "enabledExtensions",
};
const protectedExtensions = new Set(["profiles", "api-server"]);

export class ProfileStore {
  private readonly extensionTools = new Map<string, Set<string>>();
  readonly agentDir: string;

  constructor(agentDir: string) { this.agentDir = agentDir; }

  registerExtensionTools(profile: string, names: Iterable<string>): void {
    const tools = this.extensionTools.get(profile) ?? new Set<string>();
    for (const name of names) if (name && !(BUILTIN_TOOLS as readonly string[]).includes(name)) tools.add(name);
    this.extensionTools.set(profile, tools);
  }

  extensionToolNames(profile: string): Iterable<string> {
    return this.extensionTools.get(profile) ?? [];
  }

  clearExtensionTools(profile?: string): void {
    if (profile) this.extensionTools.delete(profile);
    else this.extensionTools.clear();
  }

  private profilesDir(): string { return join(this.agentDir, "profiles"); }
  directory(name: string): string {
    if (name === "default") return this.agentDir;
    if (!validName(name)) throw Object.assign(new Error("Invalid profile"), { status: 404 });
    return join(this.profilesDir(), name);
  }
  private settingsPath(name: string): string { return join(this.directory(name), "settings.json"); }
  private async linkSharedModels(name: string): Promise<void> {
    if (name === "default") return;
    const source = join(this.agentDir, "models.json"), target = join(this.directory(name), "models.json");
    try { if (resolve(this.directory(name), await readlink(target)) === source) return; } catch { /* Missing or non-symlink target must be replaced. */ }
    await rm(target, { force: true });
    if (existsSync(source)) await symlink(source, target);
  }
  private skillSources(name: string, settings: ProfileSettings): Required<SkillSources> {
    if (name === "default") return { shared: true, profile: false };
    return { shared: settings.profile?.skillSources?.shared !== false, profile: settings.profile?.skillSources?.profile === true };
  }
  private skillBase(name: string, source: "shared" | "profile"): string {
    return source === "shared" ? join(this.agentDir, "skills") : join(this.directory(name), "skills");
  }

  async readSettings(name: string): Promise<ProfileSettings> {
    const path = this.settingsPath(name);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings.json must contain an object");
      await this.linkSharedModels(name);
      return value as ProfileSettings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && name === "default") return {};
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("Profile not found"), { status: 404 });
      throw error;
    }
  }

  async list(): Promise<Array<{ name: string; path: string } & ProfileMetadata>> {
    const names = ["default"];
    if (existsSync(this.profilesDir())) for (const entry of await readdir(this.profilesDir(), { withFileTypes: true })) if (entry.isDirectory() && existsSync(join(this.profilesDir(), entry.name, "settings.json"))) names.push(entry.name);
    const profiles = await Promise.all(names.map(async (name) => {
      const settings = await this.readSettings(name);
      return { name, path: this.directory(name), ...profileMetadata(settings.profile) };
    }));
    return profiles.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async skillNames(base: string): Promise<Array<{ name: string; path: string }>> {
    if (!existsSync(base)) return [];
    const skills: Array<{ name: string; path: string }> = [];
    const visit = async (directory: string): Promise<void> => {
      if (existsSync(join(directory, "SKILL.md"))) { skills.push({ name: relative(base, directory).replaceAll("\\", "/"), path: directory }); return; }
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await visit(join(directory, entry.name));
    };
    await visit(base);
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async names(kind: Exclude<ResourceKind, "tools" | "skills">): Promise<Array<{ name: string; path: string }>> {
    const base = join(this.agentDir, kind);
    if (!existsSync(base)) return [];
    const entries = await readdir(base, { withFileTypes: true });
    return entries.flatMap((entry) => {
      if (entry.isFile() && /\.(?:ts|js)$/.test(entry.name)) return [{ name: entry.name.replace(/\.(?:ts|js)$/, ""), path: join(base, entry.name) }];
      if (entry.isDirectory() && (existsSync(join(base, entry.name, "index.ts")) || existsSync(join(base, entry.name, "index.js")))) return [{ name: entry.name, path: join(base, entry.name) }];
      return [];
    });
  }

  private enabled(settings: ProfileSettings, kind: ResourceKind, name: string, path?: string): boolean {
    const values = settings.profile?.[policyKey[kind]];
    if (values) return values.includes("*") || values.includes(name);
    if (kind === "tools" && (BUILTIN_TOOLS as readonly string[]).includes(name)) return activeBuiltinTools(settings).includes(name);
    const configured = settings[kind];
    const exclusions = Array.isArray(configured) ? configured.filter((value): value is string => typeof value === "string" && value.startsWith("!")) : [];
    return !path || !exclusions.includes(`!${path}`);
  }

  private async packageSkillResources(settings: ProfileSettings): Promise<Resource[]> {
    const resources: Resource[] = [];
    for (const pkg of await this.configuredPackages(settings)) {
      for (const entry of Array.isArray(pkg.manifest?.pi?.skills) ? pkg.manifest.pi.skills : []) {
        if (typeof entry !== "string") continue;
        for (const skill of await this.skillNames(join(pkg.base, entry))) resources.push({ name: skill.name, kind: "skills", path: skill.path, source: "package", package: pkg.name, enabled: this.skillEnabled(settings, "package", skill.name) });
      }
    }
    return resources;
  }

  private async skillResources(profile: string, settings: ProfileSettings, runtimeSettings: ProfileSettings = settings): Promise<Resource[]> {
    const sources = this.skillSources(profile, settings);
    const entries = await Promise.all((["profile", "shared"] as const).filter((source) => sources[source]).map(async (source) => ({ source, entries: await this.skillNames(this.skillBase(profile, source)) })));
    const local = entries.flatMap(({ source, entries }) => entries.map(({ name, path }) => ({ name, kind: "skills" as const, path, source, enabled: this.skillEnabled(settings, source, name) })));
    return [...local, ...(sources.shared ? await this.packageSkillResources(runtimeSettings) : [])];
  }

  private skillEnabled(settings: ProfileSettings, source: SkillResourceSource, name: string): boolean {
    const values = settings.profile?.[source === "profile" ? "enabledProfileSkills" : "enabledSkills"];
    return !values || values.includes("*") || values.includes(name);
  }

  private packageBase(source: string): string | undefined {
    if (source.startsWith("npm:")) return join(this.agentDir, "npm", "node_modules", source.slice(4));
    if (source.startsWith(".") || source.startsWith("/")) return resolve(this.agentDir, source);
    if (!source.startsWith("git:") && !/^(?:https?|ssh):\/\//.test(source)) return undefined;
    let remote = source.replace(/^git:/, ""), ref = remote.lastIndexOf("@");
    if (ref > remote.lastIndexOf("/")) remote = remote.slice(0, ref);
    remote = remote.replace(/^https?:\/\//, "").replace(/^ssh:\/\/git@/, "").replace(/^git@/, "").replace(/^([^/:]+):/, "$1/").replace(/\.git$/, "");
    return join(this.agentDir, "git", remote);
  }

  private async configuredPackages(settings: ProfileSettings): Promise<Array<{ source: string; base: string; name: string; manifest?: { version?: string; description?: string; pi?: { extensions?: unknown; skills?: unknown } } }>> {
    const sources = Array.isArray(settings.packages) ? settings.packages.filter((value): value is string => typeof value === "string") : [];
    const packages: Array<{ source: string; base: string; name: string; manifest?: { version?: string; description?: string; pi?: { extensions?: unknown; skills?: unknown } } }> = [];
    for (const source of sources) {
      const base = this.packageBase(source); if (!base) continue;
      try { const manifest = JSON.parse(await readFile(join(base, "package.json"), "utf8")) as { name?: string; version?: string; description?: string; pi?: { extensions?: unknown; skills?: unknown } }; packages.push({ source, base, name: manifest.name ?? source, manifest }); }
      catch { packages.push({ source, base, name: source.replace(/^npm:/, "") }); }
    }
    return packages;
  }

  async packages(_profile: string): Promise<Package[]> {
    const settings = await this.readSettings("default");
    return (await this.configuredPackages(settings)).map((pkg) => ({ name: pkg.name, version: pkg.manifest?.version, description: pkg.manifest?.description, enabled: existsSync(join(pkg.base, "package.json")), installed: existsSync(join(pkg.base, "package.json")) })).sort((left, right) => left.name.localeCompare(right.name));
  }

  async setPackage(_profile: string, name: string, enabled: boolean): Promise<Package> {
    if (!/^(?:@[-a-zA-Z0-9_.]+\/)?[-a-zA-Z0-9_.]+$/.test(name)) throw Object.assign(new Error("Invalid package name"), { status: 400 });
    if (!existsSync(join(this.agentDir, "npm", "node_modules", name, "package.json"))) throw Object.assign(new Error("Package is not installed globally"), { status: 404 });
    const settings = await this.readSettings("default"), entry = `npm:${name}`;
    const packages = Array.isArray(settings.packages) ? settings.packages.filter((value): value is string => typeof value === "string" && value !== name && value !== entry) : [];
    if (enabled) packages.push(entry);
    if (packages.length) settings.packages = packages; else delete settings.packages;
    await this.writeSettings("default", settings);
    return (await this.packages("default")).find((item) => item.name === name)!;
  }

  private async packageExtensions(settings: ProfileSettings): Promise<Array<{ name: string; path: string; package: string }>> {
    const entries: Array<{ name: string; path: string; package: string }> = [];
    for (const pkg of await this.configuredPackages(settings)) {
      for (const extension of Array.isArray(pkg.manifest?.pi?.extensions) ? pkg.manifest.pi.extensions : []) if (typeof extension === "string") entries.push({ name: extension.split("/").pop()?.replace(/\.(?:ts|js)$/, "") ?? pkg.name, path: join(pkg.base, extension), package: pkg.name });
    }
    return entries;
  }

  private async packageToolSources(settings: ProfileSettings, names: Iterable<string>): Promise<Map<string, string>> {
    const sources = new Map<string, string>(), tools = [...names];
    for (const extension of await this.packageExtensions(settings)) try {
      const source = await readFile(extension.path, "utf8");
      for (const tool of tools) if (!(BUILTIN_TOOLS as readonly string[]).includes(tool) && (source.includes(`"${tool}"`) || source.includes(`'${tool}'`) || source.includes(`\`${tool}\``))) sources.set(tool, extension.package);
      for (const block of source.matchAll(/TOOL_NAMES[^=]*=\s*\{([\s\S]*?)\}/g)) for (const name of block[1].matchAll(/:\s*["']([A-Za-z][A-Za-z0-9_-]{0,63})["']/g)) if (!(BUILTIN_TOOLS as readonly string[]).includes(name[1])) sources.set(name[1], extension.package);
    } catch {}
    return sources;
  }

  async resources(profile: string, kind: ResourceKind): Promise<Resource[]> {
    const settings = await this.readSettings(profile);
    const runtimeSettings = profile === "default" ? settings : await this.readSettings("default");
    if (kind === "skills") return this.skillResources(profile, settings, runtimeSettings);
    if (kind === "tools") {
      const extensionTools = this.extensionToolNames(profile);
      const sources = await this.packageToolSources(runtimeSettings, extensionTools);
      const names = new Set([...extensionTools, ...sources.keys()]);
      return [...BUILTIN_TOOLS.map((name) => ({ name, kind, source: "builtin" as const, enabled: this.enabled(settings, kind, name) })), ...[...names].sort().map((name) => sources.has(name) ? ({ name, kind, source: "package" as const, package: sources.get(name), enabled: this.enabled(settings, kind, name) }) : ({ name, kind, source: "extension" as const, enabled: this.enabled(settings, kind, name) }))];
    }
    return [...(await this.names("extensions")).map(({ name, path }) => ({ name, kind, path, source: "shared" as const, enabled: protectedExtensions.has(name) ? true : this.enabled(runtimeSettings, kind, name, path), protected: protectedExtensions.has(name) || undefined })), ...(await this.packageExtensions(runtimeSettings)).map(({ name, path, package: packageName }) => ({ name, kind, path, source: "package" as const, package: packageName, enabled: protectedExtensions.has(name) ? true : this.enabled(runtimeSettings, kind, name, path), protected: protectedExtensions.has(name) || undefined }))];
  }

  async resource(profile: string, kind: ResourceKind, name: string, source?: SkillResourceSource): Promise<Resource> {
    const resource = (await this.resources(profile, kind)).find((item) => item.name === name && (!source || item.source === source));
    if (!resource) throw Object.assign(new Error("Resource not found"), { status: 404 });
    return resource;
  }

  private async skillPaths(name: string, settings: ProfileSettings): Promise<string[]> {
    const runtimeSettings = name === "default" ? settings : await this.readSettings("default");
    return (await this.skillResources(name, settings, runtimeSettings)).filter((skill) => skill.enabled).map((skill) => skill.path!).filter(Boolean);
  }

  private async materializeResources(name: string, settings: ProfileSettings): Promise<ProfileSettings> {
    const profile = { ...(settings.profile ?? {}) };
    if (name !== "default") delete profile.enabledExtensions;
    const normalized: ProfileSettings = {
      ...settings,
      skills: await this.skillPaths(name, settings),
      prompts: [join(this.agentDir, "prompts")],
      themes: [join(this.agentDir, "themes")],
      profile,
    };
    if (name !== "default") {
      delete normalized.extensions;
      delete normalized.packages;
    }
    return normalized;
  }

  async writeSettings(name: string, settings: ProfileSettings): Promise<ProfileSettings> {
    const normalized = await this.materializeResources(name, settings);
    await mkdir(this.directory(name), { recursive: true });
    await writeFile(this.settingsPath(name), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }

  skillImportDirectory(profile: string): string { return profile === "default" ? join(this.agentDir, "skills") : join(this.directory(profile), "skills"); }

  async refreshSkills(profile: string): Promise<void> {
    const settings = await this.readSettings(profile);
    if (profile !== "default") settings.profile = { ...(settings.profile ?? {}), skillSources: { ...this.skillSources(profile, settings), profile: true } };
    await this.writeSettings(profile, settings);
  }

  async readSkillSources(profile: string): Promise<Required<SkillSources>> { return this.skillSources(profile, await this.readSettings(profile)); }

  async writeSkillSources(profile: string, sources: SkillSources): Promise<Required<SkillSources>> {
    if (profile === "default") throw Object.assign(new Error("The default profile always uses Shared Skills."), { status: 422 });
    if (typeof sources.shared !== "boolean" || typeof sources.profile !== "boolean" || (!sources.shared && !sources.profile)) throw Object.assign(new Error("Enable at least one skill source."), { status: 400 });
    const settings = await this.readSettings(profile);
    settings.profile = { ...(settings.profile ?? {}), skillSources: sources };
    await this.writeSettings(profile, settings);
    await mkdir(this.skillBase(profile, "profile"), { recursive: true });
    await ensureProfileSandbox(this.directory(profile), resolve(process.argv[1]));
    return this.skillSources(profile, settings);
  }

  async readSkillDocument(profile: string, name: string, source?: SkillResourceSource): Promise<{ name: string; frontmatter: Record<string, string>; content: string }> {
    const skill = await this.resource(profile, "skills", name, source);
    if (!skill.path) throw Object.assign(new Error("Skill document not found"), { status: 404 });
    const document = await readFile(join(skill.path, "SKILL.md"), "utf8");
    const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const frontmatter: Record<string, string> = {};
    if (match) {
      for (const line of match[1].split(/\r?\n/)) {
        const separator = line.indexOf(":");
        if (separator > 0) frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['\"]|['\"]$/g, "");
      }
    }
    return { name, frontmatter, content: match ? document.slice(match[0].length) : document };
  }

  async setResource(profile: string, kind: ResourceKind, name: string, enabled: boolean, source?: SkillResourceSource): Promise<Resource> {
    const current = await this.resource(profile, kind, name, source);
    if (current.protected && !enabled) throw Object.assign(new Error("This extension is required and cannot be disabled."), { status: 422 });
    // The default profile uses Pi's defaultTools setting for native tool state
    // unless it already has a legacy explicit enabledTools policy. Named profiles
    // retain their explicit enabledTools policy.
    if (kind === "tools" && current.source === "builtin" && profile === "default") {
      const settings = await this.readSettings(profile);
      if (!settings.profile?.enabledTools) {
        const tools = updatedBuiltinTools(settings, name, enabled);
        if (tools) settings.defaultTools = tools;
        else delete settings.defaultTools;
        await this.writeSettings(profile, settings);
        return this.resource(profile, kind, name, source);
      }
    }
    // Extensions are shared runtime resources, so toggling one always updates
    // the default runtime rather than materializing it in a profile workspace.
    const settingsProfile = kind === "extensions" ? "default" : profile;
    const settings = await this.readSettings(settingsProfile);
    const key: PolicyKey = kind === "skills" ? (current.source === "profile" ? "enabledProfileSkills" : "enabledSkills") : policyKey[kind];
    const allNames = (await this.resources(profile, kind)).filter((item) => kind !== "skills" || item.source === current.source).map((item) => item.name);
    const selected = new Set(settings.profile?.[key]?.includes("*") || !settings.profile?.[key] ? allNames : settings.profile![key]);
    if (enabled) selected.add(name);
    else selected.delete(name);
    settings.profile = { ...(settings.profile ?? {}), [key]: [...selected].sort() };
    await this.writeSettings(settingsProfile, settings);
    return this.resource(profile, kind, name, source);
  }

  async deleteSkill(profile: string, name: string, source?: SkillResourceSource): Promise<void> {
    const current = await this.resource(profile, "skills", name, source);
    if (current.source === "package") throw Object.assign(new Error("Package Skills cannot be deleted here."), { status: 403 });
    if (current.source === "shared" && profile !== "default") { await this.setResource(profile, "skills", name, false, "shared"); return; }
    if (!current.path) throw Object.assign(new Error("Skill path not found."), { status: 404 });
    await rm(current.path, { recursive: true, force: false });
    await this.refreshSkills(profile);
  }

  async create(name: string, metadata: unknown = {}, cloneFrom?: string): Promise<{ name: string; path: string } & ProfileMetadata> {
    if (!validName(name) || name === "default") throw Object.assign(new Error("Invalid profile name"), { status: 400 });
    const destination = this.directory(name);
    if (existsSync(destination)) throw Object.assign(new Error("Profile already exists"), { status: 409 });
    const details = profileMetadata(metadata);
    if (cloneFrom !== undefined && (typeof cloneFrom !== "string" || !validName(cloneFrom) || cloneFrom === "default")) throw Object.assign(new Error("Clone source must be an existing named profile."), { status: 400 });

    let sourceSettings: ProfileSettings | undefined;
    let sourceDirectory: string | undefined;
    if (cloneFrom) {
      sourceSettings = await this.readSettings(cloneFrom);
      sourceDirectory = this.directory(cloneFrom);
    }

    try {
      await mkdir(join(destination, "sessions"), { recursive: true });
      let settings: ProfileSettings;
      if (sourceSettings && sourceDirectory) {
        const sourceSkills = join(sourceDirectory, "skills");
        if (existsSync(sourceSkills)) await cp(sourceSkills, join(destination, "skills"), { recursive: true, force: false });
        for (const file of ["SOUL.md", "REFINE.md", "guardrails.json", ".env", "auth.json"]) {
          const source = join(sourceDirectory, file);
          if (existsSync(source)) await copyFile(source, join(destination, file));
        }
        settings = {
          ...sourceSettings,
          sandbox: true,
          profile: { ...(sourceSettings.profile ?? {}), ...details },
        };
      } else {
        let base: ProfileSettings = {};
        try { base = await this.readSettings("default"); } catch {}
        const { packages: _packages, extensions: _extensions, ...profileBase } = base;
        settings = {
          ...profileBase,
          defaultTools: BUILTIN_TOOLS,
          sandbox: true,
          profile: { enabledTools: ["*"], enabledSkills: ["*"], enabledProfileSkills: ["*"], skillSources: { shared: true, profile: false }, ...details },
        };
      }
      await this.writeSettings(name, settings);
      await ensureProfileSandbox(destination, resolve(process.argv[1]));
      if (!sourceSettings) {
        await writeFile(join(destination, "SOUL.md"), "", "utf8");
        await writeFile(join(destination, "guardrails.json"), "{\n  \"guardrails\": []\n}\n", "utf8");
        const auth = join(this.agentDir, "auth.json");
        if (existsSync(auth)) await copyFile(auth, join(destination, "auth.json"));
      }
      await this.linkSharedModels(name);
      return { name, path: destination, ...details };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async updateMetadata(name: string, metadata: unknown): Promise<{ name: string; path: string } & ProfileMetadata> {
    const details = profileMetadata(metadata);
    const settings = await this.readSettings(name);
    await this.writeSettings(name, { ...settings, profile: { ...(settings.profile ?? {}), ...details } });
    return { name, path: this.directory(name), ...details };
  }

  async delete(name: string): Promise<void> {
    if (name === "default") throw Object.assign(new Error("The default profile cannot be deleted"), { status: 400 });
    await this.readSettings(name);
    await rm(this.directory(name), { recursive: true, force: false });
  }

  async readApplicationWorkingSessions(profile: string, application: string): Promise<Record<string, { sessionId: string; updatedAt: string; reason: "message" | "rollover" }>> {
    await this.readSettings(profile);
    try {
      const value = JSON.parse(await readFile(join(this.directory(profile), "application-sessions.json"), "utf8")) as { applications?: Record<string, unknown> };
      const sessions = value.applications?.[application];
      return sessions && typeof sessions === "object" && !Array.isArray(sessions) ? sessions as Record<string, { sessionId: string; updatedAt: string; reason: "message" | "rollover" }> : {};
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }

  async setApplicationWorkingSession(profile: string, application: string, key: string, session: { sessionId: string; updatedAt: string; reason: "message" | "rollover" }): Promise<void> {
    await this.readSettings(profile);
    const path = join(this.directory(profile), "application-sessions.json");
    let value: { applications: Record<string, Record<string, unknown>> } = { applications: {} };
    try { value = JSON.parse(await readFile(path, "utf8")) as typeof value; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    value.applications ??= {}; value.applications[application] ??= {}; value.applications[application][key] = session;
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  async readGuardrailsConfig(profile: string): Promise<string> {
    await this.readSettings(profile);
    try { return await readFile(join(this.directory(profile), "guardrails.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{\n  \"guardrails\": []\n}\n"; throw error; }
  }

  async writeGuardrailsConfig(profile: string, content: string): Promise<void> {
    await this.readSettings(profile);
    if (typeof content !== "string") throw Object.assign(new Error("The 'content' field must be a string."), { status: 400 });
    JSON.parse(content);
    await writeFile(join(this.directory(profile), "guardrails.json"), content, "utf8");
  }

  private guardrailPath(file: string): string {
    if (typeof file !== "string" || file !== file.split("/").pop() || !file.endsWith(".md")) throw Object.assign(new Error("Invalid guardrail file"), { status: 400 });
    return join(this.agentDir, "guardrails", file);
  }

  async readGuardrailDocument(profile: string, file: string): Promise<string> {
    await this.readSettings(profile);
    try { return await readFile(this.guardrailPath(file), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }

  async writeGuardrailDocument(profile: string, file: string, content: string): Promise<void> {
    await this.readSettings(profile);
    if (typeof content !== "string") throw Object.assign(new Error("The 'content' field must be a string."), { status: 400 });
    const path = this.guardrailPath(file);
    await mkdir(join(this.agentDir, "guardrails"), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  async readDocument(profile: string, document: "SOUL.md" | "REFINE.md"): Promise<string> {
    await this.readSettings(profile);
    try { return await readFile(join(this.directory(profile), document), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }

  async writeDocument(profile: string, document: "SOUL.md" | "REFINE.md", content: string): Promise<void> {
    await this.readSettings(profile);
    if (typeof content !== "string") throw Object.assign(new Error("The 'content' field must be a string."), { status: 400 });
    await writeFile(join(this.directory(profile), document), content, "utf8");
  }
}
