---
name: sequential-workflow-template
description: Use only when the user explicitly names "Sequential Workflow", "sequential-workflow", "sequential workflow", "workflow sequencial", or "fluxo de trabalho sequencial" and asks to create or edit a reusable JSON template for it. Creates a schema-valid template but never creates or executes a workflow.
---

# Sequential Workflow Template

Use this skill only when both conditions are met:

1. The user explicitly names the feature as `Sequential Workflow`, `sequential-workflow`, `sequential workflow`, `workflow sequencial`, or `fluxo de trabalho sequencial`.
2. The user asks to create or edit a reusable JSON template for that feature.

Do not use this skill for ordinary planning, checklists, or step-by-step answers. Do not create, start, execute, continue, inspect, or cancel a workflow. Those requests belong to the `sequential-workflow` skill.

## Template authoring

1. Read `schemas/sequential-workflow-template.schema.json` from the installed `pi-feats` package when its exact location is needed.
2. Convert the user's requested process into a JSON document that conforms to schema version `1`.
3. Classify each task as `action`, `collect`, or `evaluate`.
4. Give every task a non-empty `instruction`. A `collect` task must have non-empty `criteria`.
5. If the user specifies an output directory or path, write the JSON exactly there. Otherwise, call `sequential_workflow_prepare_template_directory` and write the file in its returned directory. This is `${PI_CODING_AGENT_DIR}/sequential_workflow_templates` for the active runtime, or `~/.pi/agent/sequential_workflow_templates` when `PI_CODING_AGENT_DIR` is not set.
6. Call `sequential_workflow_validate_template` with the resulting path and correct any validation error before reporting completion.

## Template format

```json
{
  "version": 1,
  "title": "Customer onboarding",
  "source": "Customer onboarding template",
  "tasks": [
    {
      "type": "collect",
      "instruction": "Request the customer's full name.",
      "criteria": "The response contains at least a first and last name."
    },
    {
      "type": "action",
      "instruction": "Create the customer record with the supplied information.",
      "criteria": "The customer record was created successfully."
    }
  ]
}
```
