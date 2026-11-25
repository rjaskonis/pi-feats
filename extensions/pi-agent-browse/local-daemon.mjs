import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
try {
  const { runLocalServer } = await jiti.import("./local-server.ts");
  if (!process.argv[2]) throw new Error("A profile browser directory is required");
  await runLocalServer(process.argv[2]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
