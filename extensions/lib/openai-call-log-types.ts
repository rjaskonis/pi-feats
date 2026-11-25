export type OpenAICallLog = {
  id: string;
  receivedAt: string;
  endpoint: "/v1/chat/completions" | "/v1/responses";
  profile: string | null;
  stream: boolean | null;
  httpStatus: number | null;
  outcome: "success" | "error" | "aborted";
  durationMs: number;
  errorCode: string | null;
};

export type OpenAICallSummary = Omit<OpenAICallLog, "outcome" | "durationMs"> & {
  outcome: OpenAICallLog["outcome"] | "running";
  durationMs: number | null;
};
export type CallStageId = "request" | "validation" | "execution" | "response";
export type CallSnapshot = { value: unknown; limited: boolean };
export type CallStage = {
  id: CallStageId;
  outcome: OpenAICallSummary["outcome"];
  durationMs: number | null;
  data?: CallSnapshot;
};
export type OpenAICallDetail = { call: OpenAICallSummary; stages: CallStage[] | null };
export type OpenAICallLogPage = { calls: OpenAICallSummary[]; next: string | null };
