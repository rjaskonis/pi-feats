import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

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
    await writeFile(temporary, content.endsWith("\n") ? content : `${content}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    const runtime = await ModelRuntime.create({ modelsPath: temporary, refreshOnCreate: false });
    const error = runtime.getError();
    if (error) throw new Error(error.replace(/\n\nFile: .*$/, ""));
    await rename(temporary, path);
    await chmod(path, 0o600);
    return readModelsConfig();
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
