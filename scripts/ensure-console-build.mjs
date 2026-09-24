import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { clearBuildCache, cacheStatus, packageRoot, restoreCachedBuild } from "./console-webui-cache.mjs";

const mode = process.env.PI_FEATS_BUILD_WEB;
if (process.env.PI_FEATS_CLEAR_WEB_CACHE === "1") {
  await clearBuildCache();
  console.log("Cleared the cached Pi Console WebUI build.");
}

const build = () => {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:web"], { cwd: packageRoot, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const prompt = async (message) => {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await readline.question(message)).trim().toLowerCase();
  readline.close();
  return answer === "" || answer === "y" || answer === "yes";
};

if (mode === "1") {
  console.log("Rebuilding Pi Console WebUI (PI_FEATS_BUILD_WEB=1).");
  build();
} else if (mode === "0") {
  console.log("Skipping Pi Console WebUI rebuild (PI_FEATS_BUILD_WEB=0).");
} else {
  const status = await cacheStatus();
  if (status.state === "compatible" && await restoreCachedBuild()) {
    console.log("Restored cached Pi Console WebUI build; no frontend changes were detected.");
  } else {
    const message = status.state === "changed"
      ? "Pi Console WebUI changed in this update.\n\nRebuild now? [Y/n]\n  y  Rebuild now (recommended)\n  n  Keep the previous Console build\n> "
      : "No compatible Pi Console WebUI build is available.\n\nBuild now? [Y/n]\n> ";
    if (!process.stdin.isTTY || !process.stdout.isTTY || await prompt(message)) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) console.log("Rebuilding Pi Console WebUI in a non-interactive install.");
      build();
    } else {
      console.log("Skipped Pi Console WebUI rebuild. The Console may not match this package version until you run `npm run build:web`.");
    }
  }
}
