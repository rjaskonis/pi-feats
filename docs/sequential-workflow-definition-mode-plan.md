# Sequential Workflow Definition Mode Plan

## Goal

Create a workflow only when it is explicitly requested by the user or explicitly mandated by a Skill for the requested operation. Once required, keep the main agent in a dedicated definition turn until the pending workflow is hydrated.

## Explicit-intent classification

### User input

A mention of Sequential Workflow is not enough. Classification is true only when the current user message directly asks to create, start, run, continue, inspect, or cancel a Sequential Workflow. Discussion of templates, Skills, code, prompts, bugs, documentation, or behavior must return false.

A classifier failure returns false. Creating a workflow without an explicit request is worse than declining to infer one.

### Skill discovery

A Skill-origin result is true only when the Skill explicitly states that the requested operation must create or execute a persisted Sequential Workflow. General references to workflow templates or implementation details are false.

## Definition mode

`workflows.status = pending_definition` remains the only durable gate. No additional gate table is introduced.

When a requirement is positive, the harness writes a `definition_mode_started` workflow event containing the origin, original user request, optional Skill path/content, and the previously active tools. The event is sufficient to reconstruct definition mode after reload.

While a focused pending workflow has that event:

1. only root creation tools are active;
2. `context_with_system` replaces the next model context with the essential system prompt, original request, optional Skill requirements, and an English instruction to make exactly one root-workflow creation call;
3. external work and subworkflow creation remain unavailable;
4. successful root creation restores the prior active-tool set and clears definition mode by supplying the workflow definition;
5. explicit cancellation restores the prior active-tool set.

## Trigger paths

### User input

The input hook classifies the current request. On a positive result it creates the pending workflow and definition-mode event before the model request. The first agent request is therefore already the constrained definition turn.

### Skill discovery

The `tool_call` hook reads the Skill internally. On a positive result it creates the pending workflow and definition-mode event, blocks the original Skill read, and terminates the current tool batch. The harness requests one controlled continuation; its next request is the constrained definition turn. No normal agent turn receives the Skill and then decides whether to create a workflow.

## Failure handling

If classification is invalid or unavailable, do not create a workflow. If the constrained definition turn fails to hydrate the pending workflow, keep it pending and retain definition mode; external tools remain unavailable until the user explicitly cancels or supplies a valid definition.

## Tests

- Mentioning Sequential Workflow while discussing templates or implementation does not create a workflow.
- Explicit creation requests create a pending workflow and receive definition-mode context.
- User cancellation followed by discussion does not recreate a workflow.
- A Skill that explicitly mandates Sequential Workflow causes the original Skill read to be blocked and the next turn to be definition-only.
- A Skill that only mentions workflow templates does not trigger definition mode.
- Root creation exits definition mode and restores normal tools.
- Reload reconstructs definition mode from workflow events.
