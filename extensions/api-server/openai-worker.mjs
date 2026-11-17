/** Dedicated execution entry: no outer CLI session or stdin consumer. */
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { sdkEntryForCli } from "./openai-worker-paths.mjs";

try {
  const sdk = sdkEntryForCli(process.argv[2]);
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { "@earendil-works/pi-coding-agent": sdk },
  });
  // Import the host SDK natively so its classes and provider registry are shared.
  const host = await import(pathToFileURL(sdk).href);
  if (process.env.PI_PROFILE_WORKER === "1") {
    const { runProfileWorker } = await jiti.import("./profile-worker.ts");
    // A fresh loader alone reuses cached extension factories (including their
    // module-level identity state). Clear that cache between resident jobs.
    const { clearExtensionCache } = await import(pathToFileURL(join(dirname(sdk), "core", "extensions", "loader.js")).href);
    await runProfileWorker(host, clearExtensionCache);
    // The resident entry owns stdin, signals and process lifetime.
    await new Promise(() => {});
  } else if (process.env.PI_OPENAI_CLIENT_TOOLS_WORKER === "1") {
    const { runClientToolsWorker } = await jiti.import("./openai-client-worker.ts");
    await runClientToolsWorker(host);
  } else {
    const { runCompatibilityWorker } = await jiti.import("./openai-execution.ts");
    await runCompatibilityWorker(host);
  }
} catch {
  process.stderr.write("OpenAI worker initialization failed.\n");
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
