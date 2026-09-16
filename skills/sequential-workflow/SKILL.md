---
name: sequential-workflow
description: Use only when the user explicitly names "Sequential Workflow", "sequential-workflow", "sequential workflow", "workflow sequencial", or "fluxo de trabalho sequencial" and asks to create, run, continue, inspect, or cancel it. Builds and executes strictly ordered Action, Collect, and Evaluate tasks through the sequential-workflow extension. Do not use for ordinary planning, plans, checklists, strategies, analyses, or step-by-step answers.
---

# Sequential Workflow

Use this skill only when both conditions are met:

1. The user explicitly names the feature as `Sequential Workflow`, `sequential-workflow`, `sequential workflow`, `workflow sequencial`, or `fluxo de trabalho sequencial`.
2. The user asks to create, start, run, continue, inspect, or cancel that named workflow.

Do not infer Sequential Workflow intent from a request for a plan, planning, checklist, strategy, analysis, recommendation, task organization, or an ordinary step-by-step response. Even when such a request has multiple steps, respond normally without creating or executing a workflow unless the user explicitly names the feature.

## Plan creation

1. Extract the requested steps and produce an ordered mental plan.
2. Classify each step:
   - `action`: performs an action.
   - `collect`: requests information from the user. **Always requires `criteria`.**
   - `evaluate`: evaluates information or a result only.
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

The extension identifies the current task. Work **only** on that task.

- For an `action`, perform the action and call `sequential_workflow_record_result` with `phase: "action"` and a verifiable result summary.
- For a `collect`, request the required information from the user. After receiving it, call `sequential_workflow_record_result` with `phase: "collect"` and the received response.
- If a task has `criteria`, call `sequential_workflow_evaluate` to record whether the criterion was accepted. Do not advance before acceptance.
- For an `evaluate`, assess the available information according to the instruction and call `sequential_workflow_evaluate`.
- If an evaluation rejects an `action`, correct or repeat the current action. If it rejects a `collect`, explain what is missing and request the information again. Never advance after rejection.

Use `sequential_workflow_status` to inspect persisted state. Use `/workflow-cancel` only when the user requests cancellation.
