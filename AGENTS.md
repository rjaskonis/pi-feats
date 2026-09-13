# Development Notes

## Purpose and distribution

`pi-feats` is the distributable Pi package. Its canonical installation is:

```bash
pi install npm:pi-feats
```

Git installation remains supported for unreleased development revisions:

```bash
pi install git:github.com/rjaskonis/pi-feats
```

The root `package.json` is authoritative: `pi.extensions` declares every exported extension, runtime dependencies belong in root `dependencies`, and `postinstall` runs `scripts/install-nono.sh` followed by the Console build. Do not add package extension paths manually to a consumer's `settings.json`.

Keep source, comments, commit messages, scripts, and documentation in English.

## Profile architecture (non-negotiable)

- `~/.pi/agent` is the default runtime and control plane. It owns packages, extensions, package dependencies, and their updates.
- `~/.pi/agent/profiles/<name>` is a persistent workspace. It owns settings, credentials, model state, sessions, `SOUL.md`, Guardrails, `.env`, and optional profile-local Skills.
- A named profile must **never** own `packages`, `extensions`, `git`, `npm`, or `node_modules`.
- `profiles.ts` removes those legacy profile artifacts during synchronization and injects already-installed root runtime sources with local `--extension` paths when launching a named profile. Never forward an inherited `git:` or `npm:` package spec into a profile: Pi would clone/install it again under the profile.
- Commands such as `pi profile support skills list`, `extensions list`, and `packages list` must work through the shared runtime while operating on the selected profile's state.
- `cli-resources.ts` and `api-server/profile-store.ts` must treat extensions/packages as default-runtime resources. Skills and tool policy remain profile-scoped.

## Sandbox and security

- Named profiles use Nono; the default profile remains unsandboxed.
- Nono policy grants profiles read-only access to root runtime resources and writable access only to their workspace/state. Keep package and extension directories read-only.
- `ensureNonoAvailable()` must remain safe in non-interactive mode: explain the manual installation command and fail rather than changing the system.
- Do not reintroduce the removed `.runtime` profile workflow. Legacy state migration only covers persisted native state.

## Feature boundaries

- Applications are generic integration runtimes, not Adapter-owned entities. They own handlers, mappings, active sessions, rollover, handoff, and logs.
- Skill Source synchronization only discovers/stages Skills; activation requires an explicit import.
- Guardrail Markdown documents are shared under the root agent directory; each profile selects its ordered rules.
- Remote hosts execute on the remote Pi installation. Do not resolve remote profiles, packages, models, Skills, or sessions locally.

## Validation

After changing profile/runtime behavior, validate at least:

```bash
pi profile create test-profile
pi profile test-profile skills list
pi profile test-profile extensions list
pi profile test-profile packages list
```

Use a temporary `PI_CODING_AGENT_DIR` for isolation. Confirm the profile settings contain no `packages` or `extensions` keys and that no `git/`, `npm/`, `extensions/`, or `node_modules/` directory is created below the profile. Also validate a clean Git package installation when modifying package bootstrap behavior.

## Deployment source

`pi-feats` is the only source for shared extensions. Do not copy or mirror extension code into `ai-agents-assets` or `~/.pi/agent/extensions`; distribute changes through the package and `pi update`.
