import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
/** Session ownership and execution gates. Prompts explain state; these gates enforce it. */
export function workflowHarness(host: ExtensionAPI, db: DatabaseSync) {
    db.exec("PRAGMA busy_timeout = 5000");
    if (!(db.prepare("PRAGMA table_info(workflows)").all() as any[]).some(c => c.name === "session_id")) {
        db.exec("ALTER TABLE workflows ADD COLUMN session_id TEXT");
    }
    db.exec(`CREATE INDEX IF NOT EXISTS workflow_session_idx ON workflows(session_id);
    CREATE TABLE IF NOT EXISTS workflow_focus (session_id TEXT PRIMARY KEY, stack TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_collect_checkpoint (task_id INTEGER PRIMARY KEY REFERENCES workflow_tasks(id), user_entry_id TEXT);`);
    const context = new AsyncLocalStorage<ExtensionContext>();
    const session = () => {
        const id = context.getStore()?.sessionManager.getSessionId();
        if (!id)
            throw new Error("Workflow operations require a session context.");
        return id;
    };
    const row = (id: number) => db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as any;
    const task = (id: number) => db.prepare("SELECT * FROM workflow_tasks WHERE workflow_id = ? AND status NOT IN ('accepted', 'failed') ORDER BY position LIMIT 1").get(id) as any;
    const active = (w: any) => w && ["running", "awaiting_user", "evaluating"].includes(w.status);
    const save = (stack: number[]) => db.prepare("INSERT INTO workflow_focus VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET stack=excluded.stack").run(session(), JSON.stringify(stack));
    const stack = (): number[] => {
        const saved = db.prepare("SELECT stack FROM workflow_focus WHERE session_id = ?").get(session()) as any;
        return (saved ? JSON.parse(saved.stack) : []).filter((id: number) => {
            const w = row(id);
            return active(w) && w.session_id === session();
        });
    };
    const focus = () => stack().at(-1);
    const own = (id: number) => {
        const w = row(id);
        if (!w || w.session_id !== session())
            throw new Error("Workflow does not belong to this session. Use /workflow-adopt explicitly to transfer a workflow tree.");
        return w;
    };
    const userEntry = () => context.getStore()!.sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "user").at(-1)?.id ?? null;
    const checkpoint = () => {
        const id = focus();
        const t = id ? task(id) : undefined;
        if (t?.type === "collect" && t.status === "awaiting_user")
            db.prepare("INSERT OR IGNORE INTO workflow_collect_checkpoint VALUES (?, ?)").run(t.id, userEntry());
    };
    let queue: Promise<unknown> = Promise.resolve();
    const transaction = <T>(ctx: ExtensionContext, work: () => Promise<T> | T): Promise<T> => {
        const next = queue.then(() => context.run(ctx, async () => {
            db.exec("BEGIN IMMEDIATE");
            try {
                const result = await work();
                save(stack());
                checkpoint();
                db.exec("COMMIT");
                return result;
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        }));
        queue = next.catch(() => undefined);
        return next;
    };
    let namedFailure = false;
    const assertOperation = (name: string, params: any) => {
        if (namedFailure && (name === "sequential_workflow_create" || name.endsWith("create_from_template")))
            throw new Error("Named activation failed; a new user request is required before creating a replacement.");
        if (params.workflowId !== undefined)
            own(params.workflowId);
        if (name.endsWith("record_result") || name.endsWith("evaluate")) {
            if (focus() !== params.workflowId)
                throw new Error("Only the focused workflow can advance. Use /workflow-focus explicitly.");
            const t = task(params.workflowId);
            if (!t || t.id !== params.taskId)
                throw new Error("Stale or incorrect taskId; inspect the current task.");
            if (name.endsWith("record_result") && t.type === "collect") {
                const saved = db.prepare("SELECT user_entry_id FROM workflow_collect_checkpoint WHERE task_id = ?").get(t.id) as any;
                if (!saved || !userEntry() || saved.user_entry_id === userEntry())
                    throw new Error("Collect requires a new user response after activation.");
            }
        }
        if (name === "sequential_workflow_create" || name.endsWith("create_from_template")) {
            if (params.parentWorkflowId !== undefined)
                own(params.parentWorkflowId);
            if (params.parentTaskId !== undefined) {
                const t = db.prepare("SELECT * FROM workflow_tasks WHERE id = ?").get(params.parentTaskId) as any;
                if (!t || own(t.workflow_id).id !== focus() || task(t.workflow_id)?.id !== t.id)
                    throw new Error("Child must belong to the current focused task.");
            }
            else if (focus() !== undefined)
                throw new Error("Suspend the current workflow with /workflow-suspend before creating an independent execution.");
        }
    };
    const tools = new Map<string, any>();
    const api = new Proxy(host, { get(target, key) {
            if (key !== "registerTool")
                return Reflect.get(target, key);
            return (definition: any) => {
                const wrapped = { ...definition, async execute(id: string, params: any, signal: any, update: any, ctx: ExtensionContext) {
                        return transaction(ctx, async () => {
                            assertOperation(definition.name, params);
                            const result = await definition.execute(id, params, signal, update, ctx);
                            if (definition.name === "sequential_workflow_create" || definition.name.endsWith("create_from_template")) {
                                save([...stack(), result.details.workflowId]);
                            }
                            return result;
                        });
                    } };
                tools.set(definition.name, wrapped);
                host.registerTool(wrapped);
            };
        } });
    let namedActivation = false;
    host.on("before_agent_start", (_event, ctx) => context.run(ctx, () => {
        if (!namedActivation)
            return;
        namedActivation = false;
        const id = focus();
        const t = id ? task(id) : undefined;
        if (t?.type === "collect")
            db.prepare("UPDATE workflow_collect_checkpoint SET user_entry_id=? WHERE task_id=?").run(userEntry(), t.id);
    }));
    // Named activation is resolved before the model can invent a replacement plan.
    host.on("input", async (event, ctx) => {
        namedFailure = false;
        const match = event.text.trim().match(/^(?:ative|execute|inicie|activate|run|start)\s+(?:(?:o|the)\s+)?sequential[ -]workflow\s+([\w.-]+)\s*$/i);
        if (!match)
            return;
        try {
            const result = await tools.get("sequential_workflow_create_from_template").execute("named-start", { path: match[1] }, undefined, undefined, ctx);
            namedActivation = true;
            return { action: "transform" as const, text: `${event.text}\n${result.content[0].text}\nThe named template was executed by the harness. Do not create another workflow; follow its current task.` };
        }
        catch (error) {
            namedFailure = true;
            ctx.ui.notify(String(error), "error");
            return { action: "transform" as const, text: `${event.text}\nNamed workflow activation failed: ${String(error)}. Report the failure; do not invent a substitute workflow.` };
        }
    });
    let continuationKey = "";
    let continuations = 0;
    host.on("input", (event) => { if (event.source !== "extension")
        continuations = 0; });
    host.on("agent_end", (event, ctx) => context.run(ctx, () => {
        const last = event.messages.filter(m => m.role === "assistant").at(-1);
        if (last?.role === "assistant" && ["aborted", "error"].includes(last.stopReason))
            return;
        const id = focus();
        const t = id ? task(id) : undefined;
        if (!t || t.status === "awaiting_user" || t.status === "waiting_subworkflow")
            return;
        const key = `${session()}:${id}:${t.id}:${t.status}:${t.attempts}`;
        if (key !== continuationKey) {
            continuationKey = key;
            continuations = 0;
        }
        if (continuations++ >= 2) {
            ctx.ui.notify("Workflow remains pending: automatic continuation limit reached. Inspect the current task before resuming.", "warning");
            return;
        }
        host.sendMessage({ customType: "sequential-workflow-state", display: false, content: `Workflow ${id}, task ${t.id} is still ${t.status}. Complete the current phase and record its transition; do not claim workflow completion.` }, { triggerTurn: true, deliverAs: "followUp" });
    }));
    // Pi preflights sibling calls before executing them. Allow only one call per
    // model turn while focused (including a create call that establishes focus).
    let dispatched = false;
    host.on("turn_start", () => { dispatched = false; });
    host.on("tool_call", (event, ctx) => context.run(ctx, () => {
        const id = focus();
        if (id === undefined && !event.toolName.startsWith("sequential_workflow_create")) {
            dispatched = true;
            return;
        }
        if (dispatched)
            return { block: true, reason: "Sequential Workflow requires one tool call per model turn." };
        const t = id ? task(id) : undefined;
        const workflowTool = event.toolName.startsWith("sequential_workflow_");
        if (t && !workflowTool && (t.type !== "action" || t.status !== "running"))
            return { block: true, reason: `Task ${t.id} is ${t.type}/${t.status}; external tools are blocked until the required workflow transition.` };
        try {
            if (workflowTool)
                assertOperation(event.toolName, event.input);
        }
        catch (error) {
            return { block: true, reason: String(error) };
        }
        dispatched = true;
    }));
    host.on("context", (event, ctx) => context.run(ctx, () => {
        const messages = event.messages.filter(m => !(m.role === "custom" && m.customType === "sequential-workflow-state"));
        const id = focus();
        if (id !== undefined)
            messages.push({ role: "custom", customType: "sequential-workflow-state", display: false, timestamp: Date.now(), content: `Session workflow focus: ${id}. Current task: ${JSON.stringify(task(id))}. Work only on this task. Pass workflowId and taskId for transitions. Collect requires a new user response. External tools are blocked outside a running Action. Use one tool per turn. User commands /workflow-suspend and /workflow-focus control focus.` });
        return { messages };
    }));
    const command = (name: string, description: string, work: (args: string) => void) => host.registerCommand(name, { description, handler: async (args, ctx) => {
            try {
                await transaction(ctx, () => work(args.trim()));
                ctx.ui.notify("Workflow state updated.", "info");
            }
            catch (error) {
                ctx.ui.notify(String(error), "error");
            }
        } });
    command("workflow-suspend", "Suspend this session's focused workflow without cancelling it", () => { save([]); });
    command("workflow-focus", "Focus an owned workflow by ID", args => {
        let w = own(Number(args));
        if (!active(w))
            throw new Error("Workflow is terminal.");
        const chain = [w.id];
        while (task(w.id)?.status === "waiting_subworkflow") {
            w = own(task(w.id).child_workflow_id);
            if (chain.includes(w.id) || !active(w))
                throw new Error("Invalid child dependency.");
            chain.push(w.id);
        }
        save(chain);
    });
    command("workflow-adopt", "Explicitly transfer a root workflow and its descendants to this session", args => {
        const w = row(Number(args));
        if (!active(w) || w.parent_workflow_id)
            throw new Error("Specify an active root workflow.");
        const ids = (db.prepare("WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT w.id FROM workflows w JOIN tree t ON w.parent_workflow_id=t.id) SELECT id FROM tree").all(w.id) as any[]).map(x => x.id);
        for (const id of ids) {
            db.prepare("UPDATE workflows SET session_id=? WHERE id=?").run(session(), id);
            db.prepare("INSERT INTO workflow_events(workflow_id,phase,payload) VALUES (?, 'adopted', ?)").run(id, JSON.stringify({ fromSession: w.session_id, toSession: session() }));
        }
        let leaf = w.id;
        const chain = [leaf];
        while (task(leaf)?.status === "waiting_subworkflow") {
            leaf = task(leaf).child_workflow_id;
            if (chain.includes(leaf))
                throw new Error("Invalid cycle.");
            chain.push(leaf);
        }
        save(chain);
    });
    return { api, session, own, transaction, context, checkpoint };
}
