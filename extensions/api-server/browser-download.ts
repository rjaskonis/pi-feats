import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cloudExtensionArchive } from "./browser-extension-archive.ts";

const filename = "pi-agent-browse-extension.zip";
const downloadPath = `/api/browser/${filename}`;
const archive = new URL(`../../assets/browser-downloads/${filename}`, import.meta.url);

class DownloadUnavailable extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function registerBrowserDownload(
  server: FastifyInstance,
  guard: (request: FastifyRequest, reply: FastifyReply) => boolean,
  { source = archive, publicBaseUrl, relayOrigin }: { source?: URL; publicBaseUrl?: string; relayOrigin?: URL } = {},
): void {
  let prepared: Promise<{ zip: Buffer; url: string }> | undefined;
  const prepare = () => prepared ??= (async () => {
    let template: Buffer;
    try { template = await readFile(source); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new DownloadUnavailable(404, "BROWSER_EXTENSION_NOT_AVAILABLE", "This installation does not bundle the Pi Agent Browse extension archive.");
    }
    const origin = relayOrigin ?? publicBaseUrl;
    if (!origin) return { zip: template, url: downloadPath };
    try {
      const url = relayOrigin?.protocol === "http:" ? downloadPath : new URL(downloadPath, origin).href;
      return { zip: cloudExtensionArchive(template, origin), url };
    } catch (error) {
      server.log.error({ err: error }, "Pi Agent Browse archive configuration failed");
      throw new DownloadUnavailable(503, "BROWSER_EXTENSION_CONFIGURATION_ERROR", "Check the public HTTPS address and rebuild the bundled extension archive if needed.");
    }
  })().catch((error) => { prepared = undefined; throw error; });

  server.get(downloadPath, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const { zip } = await prepare();
      return reply.type("application/zip")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .header("X-Content-Type-Options", "nosniff")
        .send(zip);
    } catch (error) {
      if (!(error instanceof DownloadUnavailable)) throw error;
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
  });

  server.get("/api/browser/download-status", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!guard(request, reply)) return;
    try {
      return { available: true, url: (await prepare()).url };
    } catch (error) {
      if (!(error instanceof DownloadUnavailable)) throw error;
      return { available: false, reason: error.message };
    }
  });
}
