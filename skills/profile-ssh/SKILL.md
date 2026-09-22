---
name: profile-ssh
description: Use when connecting to hosts over SSH or when the user asks to register an SSH host for a Pi profile. Covers ordinary SSH plus the optional profile-scoped SSH configuration created by `pi ssh add`.
---

# Profile SSH

Use SSH normally unless a profile-scoped host is relevant. Profile SSH is an additional access mechanism; it does not replace the user's existing `~/.ssh/config`, SSH agent, global keys, or direct `ssh user@host` access.

## Choose the access method

1. **Ordinary SSH first** when the user gives a host, username, global alias, or has existing SSH credentials:

   ```bash
   ssh user@host
   ssh existing-global-alias
   ```

   Respect the user's normal SSH configuration and agent. Do not assume a profile SSH host exists.

2. **Profile-scoped SSH** when the user refers to a host registered with `pi ssh add`, `pi profile <profile> ssh add`, or asks to use the current profile's SSH registration.

   The profile config is not `~/.ssh/config`; use it explicitly:

   ```bash
   ssh -F "$PI_CODING_AGENT_DIR/.ssh/config" <alias>
   ```

   `$PI_CODING_AGENT_DIR` identifies the active Pi profile. This keeps profile keys, known-host entries, and aliases isolated from global SSH configuration.

## Register a profile host

Only register a host when the user asks to do so or approves the setup. Run one of:

```bash
pi ssh add <alias>
pi profile <profile> ssh add <alias>
# Supported shorthand:
pi profile <profile> add <alias>
```

The setup uses the alias as the default hostname, then asks for the IP address, port, and remote user. It shows the server fingerprint for confirmation, creates or reuses the profile's Ed25519 key, and first tests that key without password fallback. If authorization is needed, `ssh-copy-id` prompts for the remote password once; the setup only saves the host after the same key-only validation succeeds.

List profile-managed hosts with:

```bash
pi ssh list
pi profile <profile> ssh list
```

## Safe connection checks

For a non-interactive verification, prefer:

```bash
ssh -F "$PI_CODING_AGENT_DIR/.ssh/config" \
  -o BatchMode=yes -o ConnectTimeout=15 \
  <alias> true
```

Keep host-key verification enabled. Do **not** suggest or add `StrictHostKeyChecking=no`, and do not put passwords in shell commands, scripts, settings, prompts, or logs.

If authentication fails, report the failure succinctly. Ask the user whether they want to use their normal SSH credentials or register/profile-authorize a key with `pi ssh add`; do not attempt to discover, copy, or expose private credentials.
