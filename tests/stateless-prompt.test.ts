import assert from "node:assert/strict";
import test from "node:test";
import { buildStatelessPrompt } from "../extensions/api-server/stateless-prompt.ts";

test("stateless prompt places chronological history before the current user message", () => {
  const prompt = buildStatelessPrompt([
    { role: "user", content: "ola" },
    { role: "assistant", content: "Olá!" },
    { role: "user", content: "Me chamo Renne" },
    { role: "assistant", content: "Prazer, Renne!" },
  ], "e agora sabe meu nome?");
  assert.match(prompt, /^## Conversation history\nUser: ola\nAssistant: Olá!\nUser: Me chamo Renne\nAssistant: Prazer, Renne!\n\n## Current user message\ne agora sabe meu nome\?$/);
  assert.ok(prompt.indexOf("Me chamo Renne") < prompt.indexOf("e agora sabe meu nome?"));
});

test("stateless prompt leaves an empty-history request unchanged", () => {
  assert.equal(buildStatelessPrompt([], "Start without prior context."), "Start without prior context.");
});
