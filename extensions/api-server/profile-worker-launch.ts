import { fileURLToPath } from "node:url";
import { piCommand, piRuntimeEntry } from "../lib/pi-command.ts";
import { prepareProfileLaunch, type ProfileLaunch } from "../lib/profile-launch.ts";
import { CompatibilityError } from "./openai-contract.ts";

export function profileWorkerEnvironment(root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base, PI_CODING_AGENT_DIR: root, PI_PROFILE_ROOT: root, PI_OPENAI_WORKER: "1", PI_OPENAI_CLIENT_TOOLS_WORKER: "0" } as NodeJS.ProcessEnv;
  for (const key of Object.keys(env)) if (key.startsWith("PI_APPLICATION_") || key === "PI_API_WORKER" || key === "PI_PROFILE_DISCOVER_TOOLS") delete env[key];
  return env;
}

export function launchProfileWorkerViaCli(root: string, profile: string, cwd: string, entry?: string, base?: NodeJS.ProcessEnv): ProfileLaunch {
  const pi = piCommand(entry);
  return { command: pi.command, args: [...pi.args, "profile", profile, "--mode", "rpc", "--no-session"], cwd, env: profileWorkerEnvironment(root, base) };
}

export async function launchProfileWorkerDirect(root: string, profile: string, cwd: string, signal: AbortSignal, entry?: string, base: NodeJS.ProcessEnv = process.env): Promise<ProfileLaunch> {
  try {
    const runtimeEntry = await piRuntimeEntry(entry, base.PI_MANAGED_INSTALL_ROOT);
    const environment = { ...profileWorkerEnvironment(root, base), PI_PROFILE_WORKER: "1" };
    const launcher = await prepareProfileLaunch({
      root, name: profile, cwd, runtimeEntry, environment, interactive: false, signal,
      arguments: extensionArgs => [fileURLToPath(new URL("./openai-worker.mjs", import.meta.url)), runtimeEntry, ...extensionArgs],
    });
    for (const key of Object.keys(launcher.env)) if (key.startsWith("PI_APPLICATION_") || key === "PI_API_WORKER" || key === "PI_PROFILE_DISCOVER_TOOLS") delete launcher.env[key];
    return launcher;
  } catch {
    signal.throwIfAborted();
    throw new CompatibilityError("Profile execution resources could not be loaded.", null, 502, "worker_configuration_error");
  }
}
