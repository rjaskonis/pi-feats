import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildId = join(root, "extensions", "pi-console-webui", ".next", "BUILD_ID");
const mode = process.env.PI_FEATS_BUILD_WEB;
const needsInitialBuild = !existsSync(buildId);

const build = () => {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:web"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (mode === "1") {
  console.log("Rebuilding Pi Console WebUI (PI_FEATS_BUILD_WEB=1).");
  build();
} else if (mode === "0") {
  console.log("Skipping Pi Console WebUI build (PI_FEATS_BUILD_WEB=0).");
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  if (needsInitialBuild) {
    console.log("Pi Console WebUI has no build output; rebuilding it.");
    build();
  } else {
    console.log("Skipping Pi Console WebUI rebuild in a non-interactive install. Run `npm run build:web` or set PI_FEATS_BUILD_WEB=1 to rebuild.");
  }
} else {
  const defaultAnswer = needsInitialBuild ? "Y/n" : "y/N";
  const prompt = needsInitialBuild ? "Pi Console WebUI has not been built yet." : "Rebuild Pi Console WebUI?";
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await readline.question(`${prompt} [${defaultAnswer}] `)).trim().toLowerCase();
  readline.close();
  if (answer === "y" || answer === "yes" || (!answer && needsInitialBuild)) build();
  else console.log("Skipping Pi Console WebUI rebuild. Run `npm run build:web` or set PI_FEATS_BUILD_WEB=1 when needed.");
}
