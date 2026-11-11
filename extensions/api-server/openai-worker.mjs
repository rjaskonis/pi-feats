/** Dedicated execution entry: no outer CLI session or stdin consumer. */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const cli = realpathSync(process.argv[2]);
const sdk = join(dirname(cli), "index.js");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": sdk },
});
try {
  // Import the host SDK natively so its classes and provider registry are shared.
  const host = await import(pathToFileURL(sdk).href);
  const { runCompatibilityWorker } = await jiti.import("./openai-execution.ts");
  await runCompatibilityWorker(host);
} catch {
  process.stderr.write("OpenAI worker initialization failed.\n");
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
