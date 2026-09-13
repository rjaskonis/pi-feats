import assert from "node:assert/strict";
import test from "node:test";
import { resolveComposioUserId, selectConnectedAccount } from "../extensions/composio/index.ts";

const accounts = [
  { id: "ca_expired", status: "EXPIRED", toolkit: { slug: "gmail" } },
  { id: "ca_work", alias: "work", status: "ACTIVE", toolkit: { slug: "gmail" } },
  { id: "ca_personal", alias: "personal", status: "ACTIVE", toolkit: { slug: "gmail" } },
];

test("profile Composio user ID overrides an Application identity", () => {
  assert.equal(resolveComposioUserId({ COMPOSIO_USER_ID: "profile-user" }, {}, "application-user"), "profile-user");
});

test("Application identity becomes the Composio user ID when the profile has no override", () => {
  assert.equal(resolveComposioUserId({}, {}, "5519996034196@s.whatsapp.net"), "5519996034196@s.whatsapp.net");
});

test("account selection requires an explicit choice when multiple active accounts exist", () => {
  assert.throws(() => selectConnectedAccount(accounts, "gmail"), /Multiple active gmail accounts/);
  assert.equal(selectConnectedAccount(accounts, "gmail", "personal"), "ca_personal");
});

test("account selection ignores inactive accounts", () => {
  assert.equal(selectConnectedAccount(accounts, "gmail", "work"), "ca_work");
  assert.throws(() => selectConnectedAccount(accounts, "gmail", "ca_expired"), /No active gmail account/);
});
