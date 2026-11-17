# Resident profile worker isolation audit

## Scope and trust boundary

The API uses one lazy process per profile, serialized within that profile and
sandboxed by the existing named-profile Nono launcher. It reuses ModelRuntime,
not AgentSession, extension instances, transcripts, or Application identities.
The default profile remains unsandboxed. No changes grant a named profile write
access to the shared package/runtime directories.

Extensions are executable, trusted code with the profile process's permissions.
This design is not a JavaScript sandbox for hostile extensions. Third-party
extensions must release their own resources and must not keep request data in
shared dependency singletons. A shallow process-state check cannot inspect
arbitrary object graphs, detect every background promise, or undo external side
effects. Persisted application data and explicit stateful history are not erased
between jobs.

## Session boundary

- Every job constructs a fresh loader/session and reloads extension factories.
  Factory caches are cleared before startup and after shutdown.
- Application environment is injected before extension startup and cleared in a
  `finally` block. Resident Application/event references are also dropped there.
- Stateless jobs use an in-memory SessionManager. Stateful jobs open only the
  selected native transcript. Session operations keep the existing busy checks.
- Direct Context Memory is added to the request's system prompt, including on
  later stateful turns. It is not injected as a persisted custom message. A model
  can still quote context in its response, which becomes normal stateful history.
- Shutdown hooks are awaited with a two-second deadline before session disposal.
  Extension errors and cleanup timeouts prevent worker reuse.
- Extension/native-provider registration and virtual-router registration mark the
  worker for retirement. These APIs can retain identity-capturing closures in
  ModelRuntime; their behavior is preserved without reusing that runtime afterward.

## Residual-state safeguard

ProfileJobScope checks newly created asynchronous resources, process listeners,
environment changes, working directory, and top-level global descriptors after
cleanup. Leaked timers (including unreferenced intervals), subprocesses, file
watchers, ports, and listeners cause conservative retirement. It observes native
async hooks rather than replacing timer functions.

The check permits Undici's profile-scoped pooled connection maintenance and the
OpenAI SDK's immutable, weakly held provider-definition registry. It does not
promise deep isolation of arbitrary dependency caches. Node's lazy built-ins are
materialized before the initial global snapshot to avoid false retirement.

The worker reports retirement together with its final idle frame. A successful
response is delivered once; the parent then terminates/reaps the process group
before a queued job starts a replacement. Failure, cancellation and retirement
never replay server actions. Idle expiry starts only after cleanup; reservations
and client-tool continuations remain protected.

## Shipped extension review

The HTTP integration fixture loads every extension exported by the root manifest.
External-service tools are not invoked, and all model requests use a localhost
mock. The lifecycle review also covers these extension-specific owners:

| Component | Ownership and cleanup |
| --- | --- |
| Browser Harness | Connection and tool state belong to each factory/session. Shutdown releases owned tabs/Steel sessions and stops the transport; external browser processes are not terminated. No connection is opened merely by loading the extension. |
| Composio | Runtime promises now belong to each extension instance instead of a module-level cache. Shutdown clears them. SDK execution requires an explicit tool call. |
| Context Memory | A shared console capture uses AsyncLocalStorage for per-call log routing, avoiding wrapper accumulation on module reload. Handler deadline timers are cleared. A timed-out custom handler explicitly requires worker retirement because arbitrary promises cannot be cancelled. Identity-mode writes resolve to USER.md, not the profile fallback. |
| Sequential Workflow | Database, focus, tool proxies and dispatch state belong to each extension instance/session. The database closes on session shutdown; workflows remain persisted and session-scoped. |
| Pulse tool | Every tool invocation closes its SQLite connection in `finally`. CLI/tick daemon state is a separate control-plane lifecycle, not started by ordinary worker loading. |
| Guardrails | Reflection counters and hooks belong to each extension instance. Rule configuration remains profile-scoped; no background process is started by loading. |
| Profiles, SSH and CLI resources | Worker reexecution preserves the resident flag. API worker startup does not run interactive CLI commands. Credentials/environment continue to use the original profile loader and Nono policy. |
| Conversation search and skill sources | Request-local lookup/discovery; no background synchronization is started by loading. Skill activation remains explicit. |
| CLI TUI mode and Console/API entrypoints | Command dispatch only; ordinary worker loading does not start another server or TUI. API entrypoint honors the worker guard. |

## Validation gates

- `npm run typecheck` checks extension TypeScript, including the Console CLI
  entrypoint, against Pi SDK 1.5.2. The Next application is checked by its build.
- `npm test` runs that check, extension tests and the Console build.
- Nono HTTP tests cover shared PIDs across API surfaces, stateful/stateless
  behavior, SSE, webhooks, identity and transient-memory separation, native
  transcript inspection, cleanup failure, dirty-resource retirement and custom
  provider retirement. They verify allowed workspace reads and denied neighbor
  reads outside `/tmp`. An external file-entry extension imports an adjacent
  module successfully while writes to its installation directory remain denied.
  File grants never expand to the agent root, its ancestors or profile directories.
- Worker bootstrap resolves the host SDK from the owning Pi package, not the
  CLI's immediate directory. Path tests cover unbundled `dist/cli.js`, bundled
  `dist/bundle/cli.js` and the installed `.bin/pi` symlink; the HTTP fixture also
  supports running against the installed bundled launcher.
- Runtime tests cover capacity, dynamic expiry, configuration invalidation,
  continuations, active/queued cancellation, crash, shutdown and no replay.
- Profile CLI validation checks create/skills/extensions/packages through the
  shared runtime and rejects profile-local runtime directories/settings keys.

There is intentionally no global RAM/worker cap. Idle expiry and per-profile
backpressure remain the documented controls; deployment sizing must account for
concurrent profiles. The separate `npm audit` dependency findings are not a claim
of a clean third-party dependency security audit.
