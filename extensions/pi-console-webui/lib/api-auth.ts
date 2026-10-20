import { timingSafeEqual } from "node:crypto";

/** Validates a Pi API bearer token without exposing either token value. */
export function validApiBearerToken(authorization: string | null, apiToken: string): boolean {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match || !apiToken) return false;
  const received = Buffer.from(match[1]);
  const expected = Buffer.from(apiToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
