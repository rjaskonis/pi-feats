import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const modelsPath = () => join(agentDir(), "models.json");
const emptyModels = "{\n  \"providers\": {}\n}\n";

export async function readModelsConfig() {
  try {
    return await readFile(modelsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyModels;
    throw error;
  }
}

export async function writeModelsConfig(content: unknown) {
  if (typeof content !== "string") throw new Error("models.json content must be a string.");
  const path = modelsPath();
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch (error) { throw new Error(`Invalid models.json: ${error instanceof Error ? error.message : String(error)}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid models.json: the root value must be an object.");
    const providers = (parsed as { providers?: unknown }).providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) throw new Error("Invalid models.json: providers must be an object.");
    await writeFile(temporary, content.endsWith("\n") ? content : `${content}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    return readModelsConfig();
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
