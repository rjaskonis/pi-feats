import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sequentialWorkflow from "../extensions/sequential-workflow.ts";
async function setup(legacy = false) {
    const root = await mkdtemp(join(tmpdir(), "workflow-test-"));
    if (legacy) {
        const db = new DatabaseSync(join(root, "sequential-workflow.db"));
        db.exec("CREATE TABLE workflows(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO workflows(title,source,status) VALUES ('Legacy','test','running')");
        db.close();
    }
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const hooks = new Map<string, any[]>();
    const messages: any[] = [];
    const notices: any[] = [];
    const statuses: any[] = [];
    const workingMessages: any[] = [];
    const renderers = new Map<string, any>();
    let activeTools = ["read", "bash", "edit", "write"];
    let classifierResponse: any;
    const initialize = () => sequentialWorkflow({ registerTool: (t: any) => tools.set(t.name, t), registerCommand: (n: string, c: any) => commands.set(n, c), registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer), on: (n: string, h: any) => hooks.set(n, [...hooks.get(n) ?? [], h]), sendMessage: (...args: any[]) => messages.push(args), getActiveTools: () => activeTools, setActiveTools: (names: string[]) => { activeTools = names; } } as any);
    initialize();
    let sessionId = "A";
    let userId = "user-1";
    const ctx: any = {
        cwd: root,
        getSystemPrompt: () => "Base system prompt",
        sessionManager: { getSessionId: () => sessionId, getBranch: () => [{ id: userId, type: "message", message: { role: "user", content: "Current user request" } }] },
        ui: { notify: (...args: any[]) => notices.push(args), setStatus: (...args: any[]) => statuses.push(args), setWorkingMessage: (...args: any[]) => workingMessages.push(args) },
        model: undefined,
        modelRegistry: { streamSimple: (_model: any, context: any) => ({ result: async () => ({ content: [{ type: "text", text: JSON.stringify(classifierResponse) }], context }) }) },
    };
    return {
        root, messages, notices, statuses, workingMessages, renderers, tools,
        activeTools: () => activeTools,
        enableClassifier(response: any) { classifierResponse = response; ctx.model = {}; },
        reload() { for (const h of hooks.get("session_shutdown") ?? [])
            h(); hooks.clear(); tools.clear(); commands.clear(); initialize(); },
        session(id: string) { sessionId = id; }, reply(id: string) { userId = id; },
        call: (name: string, params: any) => tools.get(`sequential_workflow_${name}`).execute("call", params, undefined, undefined, ctx),
        command: (name: string, args = "") => commands.get(`workflow-${name}`).handler(args, ctx),
        hook: async (name: string, args: any = {}) => { let value; const beforeAgentMessages: any[] = []; for (const h of hooks.get(name) ?? []) {
            const result = await h(args, ctx);
            if (name === "before_agent_start" && result?.message)
                beforeAgentMessages.push(result.message);
            if (result !== undefined)
                value = result;
        } return name === "before_agent_start" && beforeAgentMessages.length ? { messages: beforeAgentMessages } : value; },
        async close() { for (const h of hooks.get("session_shutdown") ?? [])
            h(); if (previous === undefined)
            delete process.env.PI_CODING_AGENT_DIR;
        else
            process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); },
    };
}
const action = { type: "action", instruction: "Perform work" };
const definition = (tasks: any[] = [action]) => ({ title: "Test", source: "test", tasks });
const ids = (r: any) => ({ workflowId: r.details.workflowId, taskId: r.details.next.task.id });
test("session ownership, explicit focus and live context survive session switching", async () => {
    const h = await setup();
    try {
        const a = ids(await h.call("create", definition()));
        assert.match((await h.hook("context", { messages: [] })).messages[0].content, /Session workflow focus/);
        h.session("B");
        assert.equal((await h.call("status", {})).details.workflows.length, 0);
        assert.equal((await h.hook("context", { messages: [{ role: "custom", customType: "sequential-workflow-state" }] })).messages.length, 0);
        await assert.rejects(h.call("status", a), /does not belong/);
        await assert.rejects(h.call("record_result", { ...a, phase: "action", result: "done" }), /does not belong/);
        const b = ids(await h.call("create", definition()));
        assert.notEqual(a.workflowId, b.workflowId);
        h.session("A");
        await assert.rejects(h.call("create", definition()), /Suspend/);
        await h.command("suspend");
        const a2 = ids(await h.call("create", definition()));
        await assert.rejects(h.call("record_result", { ...a, phase: "action", result: "done" }), /focused/);
        await h.command("focus", String(a.workflowId));
        await h.call("record_result", { ...a, phase: "action", result: "done" });
        assert.equal((await h.call("status", a2)).details.workflow.status, "running");
    }
    finally {
        await h.close();
    }
});
test("stale task IDs and parallel preflight cannot advance future tasks", async () => {
    const h = await setup();
    try {
        const id = ids(await h.call("create", definition([action, action])));
        await h.hook("turn_start");
        assert.equal(await h.hook("tool_call", { toolName: "bash", input: {} }), undefined);
        assert.equal((await h.hook("tool_call", { toolName: "sequential_workflow_record_result", input: { ...id } })).block, true);
        await h.call("record_result", { ...id, phase: "action", result: "done" });
        await assert.rejects(h.call("record_result", { ...id, phase: "action", result: "stale" }), /taskId/);
    }
    finally {
        await h.close();
    }
});
test("Collect blocks external tools and fabricated response before a new user entry", async () => {
    const h = await setup();
    try {
        const id = ids(await h.call("create", definition([{ type: "collect", instruction: "Name?", criteria: "Full name" }])));
        await h.hook("turn_start");
        assert.equal((await h.hook("tool_call", { toolName: "bash", input: {} })).block, true);
        await assert.rejects(h.call("record_result", { ...id, phase: "collect", result: "invented" }), /new user response/);
        h.reply("user-2");
        await h.call("record_result", { ...id, phase: "collect", result: "Full Name" });
        await h.call("evaluate", { ...id, accepted: false, reasoning: "Incomplete" });
        await assert.rejects(h.call("record_result", { ...id, phase: "collect", result: "same entry" }), /new user response/);
    }
    finally {
        await h.close();
    }
});
test("child returns focus to parent; rejection allows replacement and cancellation requires evaluation", async () => {
    const h = await setup();
    try {
        const parent = ids(await h.call("create", definition([{ type: "workflow", instruction: "Child", criteria: "Good result" }, action])));
        const child = ids(await h.call("create_subworkflow", { ...definition(), parentWorkflowId: parent.workflowId, parentTaskId: parent.taskId }));
        await assert.rejects(h.call("evaluate", { ...parent, accepted: true, reasoning: "skip" }), /focused/);
        await h.call("record_result", { ...child, phase: "action", result: "done" });
        await h.call("evaluate", { ...parent, accepted: false, reasoning: "retry" });
        const replacement = ids(await h.call("create_subworkflow", { ...definition(), parentWorkflowId: parent.workflowId, parentTaskId: parent.taskId }));
        const cancelled = await h.call("cancel", { workflowId: replacement.workflowId });
        assert.equal(cancelled.details.status, "cancelled");
        assert.equal((await h.call("status", replacement)).details.workflow.status, "cancelled");
        await assert.rejects(h.call("cancel", { workflowId: replacement.workflowId }), /cannot be changed/);
        assert.equal((await h.call("status", parent)).details.tasks[0].status, "evaluating");
        await h.call("evaluate", { ...parent, accepted: true, reasoning: "Explicitly accept cancellation" });
        assert.equal((await h.call("status", parent)).details.tasks[1].status, "running");
    }
    finally {
        await h.close();
    }
});
test("cancellation crosses sessions without changing descendant ownership", async () => {
    const h = await setup();
    try {
        const parent = ids(await h.call("create", definition([{ type: "workflow", instruction: "Child" }])));
        const child = ids(await h.call("create_subworkflow", { ...definition(), parentWorkflowId: parent.workflowId, parentTaskId: parent.taskId }));
        h.session("B");
        const cancelled = await h.call("cancel", { workflowId: parent.workflowId });
        assert.equal(cancelled.details.status, "cancelled");
        await assert.rejects(h.call("status", parent), /does not belong/);
        h.session("A");
        assert.equal((await h.call("status", parent)).details.workflow.status, "cancelled");
        assert.equal((await h.call("status", child)).details.workflow.status, "running");
    }
    finally {
        await h.close();
    }
});
test("named activation reads the template rather than inventing tasks; every activation is new", async () => {
    const h = await setup();
    try {
        await mkdir(join(h.root, "sequential_workflow_templates"));
        await writeFile(join(h.root, "sequential_workflow_templates/basic.json"), JSON.stringify({ version: 1, ...definition([{ type: "collect", instruction: "Exact question", criteria: "Exact criterion" }]) }));
        const input = await h.hook("input", { text: "ative o sequential workflow basic", source: "interactive" });
        assert.equal(input.action, "transform");
        const a = (await h.call("status", {})).details.workflows[0];
        assert.equal(a.currentTask.instruction, "Exact question");
        h.session("B");
        await h.hook("input", { text: "ative o sequential workflow basic", source: "interactive" });
        assert.notEqual((await h.call("status", {})).details.workflows[0].id, a.id);
    }
    finally {
        await h.close();
    }
});
test("agent loop requests bounded continuation instead of accepting premature completion", async () => {
    const h = await setup();
    try {
        await h.call("create", definition());
        for (let i = 0; i < 5; i++)
            await h.hook("agent_end", { messages: [] });
        assert.equal(h.messages.length, 2);
        assert.ok(h.notices.length > 0);
    }
    finally {
        await h.close();
    }
});
test("reload restores focus; adopting a tree revokes the old session owner", async () => {
    const h = await setup();
    try {
        const id = ids(await h.call("create", definition()));
        h.reload();
        assert.match((await h.hook("context", { messages: [] })).messages[0].content, /Session workflow focus/);
        h.session("B");
        await h.command("adopt", String(id.workflowId));
        assert.equal((await h.call("status", {})).details.workflows.length, 1);
        h.session("A");
        await assert.rejects(h.call("record_result", { ...id, phase: "action", result: "done" }), /does not belong/);
        assert.equal((await h.hook("context", { messages: [] })).messages.length, 0);
    }
    finally {
        await h.close();
    }
});
test("named activation cannot use its initial request as a Collect answer", async () => {
    const h = await setup();
    try {
        await mkdir(join(h.root, "sequential_workflow_templates"));
        await writeFile(join(h.root, "sequential_workflow_templates/basic.json"), JSON.stringify({ version: 1, ...definition([{ type: "collect", instruction: "Name?", criteria: "Full name" }]) }));
        await h.hook("input", { text: "ative o sequential workflow basic", source: "interactive" });
        h.reply("activation-message");
        await h.hook("before_agent_start");
        const w = (await h.call("status", {})).details.workflows[0];
        await assert.rejects(h.call("record_result", { workflowId: w.id, taskId: w.currentTask.id, phase: "collect", result: "fabricated" }), /new user response/);
    }
    finally {
        await h.close();
    }
});
test("missing named template fails closed without creating a replacement", async () => {
    const h = await setup();
    try {
        await h.hook("input", { text: "ative o sequential workflow missing", source: "interactive" });
        await assert.rejects(h.call("create", definition()), /Named activation failed/);
        assert.equal((await h.call("status", {})).details.workflows.length, 0);
    }
    finally {
        await h.close();
    }
});


test("detected Sequential Workflow requirement creates a pending workflow that blocks work until hydrated", async () => {
    const h = await setup();
    try {
        const rootParameters = h.tools.get("sequential_workflow_create").parameters.properties;
        const childParameters = h.tools.get("sequential_workflow_create_subworkflow").parameters.properties;
        assert.equal("parentWorkflowId" in rootParameters, false);
        assert.equal("parentTaskId" in rootParameters, false);
        assert.equal("parentWorkflowId" in childParameters, true);
        assert.equal("parentTaskId" in childParameters, true);
        h.enableClassifier({ requiresSequentialWorkflow: true, reasoning: "The request requires a workflow." });
        const request = "Use a Sequential Workflow before work begins.";
        await h.hook("input", { text: request, source: "interactive" });
        const startup = await h.hook("before_agent_start", { prompt: request });
        assert.deepEqual(startup.messages.map((message: any) => message.customType), ["sequential-workflow-evaluation", "sequential-workflow-created"]);
        const pending = (await h.call("status", {})).details.workflows[0];
        assert.equal(pending.status, "pending_definition");
        await h.hook("turn_start");
        assert.equal((await h.hook("tool_call", { toolName: "bash", input: {} })).block, true);
        const hydrated = ids(await h.call("create", definition()));
        assert.equal(hydrated.workflowId, pending.id);
        assert.equal((await h.call("status", hydrated)).details.workflow.status, "running");
    }
    finally {
        await h.close();
    }
});
test("definition mode constrains the next model context and restores tools after hydration", async () => {
    const h = await setup();
    try {
        h.enableClassifier({ requiresSequentialWorkflow: true, reasoning: "Explicit request." });
        const request = "Create a Sequential Workflow for this request.";
        await h.hook("input", { text: request, source: "interactive" });
        const startup = await h.hook("before_agent_start", { prompt: request });
        assert.deepEqual(startup.messages.map((message: any) => message.customType), ["sequential-workflow-evaluation", "sequential-workflow-created"]);
        assert.deepEqual(h.activeTools(), ["sequential_workflow_create"]);
        const context = await h.hook("context_with_system", { messages: [{ role: "system", content: "old" }, { role: "user", content: "old request" }] });
        assert.equal(context.messages.length, 3);
        assert.equal(context.messages[0].content, "old");
        assert.equal(context.messages[1].content, "old request");
        assert.match(context.messages[2].content, /definition mode is active/);
        assert.equal(h.messages.length, 0);
        assert.equal(startup.messages[1].display, true);
        await h.call("create", definition());
        assert.deepEqual(h.activeTools(), ["read", "bash", "edit", "write"]);
    }
    finally {
        await h.close();
    }
});

test("an explicitly named template uses only template activation and announces after input persistence", async () => {
    const h = await setup();
    try {
        h.enableClassifier({ requiresSequentialWorkflow: true, reasoning: "Explicit template activation.", activation: "template", templatePath: "release.json" });
        const request = "Create a Sequential Workflow from release.json";
        await h.hook("input", { text: request, source: "interactive" });
        const startup = await h.hook("before_agent_start", { prompt: request });
        assert.deepEqual(h.activeTools(), ["sequential_workflow_create_from_template"]);
        assert.equal(h.messages.length, 0);
        assert.match(startup.messages[1].content, /Preparing workflow/);
        assert.match(startup.messages[1].content, /release\.json/);
        const context = await h.hook("context_with_system", { messages: [] });
        assert.match(context.messages[0].content, /sequential_workflow_create_from_template/);
        assert.match(context.messages[0].content, /release\.json/);
    }
    finally {
        await h.close();
    }
});

test("a discussion of Sequential Workflow after cancellation does not recreate it", async () => {
    const h = await setup();
    try {
        h.enableClassifier({ requiresSequentialWorkflow: true, reasoning: "Explicit request." });
        const request = "Create a Sequential Workflow.";
        await h.hook("input", { text: request, source: "interactive" });
        await h.hook("before_agent_start", { prompt: request });
        const pending = (await h.call("status", {})).details.workflows[0];
        await h.hook("input", { text: "Cancel the Sequential Workflow.", source: "interactive" });
        assert.equal((await h.call("status", { workflowId: pending.id })).details.workflow.status, "cancelled");
        h.enableClassifier({ requiresSequentialWorkflow: false, reasoning: "This is a discussion, not a request." });
        await h.hook("input", { text: "The Sequential Workflow template should explain script paths better. What is your analysis?", source: "interactive" });
        assert.equal((await h.call("status", {})).details.workflows.length, 0);
    }
    finally {
        await h.close();
    }
});

test("a required Skill starts definition mode without executing its read", async () => {
    const h = await setup();
    try {
        const skillDir = join(h.root, "required-skill");
        await mkdir(skillDir);
        const skillPath = join(skillDir, "SKILL.md");
        await writeFile(skillPath, "This operation requires a Sequential Workflow.");
        h.enableClassifier({ requiresSequentialWorkflow: true, reasoning: "The Skill explicitly requires it." });
        await h.hook("turn_start");
        const result = await h.hook("tool_call", { toolName: "read", input: { path: skillPath } });
        assert.deepEqual(result, { block: true, terminate: true, reason: "Sequential Workflow definition mode has started from the required Skill." });
        assert.deepEqual(h.activeTools(), ["sequential_workflow_create"]);
        const context = await h.hook("context_with_system", { messages: [] });
        assert.match(context.messages[0].content, /Required Skill/);
        assert.match(context.messages[0].content, /requires a Sequential Workflow/);
    }
    finally {
        await h.close();
    }
});

test("only an explicit user override dismisses a pending workflow requirement", async () => {
    const h = await setup();
    try {
        h.enableClassifier({ requiresSequentialWorkflow: true, reasoning: "Explicit request." });
        const request = "Use Sequential Workflow for this request.";
        await h.hook("input", { text: request, source: "interactive" });
        await h.hook("before_agent_start", { prompt: request });
        const pending = (await h.call("status", {})).details.workflows[0];
        await h.hook("input", { text: "Don't create it; continue manually.", source: "interactive" });
        assert.equal((await h.call("status", { workflowId: pending.id })).details.workflow.status, "cancelled");
        assert.equal((await h.hook("context", { messages: [] })).messages.length, 0);
    }
    finally {
        await h.close();
    }
});

test("legacy migration preserves unowned executions without injecting or exposing them", async () => {
    const h = await setup(true);
    try {
        assert.equal((await h.call("status", {})).details.workflows.length, 0);
        await assert.rejects(h.call("status", { workflowId: 1 }), /does not belong/);
        assert.equal((await h.hook("context", { messages: [] })).messages.length, 0);
        h.reload();
        await h.command("adopt", "1");
        assert.equal((await h.call("status", { workflowId: 1 })).details.workflow.title, "Legacy");
    } finally { await h.close(); }
});
