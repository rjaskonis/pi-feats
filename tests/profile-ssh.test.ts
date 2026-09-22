import assert from "node:assert/strict";
import test from "node:test";
import { profileSshConfigBlock } from "../extensions/profile-ssh.ts";

test("writes a profile SSH config block for alias, hostname, and IP", () => {
  const block = profileSshConfigBlock(
    { alias: "banco-prod", hostname: "db.internal", ip: "10.1.1.1", port: 22, user: "automacao" },
    "/root/.pi/agent/profiles/financeiro/.ssh/id_ed25519",
    "/root/.pi/agent/profiles/financeiro/.ssh/known_hosts",
  );
  assert.equal(block, `# pi-profile-ssh: banco-prod
Host banco-prod db.internal 10.1.1.1
  HostName 10.1.1.1
  User automacao
  Port 22
  IdentityFile /root/.pi/agent/profiles/financeiro/.ssh/id_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile /root/.pi/agent/profiles/financeiro/.ssh/known_hosts
  StrictHostKeyChecking yes
`);
});

test("uses a hostname as the connection target when no IP was supplied", () => {
  const block = profileSshConfigBlock(
    { alias: "docs", hostname: "docs.example.test", port: 2222, user: "deploy" },
    "/profile/.ssh/id_ed25519",
    "/profile/.ssh/known_hosts",
  );
  assert.match(block, /^Host docs docs\.example\.test\n  HostName docs\.example\.test\n/m);
  assert.match(block, /  Port 2222\n/);
});
