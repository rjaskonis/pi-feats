import { spawnSync } from "node:child_process";
import { packageRoot, saveBuildCache } from "./console-webui-cache.mjs";

const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:web:next"], { cwd: packageRoot, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
await saveBuildCache();
console.log("Cached Pi Console WebUI build for future updates.");
