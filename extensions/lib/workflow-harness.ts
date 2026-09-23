import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
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
    const active = (w: any) => w && ["pending_definition", "running", "awaiting_user", "evaluating"].includes(w.status);
    const save = (stack: number[]) => db.prepare("INSERT INTO workflow_focus VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET stack=excluded.stack").run(session(), JSON.stringify(stack));
    const stack = (): number[] => {
        const saved = db.prepare("SELECT stack FROM workflow_focus WHERE session_id = ?").get(session()) as any;
        return (saved ? JSON.parse(saved.stack) : []).filter((id: number) => {
            const w = row(id);
            return active(w) && w.session_id === session();
        });
    };
    const focus = () => stack().at(-1);
    const pendingWorkflow = () => {
        const id = focus();
        const item = id ? row(id) : undefined;
        return item?.status === "pending_definition" ? id : undefined;
    };
    const sequentialTerms = /\b(?:sequential[\s-]workflow|workflow\s+sequencial|fluxo\s+de\s+trabalho\s+sequencial)\b/iu;
    const hasSequentialTerm = (text: string) => sequentialTerms.test(text);
    const own = (id: number) => {
        const w = row(id);
        if (!w || w.session_id !== session())
            throw new Error("Workflow does not belong to this session. Use /workflow-adopt explicitly to transfer a workflow tree.");
        return w;
    };
    const userEntry = () => context.getStore()!.sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "user").at(-1)?.id ?? null;
    const addEvent = (workflowId: number, phase: string, payload: unknown) => db.prepare("INSERT INTO workflow_events(workflow_id, phase, payload) VALUES (?, ?, ?)").run(workflowId, phase, JSON.stringify(payload));
    const createPendingWorkflow = (origin: "user_input" | "skill", evidence: string, reasoning: string) => {
        const existing = pendingWorkflow();
        if (existing)
            return existing;
        const inserted = db.prepare("INSERT INTO workflows(title, source, status, session_id) VALUES (?, ?, 'pending_definition', ?)").run("Pending workflow definition", `Sequential Workflow requirement detected from ${origin}.`, session());
        const workflowId = Number(inserted.lastInsertRowid);
        addEvent(workflowId, "requirement_detected", { origin, evidence });
        addEvent(workflowId, "requirement_classified", { requiresSequentialWorkflow: true, reasoning });
        save([...stack(), workflowId]);
        return workflowId;
    };
    const cancelPendingWorkflowByUser = (reason: string) => {
        const id = pendingWorkflow();
        if (!id)
            return false;
        db.prepare("UPDATE workflows SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
        addEvent(id, "cancelled_by_user", { reason });
        save(stack().filter((workflowId) => workflowId !== id));
        return true;
    };
    const explicitUserOverride = (text: string) => /\b(?:skip|ignore|cancel|end|stop|do not (?:use|create)|don't (?:use|create)|continue manually|manual(?:mente)?|cancelar|encerrar|parar|ignorar|n[aã]o (?:use|crie)|sem (?:usar|criar)|seguir manualmente)\b/iu.test(text);
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
    const classifyRequirement = async (ctx: ExtensionContext, origin: "user_input" | "skill", evidence: string) => {
        if (!ctx.model)
            return { requiresSequentialWorkflow: true, reasoning: "No classifier model is available; blocked safely." };
        const messages: any[] = [
            { role: "system", content: "Determine whether the supplied context requires creating a persisted Sequential Workflow. Return only JSON with boolean requiresSequentialWorkflow and non-empty reasoning. Do not propose a template, tasks, or actions." },
            { role: "user", content: JSON.stringify({ origin, evidence, recentUserMessages: ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "message" && entry.message?.role === "user").slice(-4).map((entry: any) => entry.message.content) }) },
        ];
        ctx.ui.setStatus("sequential-workflow-evaluation", "Evaluating whether Sequential Workflow is required…");
        try {
            const response: any = await ctx.modelRegistry.streamSimple(ctx.model, { messages } as any, { signal: ctx.signal }).result();
            const content = typeof response?.content === "string" ? response.content : (response?.content ?? []).map((part: any) => part.text ?? "").join("");
            const parsed = JSON.parse(content);
            if (typeof parsed?.requiresSequentialWorkflow !== "boolean" || typeof parsed.reasoning !== "string" || !parsed.reasoning.trim())
                throw new Error("Invalid classifier response.");
            return parsed as { requiresSequentialWorkflow: boolean; reasoning: string };
        }
        catch (error) {
            return { requiresSequentialWorkflow: true, reasoning: `Classifier failed closed: ${error instanceof Error ? error.message : String(error)}` };
        }
        finally {
            ctx.ui.setStatus("sequential-workflow-evaluation", undefined);
        }
    };
    let namedFailure = false;
    const assertOperation = (name: string, params: any) => {
        if (namedFailure && (name === "sequential_workflow_create" || name.endsWith("create_from_template")))
            throw new Error("Named activation failed; a new user request is required before creating a replacement.");
        if (params.workflowId !== undefined && name !== "sequential_workflow_cancel")
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
            if (focus() !== undefined && pendingWorkflow() === undefined)
                throw new Error("Suspend the current workflow with /workflow-suspend before creating an independent execution.");
        }
        if (name === "sequential_workflow_create_subworkflow") {
            const t = db.prepare("SELECT * FROM workflow_tasks WHERE id = ?").get(params.parentTaskId) as any;
            if (!t || t.workflow_id !== params.parentWorkflowId || own(t.workflow_id).id !== focus() || task(t.workflow_id)?.id !== t.id)
                throw new Error("A subworkflow must belong to the current focused task.");
            if (t.type !== "workflow" || t.status !== "running")
                throw new Error("A subworkflow requires a running workflow task.");
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
                            if (definition.name === "sequential_workflow_create" || definition.name === "sequential_workflow_create_subworkflow" || definition.name.endsWith("create_from_template")) {
                                const workflowId = result.details.workflowId as number;
                                save([...new Set([...stack(), workflowId])]);
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
    host.on("input", async (event, ctx) => context.run(ctx, async () => {
        namedFailure = false;
        const match = event.text.trim().match(/^(?:ative|execute|inicie|activate|run|start)\s+(?:(?:o|the)\s+)?sequential[ -]workflow\s+([\w.-]+)\s*$/i);
        if (pendingWorkflow() && explicitUserOverride(event.text)) {
            await transaction(ctx, () => { cancelPendingWorkflowByUser(event.text); });
        }
        else if (!match && focus() === undefined && hasSequentialTerm(event.text)) {
            const decision = await classifyRequirement(ctx, "user_input", event.text);
            if (decision.requiresSequentialWorkflow)
                await transaction(ctx, () => {
                    if (focus() === undefined)
                        createPendingWorkflow("user_input", event.text, decision.reasoning);
                });
        }
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
    }));
    let continuationKey = "";
    let continuations = 0;
    host.on("input", (event) => { if (event.source !== "extension")
        continuations = 0; });
    host.on("agent_end", (event, ctx) => context.run(ctx, () => {
        const last = event.messages.filter(m => m.role === "assistant").at(-1);
        if (last?.role === "assistant" && ["aborted", "error"].includes(last.stopReason))
            return;
        const id = focus();
        const pending = pendingWorkflow();
        const t = id ? task(id) : undefined;
        if (!pending && (!t || t.status === "awaiting_user" || t.status === "waiting_subworkflow"))
            return;
        const key = pending ? `${session()}:${pending}:pending_definition` : `${session()}:${id}:${t.id}:${t.status}:${t.attempts}`;
        if (key !== continuationKey) {
            continuationKey = key;
            continuations = 0;
        }
        if (continuations++ >= 2) {
            ctx.ui.notify("Workflow remains pending: automatic continuation limit reached. Inspect the current task before resuming.", "warning");
            return;
        }
        const content = pending
            ? `Workflow ${pending} requires a definition. Do not perform work or use external tools. Create the focused pending workflow using the existing workflow creation tools.`
            : `Workflow ${id}, task ${t.id} is still ${t.status}. Complete the current phase and record its transition; do not claim workflow completion.`;
        host.sendMessage({ customType: "sequential-workflow-state", display: false, content }, { triggerTurn: true, deliverAs: "followUp" });
    }));
    // Pi preflights sibling calls before executing them. Allow only one call per
    // model turn while focused (including a create call that establishes focus).
    let dispatched = false;
    host.on("turn_start", () => { dispatched = false; });
    host.on("tool_call", async (event, ctx) => context.run(ctx, async () => {
        let activatedBySkillRead = false;
        if (event.toolName === "read" && typeof event.input?.path === "string" && basename(event.input.path) === "SKILL.md" && focus() === undefined) {
            try {
                const path = resolve(ctx.cwd, event.input.path);
                const content = await readFile(path, "utf8");
                if (hasSequentialTerm(content)) {
                    const decision = await classifyRequirement(ctx, "skill", content);
                    if (decision.requiresSequentialWorkflow) {
                        await transaction(ctx, () => {
                            if (focus() === undefined)
                                createPendingWorkflow("skill", path, decision.reasoning);
                        });
                        activatedBySkillRead = true;
                    }
                }
            }
            catch {
                // The original read tool reports path and access errors.
            }
        }
        const id = focus();
        if (id === undefined && !event.toolName.startsWith("sequential_workflow_create")) {
            dispatched = true;
            return;
        }
        if (dispatched)
            return { block: true, reason: "Sequential Workflow requires one tool call per model turn." };
        const t = id ? task(id) : undefined;
        const workflowTool = event.toolName.startsWith("sequential_workflow_");
        if (pendingWorkflow() !== undefined && !workflowTool && !activatedBySkillRead)
            return { block: true, reason: "Sequential Workflow creation is required before external tools may run." };
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
        if (id !== undefined) {
            const pending = pendingWorkflow();
            messages.push({ role: "custom", customType: "sequential-workflow-state", display: false, timestamp: Date.now(), content: pending
                ? `Session workflow focus: ${pending}. This workflow is pending definition because Sequential Workflow creation is required. Do not perform work or use external tools. Create or initialize this focused workflow using sequential_workflow_create or sequential_workflow_create_from_template.`
                : `Session workflow focus: ${id}. Current task: ${JSON.stringify(task(id))}. Work only on this task. Pass workflowId and taskId for transitions. Collect requires a new user response. External tools are blocked outside a running Action. Use one tool per turn. User commands /workflow-suspend and /workflow-focus control focus.` });
        }
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
    return { api, session, own, transaction, context, checkpoint, pendingWorkflow };
}
