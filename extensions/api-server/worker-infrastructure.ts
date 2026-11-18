/** Profile-process infrastructure, initialized before any job/identity exists. */
import { AsyncLocalStorage } from "node:async_hooks";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { DefaultPackageManager, ResolvedPaths } from "@earendil-works/pi-coding-agent";

type Discovery = Pick<DefaultPackageManager, "resolve" | "resolveExtensionSources">;
const initialized = new WeakSet<object>();
const proxyKey = Symbol.for("pi-web-access.proxyStorage");

/** Only Orca-owned terminal presentation helpers, never arbitrary profile tools. */
export async function isTerminalPresentation(path: string): Promise<boolean> {
  if (!/^orca-(?:agent-status|titlebar-spinner|prefill)\.[cm]?[jt]s$/.test(basename(path))) return false;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").startsWith("// @orca-managed-pi-extension");
  } catch {
    // Preserve normal loader diagnostics for missing/unreadable extensions.
    return false;
  } finally { await file?.close(); }
}

export function initializeWorkerInfrastructure(host: { DefaultPackageManager: { prototype: Discovery } }): void {
  const prototype = host.DefaultPackageManager.prototype;
  if (initialized.has(prototype)) return;
  // Web Access deliberately shares an ALS container across freshly loaded
  // extension modules. Allocate the empty infrastructure, not an extension or
  // proxy value. run() contexts remain job-local; replacing the container still
  // fails the ordinary scope checks. No identity-bearing globals are exempted.
  const existing = Reflect.get(globalThis, proxyKey);
  if (existing !== undefined && !(existing instanceof AsyncLocalStorage)) throw new Error("Unsupported Web Access proxy context.");
  if (existing === undefined) Reflect.set(globalThis, proxyKey, new AsyncLocalStorage<string | null>());

  // The public SDK discovery methods are shared by automatic, project, package
  // and explicit CLI resource discovery. Filter *before* module evaluation:
  // extensionsOverride runs too late to prevent top-level queues/side effects.
  // This SDK instance lives only in this execution subprocess, never the TUI or
  // API server. Preserve trust, enablement, metadata and all non-UI resources.
  const methods = ["resolve", "resolveExtensionSources"] as const;
  const descriptors = methods.map(method => Object.getOwnPropertyDescriptor(prototype, method));
  if (descriptors.some(descriptor => typeof descriptor?.value !== "function" || !descriptor.configurable)) throw new Error("Unsupported Pi resource discovery API.");
  for (const [index, method] of methods.entries()) {
    const descriptor = descriptors[index]!;
    const original = descriptor.value;
    Object.defineProperty(prototype, method, { ...descriptor, value: async function(this: Discovery, ...args: unknown[]) {
      const result = await Reflect.apply(original, this, args) as ResolvedPaths;
      const excluded = await Promise.all(result.extensions.map(resource => isTerminalPresentation(resource.path)));
      return { ...result, extensions: result.extensions.filter((_resource, index) => !excluded[index]) };
    } });
  }
  initialized.add(prototype);
}

/** Undo Computer Use's installation-path handoff after session teardown. */
export function preserveComputerUseConfiguration(): () => void {
  const key = "PI_COMPUTER_USE_LINUX_HELPER_PATH", before = process.env[key];
  return () => {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  };
}
