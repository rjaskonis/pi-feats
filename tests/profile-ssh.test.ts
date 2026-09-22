import assert from "node:assert/strict";
import test from "node:test";
import { profileSshConfigBlock, profileSshKeyTypeForBanner, profileSshVerificationArgs, removeProfileSshConfigBlock } from "../extensions/profile-ssh.ts";

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

test("selects RSA for OpenSSH versions that predate Ed25519 support", () => {
  assert.equal(profileSshKeyTypeForBanner("# host SSH-2.0-OpenSSH_5.3"), "rsa");
  assert.equal(profileSshKeyTypeForBanner("SSH-2.0-OpenSSH_6.4"), "rsa");
  assert.equal(profileSshKeyTypeForBanner("SSH-2.0-OpenSSH_6.5"), "ed25519");
  assert.equal(profileSshKeyTypeForBanner("SSH-2.0-OpenSSH_9.6"), "ed25519");
  assert.equal(profileSshKeyTypeForBanner("SSH-2.0-OtherSSH_1.0"), "ed25519");
});

test("adds legacy RSA client compatibility to an RSA profile host", () => {
  const block = profileSshConfigBlock(
    { alias: "legacy", hostname: "legacy", ip: "10.1.2.3", port: 22, user: "root", keyType: "rsa" },
    "/profile/.ssh/id_rsa",
    "/profile/.ssh/known_hosts",
  );
  assert.match(block, /IdentityFile \/profile\/.ssh\/id_rsa/);
  assert.match(block, /PubkeyAcceptedAlgorithms \+ssh-rsa/);
});

test("removes only the selected Pi-managed SSH config block", () => {
  const test1 = profileSshConfigBlock(
    { alias: "test1", hostname: "test1", ip: "10.1.2.3", port: 22, user: "root" },
    "/profile/.ssh/id_ed25519",
    "/profile/.ssh/known_hosts",
  );
  const test2 = profileSshConfigBlock(
    { alias: "test2", hostname: "test2", ip: "10.1.2.4", port: 22, user: "root" },
    "/profile/.ssh/id_ed25519",
    "/profile/.ssh/known_hosts",
  );
  const removed = removeProfileSshConfigBlock(`${test1}\n${test2}`, "test1");
  assert.equal(removed.hostName, "10.1.2.3");
  assert.doesNotMatch(removed.config, /test1/);
  assert.match(removed.config, /# pi-profile-ssh: test2/);
});

test("validates a profile host with password authentication disabled", () => {
  assert.deepEqual(profileSshVerificationArgs("/profile/.ssh/config.check", "docs"), [
    "-F", "/profile/.ssh/config.check",
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ConnectTimeout=15",
    "docs",
    "true",
  ]);
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
