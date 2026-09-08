# Plan: Pi HTTP API

## Goal

Provide a multi-session, multi-profile HTTP API through the pi SDK while reusing the CLI's persistent environment: settings, auth, models, extensions, tools, skills, prompts, context files, and session storage.

## Decisions

- Install as `~/.pi/agent/extensions/api-server/`.
- Use an extension entrypoint to control a standalone SDK worker.
- Commands: `pi api start`, `pi api stop`, and `pi api status`.
- Default listener: `0.0.0.0:8767`.
- Generate and persist `apiToken` in `api-server.json` when absent.
- Require `Authorization: Bearer <apiToken>` on all routes except `GET /api/health`.
- Enable CORS with origin `*` by default.
- `/chat` returns one complete JSON response.
- `/chat/stream` returns SSE events.

## API

```text
GET  /api/health
POST /api/sessions/{sessionId}/chat
POST /api/sessions/{sessionId}/chat/stream
POST /profile/{profileName}/api/sessions/{sessionId}/chat
POST /profile/{profileName}/api/sessions/{sessionId}/chat/stream
```

The request body is:

```json
{ "message": "Text sent to pi" }
```

Errors use:

```json
{ "error": { "code": "SESSION_BUSY", "message": "The session is already processing a request." } }
```

## Profiles and sessions

- `default` uses the standard CLI `agentDir` and session storage.
- Named profiles use the same `profiles/{profileName}` directories used by `profiles.ts`.
- Session files created through the API are opened by the CLI with the same session ID.
- The SDK uses `DefaultResourceLoader`, `SettingsManager`, `ModelRuntime`, and `SessionManager` against those same directories.
- Different sessions execute concurrently; a second request to an active session returns `409 SESSION_BUSY`.
- Profile bootstrap is serialized only while extensions load and capture profile-specific environment values. Agent execution remains concurrent.

## Security

- Use constant-time Bearer-token comparison.
- Never accept the token in a query string.
- Limit request bodies to 1 MiB.
- Do not expose stack traces, prompts, tokens, or full responses in standard logs.
- Implement CORS preflight through `OPTIONS`.

## Runtime lifecycle

`start` initializes configuration, starts the detached SDK worker, and stores PID metadata. `stop` terminates its process group. `status` reports worker PID, host, and port.

## Acceptance criteria

1. CLI commands start, stop, and report the server.
2. API configuration and token persist in the CLI `settings.json`.
3. Health is public; other routes require Bearer authentication.
4. Complete and SSE chat endpoints work.
5. API-created sessions are resumable by the CLI.
6. CLI-configured extensions, tools, skills, prompts, and context are available to API sessions.
7. Sessions and profiles remain isolated while different sessions run in parallel.
