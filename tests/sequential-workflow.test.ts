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
    const initialize = () => sequentialWorkflow({ registerTool: (t: any) => tools.set(t.name, t), registerCommand: (n: string, c: any) => commands.set(n, c), on: (n: string, h: any) => hooks.set(n, [...hooks.get(n) ?? [], h]), sendMessage: (...args: any[]) => messages.push(args) } as any);
    initialize();
    let sessionId = "A";
    let userId = "user-1";
    const ctx = { sessionManager: { getSessionId: () => sessionId, getBranch: () => [{ id: userId, type: "message", message: { role: "user" } }] }, ui: { notify: (...args: any[]) => notices.push(args) } };
    return {
        root, messages, notices, tools,
        reload() { for (const h of hooks.get("session_shutdown") ?? [])
            h(); hooks.clear(); tools.clear(); commands.clear(); initialize(); },
        session(id: string) { sessionId = id; }, reply(id: string) { userId = id; },
        call: (name: string, params: any) => tools.get(`sequential_workflow_${name}`).execute("call", params, undefined, undefined, ctx),
        command: (name: string, args = "") => commands.get(`workflow-${name}`).handler(args, ctx),
        hook: async (name: string, args: any = {}) => { let value; for (const h of hooks.get(name) ?? []) {
            const result = await h(args, ctx);
            if (result !== undefined)
                value = result;
        } return value; },
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
        const child = ids(await h.call("create", { ...definition(), parentTaskId: parent.taskId }));
        await assert.rejects(h.call("evaluate", { ...parent, accepted: true, reasoning: "skip" }), /focused/);
        await h.call("record_result", { ...child, phase: "action", result: "done" });
        await h.call("evaluate", { ...parent, accepted: false, reasoning: "retry" });
        const replacement = ids(await h.call("create", { ...definition(), parentTaskId: parent.taskId }));
        await h.command("cancel", String(replacement.workflowId));
        assert.equal((await h.call("status", parent)).details.tasks[0].status, "evaluating");
        await h.call("evaluate", { ...parent, accepted: true, reasoning: "Explicitly accept cancellation" });
        assert.equal((await h.call("status", parent)).details.tasks[1].status, "running");
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
