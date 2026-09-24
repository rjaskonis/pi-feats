import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const webuiRoot = join(packageRoot, "extensions", "pi-console-webui");
const agentRoot = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const cacheRoot = process.env.PI_FEATS_WEB_BUILD_CACHE_DIR ?? join(agentRoot, "cache", "pi-feats", "console-webui");
const cacheBuild = join(cacheRoot, "next-build");
const metadataPath = join(cacheRoot, "metadata.json");
const targetBuild = join(webuiRoot, ".next");

async function sourceHash(path) {
  const hash = createHash("sha256");
  const visit = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if ([".next", "node_modules"].includes(entry.name)) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) {
        hash.update(relative(webuiRoot, fullPath));
        hash.update(await readFile(fullPath));
      }
    }
  };
  await visit(path);
  return hash.digest("hex");
}

const gitCommit = () => {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
};

export async function buildMetadata() {
  const next = JSON.parse(await readFile(join(packageRoot, "node_modules", "next", "package.json"), "utf8"));
  return { sourceHash: await sourceHash(webuiRoot), nodeVersion: process.version, nextVersion: next.version, commit: gitCommit(), builtAt: new Date().toISOString() };
}

export async function loadCache() {
  try { return JSON.parse(await readFile(metadataPath, "utf8")); }
  catch { return undefined; }
}

export async function cacheStatus() {
  const metadata = await buildMetadata();
  const cached = await loadCache();
  if (!cached || !existsSync(join(cacheBuild, "BUILD_ID"))) return { state: "missing", metadata };
  if (cached.nodeVersion !== metadata.nodeVersion || cached.nextVersion !== metadata.nextVersion) return { state: "incompatible", metadata, cached };
  if (cached.sourceHash !== metadata.sourceHash) return { state: "changed", metadata, cached };
  return { state: "compatible", metadata, cached };
}

export async function restoreCachedBuild() {
  if (!existsSync(join(cacheBuild, "BUILD_ID"))) return false;
  await rm(targetBuild, { recursive: true, force: true });
  await cp(cacheBuild, targetBuild, { recursive: true });
  return true;
}

export async function saveBuildCache(metadata) {
  if (!metadata) metadata = await buildMetadata();
  if (!existsSync(join(targetBuild, "BUILD_ID"))) throw new Error("Next.js completed without producing .next/BUILD_ID.");
  const staging = join(cacheRoot, `next-build-${process.pid}-${Date.now()}`);
  await mkdir(cacheRoot, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await cp(targetBuild, staging, { recursive: true });
  await rm(cacheBuild, { recursive: true, force: true });
  await rename(staging, cacheBuild);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export async function clearBuildCache() {
  await rm(cacheRoot, { recursive: true, force: true });
}
