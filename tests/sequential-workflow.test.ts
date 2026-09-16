import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sequentialWorkflow from "../extensions/sequential-workflow.ts";

type RegisteredTool = { execute: (id: string, params: any) => Promise<any> };

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-feats-sequential-workflow-"));
  process.env.PI_CODING_AGENT_DIR = root;
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  sequentialWorkflow({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    on: (name: string, handler: (...args: any[]) => any) => {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
  } as any);
  return {
    tool: (name: string) => tools.get(name)!,
    handlers,
    close: async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) handler();
      await rm(root, { recursive: true, force: true });
    },
  };
};

test("multiple independent workflows can remain active", async () => {
  const harness = await setup();
  try {
    const create = harness.tool("sequential_workflow_create");
    const first = await create.execute("1", { title: "First", source: "test", tasks: [{ type: "action", instruction: "Do first" }] });
    const second = await create.execute("2", { title: "Second", source: "test", tasks: [{ type: "action", instruction: "Do second" }] });
    assert.notEqual(first.details.workflowId, second.details.workflowId);

    const status = await harness.tool("sequential_workflow_status").execute("3", {});
    assert.equal(status.details.workflows.length, 2);
  } finally {
    await harness.close();
  }
});

test("does not inject active workflows into unrelated sessions", async () => {
  const harness = await setup();
  try {
    await harness.tool("sequential_workflow_create").execute("1", { title: "Existing", source: "test", tasks: [{ type: "action", instruction: "Do work" }] });
    assert.equal(harness.handlers.get("before_agent_start")?.length ?? 0, 0);
  } finally {
    await harness.close();
  }
});

test("a workflow task waits for and resumes after its linked child", async () => {
  const harness = await setup();
  try {
    const create = harness.tool("sequential_workflow_create");
    const parent = await create.execute("1", { title: "Parent", source: "test", tasks: [{ type: "workflow", instruction: "Run child" }] });
    const parentId = parent.details.workflowId;
    const parentTaskId = parent.details.next.task.id;
    const child = await create.execute("2", { title: "Child", source: "test", parentTaskId, tasks: [{ type: "action", instruction: "Run child action" }] });
    const childId = child.details.workflowId;

    let parentStatus = await harness.tool("sequential_workflow_status").execute("3", { workflowId: parentId });
    assert.equal(parentStatus.details.tasks[0].status, "waiting_subworkflow");
    assert.equal(parentStatus.details.tasks[0].child_workflow_id, childId);

    await harness.tool("sequential_workflow_record_result").execute("4", { workflowId: childId, phase: "action", result: "done" });
    parentStatus = await harness.tool("sequential_workflow_status").execute("5", { workflowId: parentId });
    assert.equal(parentStatus.details.workflow.status, "completed");
    assert.equal(parentStatus.details.tasks[0].status, "accepted");
  } finally {
    await harness.close();
  }
});
