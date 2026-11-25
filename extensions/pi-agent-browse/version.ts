import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function browserRuntimeVersion() {
  const hash = createHash("sha256");
  for (const file of ["local-daemon.mjs", "local-server.ts", "local-access.ts", "routes.ts", "broker.ts", "actions.ts", "pairing.ts", "version.ts"]) hash.update(readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}
