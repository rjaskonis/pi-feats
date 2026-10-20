import assert from "node:assert/strict";
import test from "node:test";
import { validApiBearerToken } from "../extensions/pi-console-webui/lib/api-auth.ts";

const token = "test-api-token";

test("accepts an exact Pi API Bearer token", () => {
  assert.equal(validApiBearerToken(`Bearer ${token}`, token), true);
  assert.equal(validApiBearerToken(`bearer ${token}`, token), true);
});

test("rejects missing, malformed, and mismatched Pi API Bearer tokens", () => {
  assert.equal(validApiBearerToken(null, token), false);
  assert.equal(validApiBearerToken("Basic test-api-token", token), false);
  assert.equal(validApiBearerToken("Bearer", token), false);
  assert.equal(validApiBearerToken("Bearer wrong-token", token), false);
  assert.equal(validApiBearerToken(`Bearer ${token} extra`, token), false);
  assert.equal(validApiBearerToken("Bearer test-api-token-extra", token), false);
  assert.equal(validApiBearerToken(`Bearer ${token}`, ""), false);
});
