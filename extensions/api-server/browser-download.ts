import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cloudExtensionArchive } from "./browser-extension-archive.ts";

const filename = "pi-agent-browse-extension.zip";
const archive = new URL(`../../assets/pi-agent-browse/${filename}`, import.meta.url);

export function registerBrowserDownload(
  server: FastifyInstance,
  guard: (request: FastifyRequest, reply: FastifyReply) => boolean,
  { source = archive, publicBaseUrl }: { source?: URL; publicBaseUrl?: string } = {},
): void {
  server.get(`/api/browser/${filename}`, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!guard(request, reply)) return;
    try {
      const template = await readFile(source);
      let zip: Buffer = template;
      if (publicBaseUrl) {
        try {
          zip = cloudExtensionArchive(template, publicBaseUrl);
        } catch (error) {
          request.log.error({ err: error }, "Pi Agent Browse archive configuration failed");
          return reply.code(503).send({ error: { code: "BROWSER_EXTENSION_CONFIGURATION_ERROR", message: "The remote extension download is not configured correctly." } });
        }
      }
      return reply.type("application/zip")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .header("X-Content-Type-Options", "nosniff")
        .send(zip);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return reply.code(404).send({
        error: { code: "BROWSER_EXTENSION_NOT_AVAILABLE", message: "This installation does not bundle the Pi Agent Browse extension archive." },
      });
    }
  });
}
