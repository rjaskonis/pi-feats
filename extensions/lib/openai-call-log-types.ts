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

export type OpenAICallLogPage = { calls: OpenAICallLog[]; next: string | null };
