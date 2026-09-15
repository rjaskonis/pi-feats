import { AsyncLocalStorage } from "node:async_hooks";

export type ContextMemoryExecutionLog = {
  handler: string;
  startedAt: string;
  durationMs: number;
  status: "success" | "error";
  outputCharacters: number;
  stdout: string[];
  stderr: string[];
  error?: string;
};

export type ApplicationExecutionContext = {
  application: string;
  identityKey: string;
  profile: string;
  sessionId: string;
  onContextMemoryExecution?: (event: ContextMemoryExecutionLog) => void;
};

export const applicationExecutionContext = new AsyncLocalStorage<ApplicationExecutionContext>();
