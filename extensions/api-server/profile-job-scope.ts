/** Detect residual process state before a resident worker accepts another job. */
import { createHook } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";

const ownedResources = new Set(["Timeout", "PROCESSWRAP", "FSEVENTWRAP", "STATWATCHER", "WORKER", "MESSAGEPORT", "UDPWRAP", "TCPWRAP", "TCPSERVERWRAP", "PIPEWRAP", "SIGNALWRAP"]);

export class ProfileJobScope {
  private readonly resources = new Set<number>();
  private readonly listeners = new Map(process.eventNames().map((name) => [name, process.rawListeners(name)]));
  private readonly environment = { ...process.env };
  private readonly directory = process.cwd();
  private readonly globals = (() => {
    // Node materializes lazy built-ins (including Undici's dispatcher symbol)
    // while enumerating descriptors. Settle those before taking the baseline.
    Object.getOwnPropertyDescriptors(globalThis);
    return Object.getOwnPropertyDescriptors(globalThis);
  })();
  private readonly hook = createHook({
    init: (id, type) => {
      // Undici owns profile-scoped pooled connection maintenance, not a job's
      // extension callbacks. Its unreferenced pool timers need not force a boot.
      if (ownedResources.has(type) && !new Error().stack?.includes("/undici/")) this.resources.add(id);
    },
    destroy: (id) => { this.resources.delete(id); },
  });
  constructor() { this.hook.enable(); }
  async finish(): Promise<boolean> {
    // Let completed one-shot timers and their destroy hooks settle first.
    await setImmediate();
    this.hook.disable();
    const names = new Set([...this.listeners.keys(), ...process.eventNames()]);
    const listenersChanged = [...names].some((name) => {
      const before = this.listeners.get(name) ?? [], after = process.rawListeners(name);
      return before.length !== after.length || before.some((listener, index) => listener !== after[index]);
    });
    const keys = new Set([...Object.keys(this.environment), ...Object.keys(process.env)]);
    const environmentChanged = [...keys].some((key) => !key.startsWith("PI_APPLICATION_") && this.environment[key] !== process.env[key]);
    const globals = Object.getOwnPropertyDescriptors(globalThis);
    const globalKeys = new Set([...Reflect.ownKeys(this.globals), ...Reflect.ownKeys(globals)]);
    const globalsChanged = [...globalKeys].some((key) => {
      const before = this.globals[key as string], after = globals[key as string];
      // OpenAI lazily installs this immutable cross-copy WeakMap registry. It
      // does not retain discarded client configurations or identities.
      if (!before && key === Symbol.for("openai.node.providerDefinitions.v1") && after?.value instanceof WeakMap && !after.configurable && !after.writable) return false;
      return !before || !after || !Object.is(before.value, after.value) || before.get !== after.get || before.set !== after.set;
    });
    return this.resources.size === 0 && !listenersChanged && !environmentChanged && !globalsChanged && process.cwd() === this.directory;
  }
}
