import { redirect } from "next/navigation";
import { Console, type ConsoleInitialData } from "@/components/console";
import { authenticated } from "@/lib/auth";
import { piGet } from "@/lib/pi-api";
import { readAdminConfig } from "@/lib/admin-config";
import { readModelsConfig } from "@/lib/admin-models";

type Props = { section: string; applicationSlug?: string; profile?: string };
export async function ConsolePage({ section, applicationSlug, profile = "default" }: Props) {
  if (!(await authenticated())) redirect("/login");
  let initial: ConsoleInitialData = {};
  try {
    if (section === "api-server") initial.adminConfig = await readAdminConfig("api-server");
    else if (section === "pi-console-webui") initial.adminConfig = await readAdminConfig("pi-console-webui");
    else if (section === "models") initial.models = await readModelsConfig();
    else if (section === "settings") initial.settings = await piGet(`profiles/${profile}/settings`);
    else if (section === "env") initial.env = await piGet(`profiles/${profile}/env`);
    else if (section === "soul") initial.document = await piGet(`profiles/${profile}/${section}`);
    else if (section === "guardrails") initial.guardrails = await piGet(`profiles/${profile}/guardrails`);
    else if (section === "packages") initial.packages = await piGet(`profiles/${profile}/packages`);
    else if (section === "pulses") initial.pulses = await piGet(`profiles/${profile}/pulses`);
    // Tool discovery can require booting a sandboxed Pi runtime. Let the client
    // render the Tools workspace immediately and load its catalog asynchronously.
    else if (section === "skills" || section === "extensions") initial.resources = await piGet(`profiles/${profile}/resources/${section}`);
  } catch (error) { initial.error = error instanceof Error ? error.message : String(error); }
  return <Console section={section} applicationSlug={applicationSlug} initial={initial}/>;
}
