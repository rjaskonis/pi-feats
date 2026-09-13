import { AsyncLocalStorage } from "node:async_hooks";

export type ApplicationExecutionContext = {
  application: string;
  identityKey: string;
  profile: string;
  sessionId: string;
};

export const applicationExecutionContext = new AsyncLocalStorage<ApplicationExecutionContext>();
