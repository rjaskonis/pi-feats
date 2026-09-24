import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
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
        enableClassifier(response: any) { classifierResponse = response?.status ? response : { status: response?.requiresSequentialWorkflow ? "required" : "not_required", reasoning: response?.reasoning ?? "Test classifier decision.", activation: response?.activation, templateId: response?.templatePath?.replace(/^.*\//, "").replace(/\.json$/, "") }; ctx.model = {}; },
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
test("Action criteria fail the workflow after five rejected attempts", async () => {
    const h = await setup();
    try {
        const created = ids(await h.call("create", definition([{ type: "action", instruction: "Verify the action", criteria: "The verification passes." }])));
        for (let attempt = 1; attempt <= 5; attempt++) {
            await h.call("record_result", { workflowId: created.workflowId, taskId: created.taskId, phase: "action", result: `Attempt ${attempt} failed verification.` });
            const evaluation = await h.call("evaluate", { workflowId: created.workflowId, taskId: created.taskId, accepted: false, reasoning: `Attempt ${attempt} did not meet the criteria.` });
            if (attempt < 5) {
                assert.equal(evaluation.details.failed, undefined);
                assert.equal((await h.call("status", { workflowId: created.workflowId })).details.workflow.status, "running");
            }
            else {
                assert.equal(evaluation.details.failed, true);
                assert.equal(evaluation.details.attempts, 5);
                assert.match(evaluation.content[0].text, /workflow failed/);
            }
        }
        const status = await h.call("status", { workflowId: created.workflowId });
        assert.equal(status.details.workflow.status, "failed");
        assert.equal(status.details.tasks[0].status, "failed");
        assert.equal(status.details.tasks[0].attempts, 5);
    }
    finally {
        await h.close();
    }
});

test("Terminal evaluation fails a workflow without retrying or advancing", async () => {
    const h = await setup();
    try {
        const id = ids(await h.call("create", definition([{ type: "action", instruction: "Perform a guarded action", criteria: "The action must succeed." }, action])));
        await assert.rejects(h.call("evaluate", { ...id, outcome: "fail", reasoning: "No result has been recorded." }), /Record the task result/);
        await h.call("record_result", { ...id, phase: "action", result: "The dependency is in a terminal state." });
        const evaluation = await h.call("evaluate", { ...id, outcome: "fail", reasoning: "Retrying cannot safely change the terminal state." });
        assert.equal(evaluation.details.terminal, true);
        assert.match(evaluation.content[0].text, /terminal evaluation/);
        const status = await h.call("status", { workflowId: id.workflowId });
        assert.equal(status.details.workflow.status, "failed");
        assert.equal(status.details.tasks[0].status, "failed");
        assert.equal(status.details.tasks[0].attempts, 0);
        assert.equal(status.details.tasks[1].status, "pending");
        await assert.rejects(h.call("record_result", { ...id, phase: "action", result: "must not run" }), /focused workflow/);
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
test("template activation is selected by the evaluator from controlled candidates", async () => {
    const h = await setup();
    try {
        await mkdir(join(h.root, "sequential_workflow_templates"));
        await writeFile(join(h.root, "sequential_workflow_templates/basic.json"), JSON.stringify({ version: 1, ...definition([{ type: "collect", instruction: "Exact question", criteria: "Exact criterion" }]) }));
        h.enableClassifier({ status: "required", reasoning: "The controlled template is appropriate.", activation: "template", templateId: "basic" });
        await h.hook("input", { text: "Use Sequential Workflow to process this contract.", source: "interactive" });
        assert.deepEqual(h.activeTools(), ["sequential_workflow_create_from_template"]);
        const context = await h.hook("context_with_system", { messages: [] });
        assert.match(context.messages[0].content, /basic\.json/);
    } finally { await h.close(); }
});
test("agent loop requests bounded continuation instead of accepting premature completion", async () => {
    const h = await setup();
    try {
        await h.call("create", definition());
        for (let i = 0; i < 5; i++)
            await h.hook("agent_end", { messages: [] });
        assert.equal(h.messages.filter((message) => message[0].customType === "sequential-workflow-state").length, 2);
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
test("System One evaluates collect input before allowing a transition", async () => {
    const h = await setup(); const oldFetch = globalThis.fetch, oldKey = process.env.OPENROUTER_API_KEY;
    try {
        await writeFile(join(h.root, "settings.json"), JSON.stringify({ sequentialWorkflow: { evaluation: { modelType: "system_one", systemOne: { provider: "openrouter", model: "typesafe/jev-test" } } } }));
        process.env.OPENROUTER_API_KEY = "test";
        globalThis.fetch = async () => new Response(JSON.stringify({ answers: { decision: { choice: "retry", confidence: 1, probabilities: { retry: 1 } } } }), { status: 200 });
        const created = ids(await h.call("create", definition([{ type: "collect", instruction: "Name?", criteria: "Full name" }])));
        await h.hook("input", { text: "Renne", source: "interactive" });
        const status = await h.call("status", { workflowId: created.workflowId });
        assert.equal(status.details.workflow.status, "awaiting_user");
        assert.ok(h.messages.some((message) => String(message[0].content).includes("will be retried")));
    } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; await h.close(); }
});
test("OpenRouter TypeSafe System One uses the Decisions endpoint", async () => {
    const h = await setup(); const oldFetch = globalThis.fetch, oldKey = process.env.OPENROUTER_API_KEY;
    try {
        await writeFile(join(h.root, "settings.json"), JSON.stringify({ sequentialWorkflow: { evaluation: { modelType: "system_one", systemOne: { provider: "omniroute", model: "openrouter/typesafe/jev-1.13", endpoint: { baseUrl: "https://openrouter.ai/api/", path: "alpha/decisions" } } } } }));
        delete process.env.OPENROUTER_API_KEY;
        await writeFile(join(h.root, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "test" } }));
        let request: { url: string; body: any } | undefined;
        globalThis.fetch = async (url, init) => { request = { url: String(url), body: JSON.parse(String(init?.body)) }; return new Response(JSON.stringify({ answers: { decision: { choice: "workflow_definition", confidence: 1, probabilities: { workflow_definition: 1 } } } }), { status: 200 }); };
        await h.hook("input", { text: "Use Sequential Workflow for this request.", source: "interactive" });
        assert.equal(request?.url, "https://openrouter.ai/api/alpha/decisions");
        assert.equal(request?.body.model, "typesafe/jev-1.13");
        assert.equal((await h.call("status", {})).details.workflows[0].status, "pending_definition");
    } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; await h.close(); }
});
test("an unavailable automatic collect evaluation restores the task to awaiting user input", async () => {
    const h = await setup(); const oldKey = process.env.OPENROUTER_API_KEY;
    try {
        delete process.env.OPENROUTER_API_KEY;
        await writeFile(join(h.root, "settings.json"), JSON.stringify({ sequentialWorkflow: { evaluation: { modelType: "system_one", systemOne: { provider: "openrouter", model: "typesafe/jev-test" } } } }));
        const created = ids(await h.call("create", definition([{ type: "collect", instruction: "Name?", criteria: "Full name" }])));
        await h.hook("input", { text: "Renne", source: "interactive" });
        const status = await h.call("status", { workflowId: created.workflowId });
        assert.equal(status.details.workflow.status, "awaiting_user");
    } finally { if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; await h.close(); }
});
test("ordinary user input does not trigger workflow evaluation", async () => {
    const h = await setup();
    try {
        await h.hook("input", { text: "Hello", source: "interactive" });
        assert.equal((await h.call("status", {})).details.workflows.length, 0);
        assert.equal(h.messages.filter((message) => message[0].customType === "sequential-workflow-harness").length, 0);
    } finally { await h.close(); }
});
test("a user phrase does not bypass the evaluator", async () => {
    const h = await setup();
    try {
        h.enableClassifier({ status: "not_required", reasoning: "The request does not need persisted control." });
        await h.hook("input", { text: "Use Sequential Workflow now.", source: "interactive" });
        assert.equal((await h.call("status", {})).details.workflows.length, 0);
        assert.ok(h.messages.some((message) => message[0].content === "Sequential Workflow is not required for this request."));
    } finally { await h.close(); }
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
        assert.ok(h.messages.length >= 2);
        assert.equal(startup.messages[1].display, true);
        await h.call("create", definition());
        assert.deepEqual(h.activeTools(), ["read", "bash", "edit", "write"]);
    }
    finally {
        await h.close();
    }
});

test("Skill metadata is evidence only and never a deterministic requirement", async () => {
    const h = await setup();
    try {
        h.enableClassifier({ status: "not_required", reasoning: "The Skill does not need persisted control for this request." });
        const skillDir = join(h.root, "metadata-skill"); await mkdir(skillDir);
        const skillPath = join(skillDir, "SKILL.md"); await writeFile(skillPath, "---\nrequires_sequential_workflow: true\n---\nRun the operation.");
        await h.hook("turn_start");
        assert.equal(await h.hook("tool_call", { toolName: "read", input: { path: skillPath } }), undefined);
        assert.equal((await h.call("status", {})).details.workflows.length, 0);
        assert.ok(h.messages.some((message) => message[0].content === "Sequential Workflow is not required for this request."));
    } finally { await h.close(); }
});
test("explicit user cancellation remains mechanical", async () => {
    const h = await setup();
    try {
        h.enableClassifier({ status: "required", reasoning: "Required." });
        await h.hook("input", { text: "Use Sequential Workflow for this request.", source: "interactive" });
        const pending = (await h.call("status", {})).details.workflows[0];
        await h.hook("input", { text: "Cancel the Sequential Workflow.", source: "interactive" });
        assert.equal((await h.call("status", { workflowId: pending.id })).details.workflow.status, "cancelled");
    } finally { await h.close(); }
});
test("a Skill requirement is decided by the configured evaluator", async () => {
    const h = await setup();
    try {
        h.enableClassifier({ status: "required", reasoning: "The evaluated Skill requires workflow control." });
        const skillDir = join(h.root, "skill"); await mkdir(skillDir);
        const skillPath = join(skillDir, "SKILL.md"); await writeFile(skillPath, "---\nrequires_sequential_workflow: true\n---\nRun the operation.");
        await h.hook("turn_start");
        const result = await h.hook("tool_call", { toolName: "read", input: { path: skillPath } });
        assert.deepEqual(result, { block: true, terminate: true, reason: "Sequential Workflow definition mode has started from the required Skill." });
        assert.deepEqual(h.activeTools(), ["sequential_workflow_create"]);
        const audit = new DatabaseSync(join(h.root, "sequential-workflow.db")).prepare("SELECT phase FROM workflow_harness_events ORDER BY id").all() as Array<{ phase: string }>;
        assert.ok(audit.some((event) => event.phase === "requirement_classified_required"));
    } finally { await h.close(); }
});
test("an unavailable explicit Skill evaluator blocks work and is visible", async () => {
    const h = await setup();
    try {
        const skillDir = join(h.root, "ambiguous-skill"); await mkdir(skillDir);
        const skillPath = join(skillDir, "SKILL.md"); await writeFile(skillPath, "---\nrequires_sequential_workflow: true\n---\nA Skill.");
        await h.hook("turn_start");
        const result = await h.hook("tool_call", { toolName: "read", input: { path: skillPath } });
        assert.equal(result?.block, true);
        assert.ok(h.messages.some((message) => message[0].content === "Sequential Workflow requirement could not be classified."));
        const audit = new DatabaseSync(join(h.root, "sequential-workflow.db")).prepare("SELECT phase FROM workflow_harness_events ORDER BY id").all() as Array<{ phase: string }>;
        assert.ok(audit.some((event) => event.phase === "evaluation_blocked"));
    } finally { await h.close(); }
});
test("a new user input releases an unresolved requirement block when no workflow is active", async () => {
    const h = await setup();
    try {
        const skillDir = join(h.root, "blocked-skill"); await mkdir(skillDir);
        const skillPath = join(skillDir, "SKILL.md"); await writeFile(skillPath, "---\nrequires_sequential_workflow: true\n---\nA Skill.");
        await h.hook("turn_start");
        assert.equal((await h.hook("tool_call", { toolName: "read", input: { path: skillPath } }))?.block, true);
        const db = new DatabaseSync(join(h.root, "sequential-workflow.db"));
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_requirement_blocks WHERE session_id = ?").get("A") as { count: number }).count, 1);
        await h.hook("input", { text: "Continue with the ordinary request.", source: "interactive" });
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_requirement_blocks WHERE session_id = ?").get("A") as { count: number }).count, 0);
        await h.hook("turn_start");
        assert.equal(await h.hook("tool_call", { toolName: "bash", input: {} }), undefined);
    } finally { await h.close(); }
});
test("non-required follow-up does not create a workflow", async () => {
    const h = await setup();
    try {
        h.enableClassifier({ status: "not_required", reasoning: "Discussion only." });
        await h.hook("input", { text: "Discuss Sequential Workflow templates.", source: "interactive" });
        assert.equal((await h.call("status", {})).details.workflows.length, 0);
    } finally { await h.close(); }
});
test("System One requirement decisions preserve lifecycle visibility and block uncertainty", async () => {
    const h = await setup(); const oldFetch = globalThis.fetch, oldKey = process.env.OPENROUTER_API_KEY;
    try {
        await writeFile(join(h.root, "settings.json"), JSON.stringify({ sequentialWorkflow: { evaluation: { modelType: "system_one", systemOne: { provider: "openrouter", model: "typesafe/jev-test" } } } }));
        process.env.OPENROUTER_API_KEY = "test";
        globalThis.fetch = async () => new Response(JSON.stringify({ answers: { decision: { choice: "workflow_definition", confidence: 0.97, probabilities: { workflow_definition: 0.97, no_workflow: 0.03 } } } }), { status: 200 });
        await h.hook("input", { text: "Use Sequential Workflow to process this request safely.", source: "interactive" });
        assert.equal((await h.call("status", {})).details.workflows[0].status, "pending_definition");
        assert.ok(h.messages.some((message) => message[0].content === "Sequential Workflow is required for this request."));
        const events = new DatabaseSync(join(h.root, "sequential-workflow.db")).prepare("SELECT phase, payload FROM workflow_harness_events ORDER BY id").all() as Array<{ phase: string; payload: string }>;
        assert.ok(events.some((event) => event.phase === "requirement_classified_required" && JSON.parse(event.payload).evaluator === "system_one"));
    } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; await h.close(); }
});
test("invalid System One configuration fails safely and blocks external work", async () => {
    const h = await setup();
    try {
        await writeFile(join(h.root, "settings.json"), JSON.stringify({ sequentialWorkflow: { evaluation: { modelType: "system_one", systemOne: { provider: "wrong", model: "" } } } }));
        await h.hook("input", { text: "Use Sequential Workflow for this request.", source: "interactive" });
        await h.hook("turn_start");
        assert.equal((await h.hook("tool_call", { toolName: "bash", input: {} })).block, true);
        assert.equal((await h.hook("tool_call", { toolName: "sequential_workflow_create", input: {} })).block, true);
        assert.ok(h.messages.some((message) => message[0].content === "Sequential Workflow requirement could not be classified."));
    } finally { await h.close(); }
});
test("Console and API expose the dedicated Sequential Workflows configuration", async () => {
    const server = await readFile(join(process.cwd(), "extensions/api-server/server.ts"), "utf8");
    const consoleSource = await readFile(join(process.cwd(), "extensions/pi-console-webui/components/console.tsx"), "utf8");
    assert.match(server, /\/api\/profiles\/:profile\/sequential-workflows\/config/);
    assert.match(server, /credentialConfigured/);
    assert.match(consoleSource, /href: "\/sequential-workflows"[\s\S]*href: "\/applications"/);
    assert.match(consoleSource, /SequentialWorkflowConfig/);
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
