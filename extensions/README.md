# pi-feats extensions

This directory contains the Pi extensions exported by the `pi-feats` package. They are loaded through the root `package.json` manifest; do not add these paths separately to `settings.json` after installing the package.

## Included extensions

| Extension | Location | Purpose |
| --- | --- | --- |
| API Server | [`api-server/`](api-server/) | HTTP API, Applications runtime, application sessions, handlers, logs, and profile administration. |
| CLI Resources | [`cli-resources.ts`](cli-resources.ts) | CLI resource, session, package, and profile management. |
| Guardrails | [`guardrails/`](guardrails/) | Configurable input, tool, and output guardrails. |
| Pi Console WebUI | [`pi-console-webui/`](pi-console-webui/) | Browser-based operations console and terminal. |
| Profiles | [`profiles.ts`](profiles.ts) | Persistent profiles, sandbox policies, and remote command routing. |
| Pulse | [`pulse/`](pulse/) | Scheduled and persistent Pulse jobs. |
| Sequential Workflow | [`sequential-workflow.ts`](sequential-workflow.ts) | Strict Action, Collect, and Evaluate workflows. |
| Skill Sources | [`skill-sources/`](skill-sources/) | Git-backed Skill source synchronization and explicit imports. |

## Development

Dependencies are declared at the package root. From the repository root, run:

```bash
npm install
npm run build:web
```

See the root [README](../README.md) for installation instructions.
