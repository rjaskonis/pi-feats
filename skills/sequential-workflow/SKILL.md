---
name: sequential-workflow
description: Use only when the user explicitly names "Sequential Workflow", "sequential-workflow", "sequential workflow", "workflow sequencial", or "fluxo de trabalho sequencial" and asks to create, run, continue, inspect, or cancel it. Builds and executes strictly ordered Action, Collect, and Evaluate tasks through the sequential-workflow extension. Do not use for ordinary planning, plans, checklists, strategies, analyses, or step-by-step answers.
---

# Sequential Workflow

Use this skill only when both conditions are met:

1. The user explicitly names the feature as `Sequential Workflow`, `sequential-workflow`, `sequential workflow`, `workflow sequencial`, or `fluxo de trabalho sequencial`.
2. The user asks to create, start, run, continue, inspect, or cancel that named workflow.

Do not infer Sequential Workflow intent from a request for a plan, planning, checklist, strategy, analysis, recommendation, task organization, or an ordinary step-by-step response. Even when such a request has multiple steps, respond normally without creating or executing a workflow unless the user explicitly names the feature.

## JSON template execution

When the user explicitly asks to execute Sequential Workflow using a JSON template path, call `sequential_workflow_create_from_template` with that path. A relative template path resolves in the active profile's `sequential_workflow_templates` directory; use an absolute path or a `./` or `../` path only when the user explicitly requested another location. Do not read, parse, or reconstruct the template in the conversation first; the extension validates and persists it directly.

Use `sequential_workflow_validate_template` only when the user asks to validate a template or when creating/editing one through the `sequential-workflow-template` skill.

## Plan creation

1. Extract the requested steps and produce an ordered mental plan.
2. Classify each step:
   - `action`: performs an action.
   - `collect`: requests information from the user. **Always requires `criteria`.**
   - `evaluate`: evaluates information or a result only.
   - `workflow`: creates and waits for a subworkflow. Use it when the parent must not advance until that child has reached a terminal state.
3. For `action`, include `criteria` when there is an acceptance condition. For `collect`, `criteria` is mandatory.
4. Call `sequential_workflow_create` with the plan. Do not invent results or perform steps before creation is confirmed.

Example:

```json
{
  "title": "Customer registration",
  "source": "User request",
  "tasks": [
    {
      "type": "collect",
      "instruction": "Request the customer's full name.",
      "criteria": "The response contains at least a first and last name."
    },
    {
      "type": "action",
      "instruction": "Save the supplied name in the customer record.",
      "criteria": "The customer record contains the supplied full name."
    }
  ]
}
```

## Strictly sequential execution

Execution is strictly ordered **inside each workflow**, with ownership and focus enforced by the harness for the current session. Pass both `workflowId` and the current `taskId` to `sequential_workflow_record_result` and `sequential_workflow_evaluate`. Use one tool call per model turn while focused. External tools are blocked unless the current task is a running Action; Collect requires a new user message after activation. The harness requests bounded continuation when an Action or evaluation is left unfinished; it does not certify the semantic correctness of results.

The harness resolves requests such as `ative o sequential workflow basic` directly to `basic.json`. If the activation was already performed by the harness, do not create another workflow. Missing templates must not be replaced with invented tasks.

Session focus survives reload/resume of the same session. A new or forked session starts without focus or ownership of old executions. `/workflow-suspend` releases focus without cancelling; `/workflow-focus <id>` resumes an owned execution; `/workflow-adopt <rootId>` explicitly transfers a whole workflow tree from another session (including legacy unowned runs). Adoption revokes the old owner's access. These are user controls, not actions the model may silently perform.

Do not inspect, resume, or otherwise select a persisted workflow merely because it is active. A request to create or activate a workflow starts a new workflow unless the user explicitly asks to continue, inspect, list, cancel, or identifies an existing workflow by ID.

- For an `action`, perform the action and call `sequential_workflow_record_result` with `phase: "action"` and a verifiable result summary.
- For a `collect`, request the required information from the user. After receiving it, call `sequential_workflow_record_result` with `phase: "collect"` and the received response.
- For a `workflow` task, create the child with `parentTaskId` set to that task ID. The parent task waits automatically; do not record a result for it.
- If a task has `criteria`, call `sequential_workflow_evaluate` to record whether the criterion was accepted. Do not advance before acceptance.
- For an `evaluate`, assess the available information according to the instruction and call `sequential_workflow_evaluate`.
- If an evaluation rejects an `action`, correct or repeat the current action. If it rejects a `collect`, explain what is missing and request the information again. A rejected `workflow` task becomes runnable again and may create a replacement child.

`parentWorkflowId` creates a hierarchical relationship only. `parentTaskId` additionally creates an operational dependency: the parent task waits for that child. Use `sequential_workflow_status` without an ID to list this session's active workflows or with `workflowId` to inspect an owned execution. Status never changes focus. Use `/workflow-cancel <workflowId>` only when the user requests cancellation.
