import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Both dist/cli.js and the installed dist/bundle/cli.js belong to this package. */
export function sdkEntryForCli(entry) {
  let directory = dirname(realpathSync(entry));
  while (true) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (manifest?.name === "@earendil-works/pi-coding-agent") return join(directory, "dist", "index.js");
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Unsupported Pi CLI installation.");
    directory = parent;
  }
}
