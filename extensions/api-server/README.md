# Pi API Server Extension

HTTP server for pi with CLI-compatible persistent sessions.

## Control

```bash
pi api start
pi api stop
pi api status
```

`start` creates `~/.pi/agent/api-server.json` when absent and generates its `apiToken`. Existing `api` settings are migrated automatically from `settings.json`. Runtime state and logs are stored at:

```text
~/.pi/agent/api-server.state.json
~/.pi/agent/api-server.log
```

## Configuration

```json
{
  "host": "0.0.0.0",
  "port": 8767,
  "apiToken": "automatically-generated-token",
  "cors": { "origin": "*" }
}
```

Restart with `pi api stop && pi api start` after changing host, port, or CORS.

## Authentication

Every endpoint except health requires:

```http
Authorization: Bearer <apiToken>
```

## Endpoints

```text
GET  /api/health
POST /api/sessions/:sessionId/chat
POST /api/sessions/:sessionId/chat/stream
POST /profile/:profileName/api/sessions/:sessionId/chat
POST /profile/:profileName/api/sessions/:sessionId/chat/stream
```

Request body:

```json
{ "message": "Explain this project" }
```

`/chat` returns the complete response:

```json
{ "profile": "default", "sessionId": "abc", "response": "..." }
```

`/chat/stream` uses Server-Sent Events: `session`, `token`, and `done`.

## Sessions and profiles

Sessions are created in the same persistent location used by the CLI. For example, a session created through the API can be resumed with:

```bash
pi --session abc
pi --profile n1 --session abc
```

Profiles follow the `profiles.ts` convention: `default` uses `~/.pi/agent`, while `n1` uses `~/.pi/agent/profiles/n1`.

Different sessions run in parallel. Concurrent requests to one session return `409 SESSION_BUSY`.

## Profile management

All routes below require Bearer authentication. Resource responses expose only metadata and status; they never return the contents of skills, tools, or extensions.

```text
GET    /api/profiles
POST   /api/profiles                         { "name": "work" }
GET    /api/profiles/:profile
DELETE /api/profiles/:profile                 { "force": true }

GET    /api/profiles/:profile/settings
PUT    /api/profiles/:profile/settings        <settings JSON object>

GET    /api/profiles/:profile/soul
PUT    /api/profiles/:profile/soul            { "content": "..." }
GET    /api/profiles/:profile/refine
PUT    /api/profiles/:profile/refine          { "content": "..." }

GET    /api/profiles/:profile/resources/tools
GET    /api/profiles/:profile/resources/skills
GET    /api/profiles/:profile/resources/extensions
GET    /api/profiles/:profile/resources/:kind/:name
PATCH  /api/profiles/:profile/resources/:kind/:name  { "enabled": false }
```

`kind` is `tools`, `skills`, or `extensions`. Changes to resource state are persisted in the profile settings and apply when a profile runtime is loaded again. The `profiles` and `api-server` extensions are protected because they are required for profile and API operation.
