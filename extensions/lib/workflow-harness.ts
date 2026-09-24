import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { evaluateWorkflowRequirement, evaluateWorkflowTask, workflowEvaluationConfig, type RequirementDecision } from "./workflow-evaluator.ts";
import { Box, Text } from "@earendil-works/pi-tui";
/** Session ownership and execution gates. Prompts explain state; these gates enforce it. */
export function workflowHarness(host: ExtensionAPI, db: DatabaseSync) {
    db.exec("PRAGMA busy_timeout = 5000");
    if (!(db.prepare("PRAGMA table_info(workflows)").all() as any[]).some(c => c.name === "session_id")) {
        db.exec("ALTER TABLE workflows ADD COLUMN session_id TEXT");
    }
    db.exec(`CREATE INDEX IF NOT EXISTS workflow_session_idx ON workflows(session_id);
    CREATE TABLE IF NOT EXISTS workflow_focus (session_id TEXT PRIMARY KEY, stack TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_collect_checkpoint (task_id INTEGER PRIMARY KEY REFERENCES workflow_tasks(id), user_entry_id TEXT);
    CREATE TABLE IF NOT EXISTS workflow_harness_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      workflow_id INTEGER REFERENCES workflows(id),
      phase TEXT NOT NULL,
      origin TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS workflow_requirement_blocks (
      session_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
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
    const requirementBlock = () => db.prepare("SELECT reason FROM workflow_requirement_blocks WHERE session_id = ?").get(session()) as { reason: string } | undefined;
    const clearRequirementBlock = () => db.prepare("DELETE FROM workflow_requirement_blocks WHERE session_id = ?").run(session());
    const blockRequirement = (reason: string) => db.prepare("INSERT INTO workflow_requirement_blocks(session_id, reason) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET reason = excluded.reason, created_at = CURRENT_TIMESTAMP").run(session(), reason);
    const pendingWorkflow = () => {
        const id = focus();
        const item = id ? row(id) : undefined;
        return item?.status === "pending_definition" ? id : undefined;
    };
    const own = (id: number) => {
        const w = row(id);
        if (!w || w.session_id !== session())
            throw new Error("Workflow does not belong to this session. Use /workflow-adopt explicitly to transfer a workflow tree.");
        return w;
    };
    const userEntry = () => context.getStore()!.sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "user").at(-1)?.id ?? null;
    const addEvent = (workflowId: number, phase: string, payload: unknown) => db.prepare("INSERT INTO workflow_events(workflow_id, phase, payload) VALUES (?, ?, ?) ").run(workflowId, phase, JSON.stringify(payload));
    const audit = (phase: string, payload: unknown, origin?: "user_input" | "skill", workflowId?: number, display = false) => {
        db.prepare("INSERT INTO workflow_harness_events(session_id, workflow_id, phase, origin, payload) VALUES (?, ?, ?, ?, ?)").run(session(), workflowId ?? null, phase, origin ?? null, JSON.stringify(payload));
        if (workflowId)
            addEvent(workflowId, `harness_${phase}`, payload);
        if (display)
            host.sendMessage({ customType: "sequential-workflow-harness", display: true, content: (payload as any).message ?? phase, details: { phase, origin, workflowId, ...(payload as any) } });
    };
    const blockEvaluation = (reason: string, payload: Record<string, unknown> = {}, origin?: "user_input" | "skill", workflowId?: number) => {
        blockRequirement(reason);
        audit("evaluation_blocked", { ...payload, reason, message: "Sequential Workflow decision is unresolved; work remains blocked." }, origin, workflowId, true);
    };
    type DefinitionActivation = "definition" | "template";
    const definitionTools = (activation: DefinitionActivation) => [activation === "template" ? "sequential_workflow_create_from_template" : "sequential_workflow_create"];
    const definitionMode = (workflowId = pendingWorkflow()) => {
        if (!workflowId)
            return undefined;
        const event = db.prepare("SELECT payload FROM workflow_events WHERE workflow_id = ? AND phase = 'definition_mode_started' ORDER BY id DESC LIMIT 1").get(workflowId) as any;
        if (!event)
            return undefined;
        try {
            const mode = JSON.parse(event.payload) as { origin: "user_input" | "skill"; userRequest: string; skillPath?: string; skillContent?: string; activeTools: string[]; activation?: DefinitionActivation; templatePath?: string };
            return { ...mode, activation: mode.activation ?? "definition" };
        }
        catch {
            return undefined;
        }
    };
    const restoreDefinitionTools = (workflowId: number) => {
        const mode = definitionMode(workflowId);
        if (mode?.activeTools?.length)
            host.setActiveTools(mode.activeTools);
    };
    const startDefinitionMode = (workflowId: number, origin: "user_input" | "skill", userRequest: string, activation: DefinitionActivation = "definition", templatePath?: string, skillPath?: string, skillContent?: string) => {
        const activeTools = host.getActiveTools();
        addEvent(workflowId, "definition_mode_started", { origin, userRequest, activation, templatePath, skillPath, skillContent, activeTools });
        host.setActiveTools(definitionTools(activation));
    };
    const definitionEvaluationSent = (workflowId: number) => Boolean(db.prepare("SELECT 1 FROM workflow_events WHERE workflow_id = ? AND phase = 'definition_mode_evaluated' LIMIT 1").get(workflowId));
    const harnessEventExists = (workflowId: number, phase: string) => Boolean(db.prepare("SELECT 1 FROM workflow_harness_events WHERE session_id = ? AND (workflow_id = ? OR workflow_id IS NULL) AND phase = ? LIMIT 1").get(session(), workflowId, phase));
    const definitionAnnouncementSent = (workflowId: number) => Boolean(db.prepare("SELECT 1 FROM workflow_events WHERE workflow_id = ? AND phase = 'definition_mode_announced' LIMIT 1").get(workflowId));
    const announceDefinitionMode = (workflowId: number) => {
        const mode = definitionMode(workflowId);
        if (!mode || definitionAnnouncementSent(workflowId))
            return undefined;
        const template = mode.activation === "template";
        addEvent(workflowId, "definition_mode_announced", { activation: mode.activation, templatePath: mode.templatePath });
        return { customType: "sequential-workflow-created", content: template ? `Preparing workflow #${workflowId} from template: ${mode.templatePath}` : `Workflow #${workflowId} created — defining ordered tasks.`, display: true, details: { workflowId, origin: mode.origin, activation: mode.activation, templatePath: mode.templatePath } };
    };
    const createPendingWorkflow = (origin: "user_input" | "skill", evidence: string, reasoning: string) => {
        const existing = pendingWorkflow();
        if (existing)
            return existing;
        const inserted = db.prepare("INSERT INTO workflows(title, source, status, session_id) VALUES (?, ?, 'pending_definition', ?)").run("Pending workflow definition", `Sequential Workflow requirement detected from ${origin}.`, session());
        const workflowId = Number(inserted.lastInsertRowid);
        audit("requirement_detected", { origin, evidence, message: `Sequential Workflow requirement detected from ${origin === "skill" ? "a required Skill" : "the user request"}.` }, origin, workflowId);
        audit("requirement_classified_required", { requiresSequentialWorkflow: true, reasoning, message: "Sequential Workflow is required for this request." }, origin, workflowId);
        save([...stack(), workflowId]);
        return workflowId;
    };
    const cancelPendingWorkflowByUser = (reason: string) => {
        const id = pendingWorkflow();
        if (!id)
            return false;
        restoreDefinitionTools(id);
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
    const templateCandidates = async () => {
        const directory = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sequential_workflow_templates");
        try {
            return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => ({ id: entry.name.slice(0, -5), title: entry.name.slice(0, -5), source: join(directory, entry.name) }));
        } catch { return []; }
    };
    const classifyRequirement = async (ctx: ExtensionContext, origin: "user_input" | "skill", evidence: string, userRequest: string): Promise<RequirementDecision> => evaluateWorkflowRequirement(ctx, {
        origin,
        evidence,
        userRequest,
        recentUserMessages: ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "message" && entry.message?.role === "user").slice(-4).map((entry: any) => {
            const content = entry.message.content;
            return typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part.text ?? "").join("") : "";
        }),
        templates: await templateCandidates(),
    });
    const assertOperation = (name: string, params: any) => {
        if (params.workflowId !== undefined && name !== "sequential_workflow_cancel")
            own(params.workflowId);
        if (name.endsWith("evaluate") && requirementBlock())
            throw new Error("Configured workflow evaluation is unresolved; manual evaluation is blocked.");
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
            const pending = pendingWorkflow();
            const mode = definitionMode(pending);
            if (pending && mode && !definitionTools(mode.activation).includes(name))
                throw new Error(`Definition mode requires ${definitionTools(mode.activation)[0]}.`);
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
    host.registerMessageRenderer("sequential-workflow-evaluation", (message, { outputPad }, theme) => {
        const box = new Box(outputPad, 0);
        box.addChild(new Text(`${theme.fg("muted", "Evaluating Sequential Workflow requirement")}\n${theme.fg("dim", String(message.content))}`, 0, 0));
        return box;
    });
    host.registerMessageRenderer("sequential-workflow-created", (message, { outputPad }, theme) => {
        const workflowId = (message.details as any)?.workflowId;
        const box = new Box(outputPad, 0);
        box.addChild(new Text(`${theme.fg("muted", "Planning Sequential Workflow")}${workflowId ? ` #${workflowId}` : ""}\n${theme.fg("dim", String(message.content))}`, 0, 0));
        return box;
    });
    host.registerMessageRenderer("sequential-workflow-harness", (message, { outputPad }, theme) => {
        const box = new Box(outputPad, 0);
        box.addChild(new Text(`${theme.fg("muted", "Sequential Workflow")}: ${theme.fg("dim", String(message.content))}`, 0, 0));
        return box;
    });
    const tools = new Map<string, any>();
    const rawTools = new Map<string, any>();
    const restoreTaskAfterUnavailableEvaluation = (workflowId: number, taskId: number, type: string) => {
        const taskStatus = type === "collect" ? "awaiting_user" : "running";
        const workflowStatus = type === "collect" ? "awaiting_user" : "running";
        db.prepare("UPDATE workflow_tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workflow_id = ? AND status = 'evaluating'").run(taskStatus, taskId, workflowId);
        db.prepare("UPDATE workflows SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'evaluating'").run(workflowStatus, workflowId);
    };
    const automaticTaskEvaluation = async (ctx: ExtensionContext, workflowId: number, taskId: number, result: string) => {
        const current = task(workflowId);
        if (!current?.criteria || current.id !== taskId)
            return undefined;
        const decision = await evaluateWorkflowTask(ctx, { task: { type: current.type, instruction: current.instruction, criteria: current.criteria }, result });
        if (!decision)
            return undefined;
        const message = decision.outcome === "accept" ? `Task #${taskId} accepted by the configured evaluator.` : decision.outcome === "retry" ? `Task #${taskId} will be retried.` : decision.outcome === "fail" ? `Task #${taskId} ended with a terminal failure; workflow failed.` : `Task #${taskId} evaluation is unresolved; work remains blocked.`;
        audit(`task_evaluation_${decision.outcome}`, { taskId, ...decision, message }, undefined, workflowId, true);
        if (!["accept", "retry", "fail"].includes(decision.outcome)) {
            restoreTaskAfterUnavailableEvaluation(workflowId, taskId, current.type);
            blockEvaluation(decision.reasoning, decision as any, undefined, workflowId);
            return decision;
        }
        const evaluate = rawTools.get("sequential_workflow_evaluate");
        if (!evaluate)
            throw new Error("Sequential Workflow evaluator is unavailable.");
        const applied = await evaluate.execute("system-one-evaluation", { workflowId, taskId, outcome: decision.outcome, reasoning: decision.reasoning }, ctx.signal, undefined, ctx);
        if (applied.details?.next?.completed)
            audit("workflow_completed", { evaluator: decision.evaluator, model: decision.model, message: `Workflow #${workflowId} completed.` }, undefined, workflowId, true);
        return { ...decision, applied };
    };
    const api = new Proxy(host, { get(target, key) {
            if (key !== "registerTool")
                return Reflect.get(target, key);
            return (definition: any) => {
                rawTools.set(definition.name, definition);
                const wrapped = { ...definition, async execute(id: string, params: any, signal: any, update: any, ctx: ExtensionContext) {
                        return transaction(ctx, async () => {
                            assertOperation(definition.name, params);
                            const pendingBefore = pendingWorkflow();
                            const result = await definition.execute(id, params, signal, update, ctx);
                            if (definition.name === "sequential_workflow_create" || definition.name === "sequential_workflow_create_subworkflow" || definition.name.endsWith("create_from_template")) {
                                const workflowId = result.details.workflowId as number;
                                if (pendingBefore === workflowId)
                                    restoreDefinitionTools(workflowId);
                                save([...new Set([...stack(), workflowId])]);
                                audit("workflow_hydrated", { message: `Workflow #${workflowId} created and ready for its current task.` }, undefined, workflowId, true);
                            }
                            if (definition.name === "sequential_workflow_record_result" && result.details?.needsEvaluation) {
                                const automatic = await automaticTaskEvaluation(ctx, params.workflowId, params.taskId, params.result);
                                if (automatic?.applied)
                                    return automatic.applied;
                            }
                            if (definition.name === "sequential_workflow_evaluate" && result.details?.failed) {
                                const phase = result.details.terminal ? "task_terminal_failed" : "failed_attempt_limit";
                                audit(phase, { taskId: params.taskId, message: result.details.terminal ? `Task #${params.taskId} ended with a terminal failure; workflow failed.` : `Task #${params.taskId} reached its retry limit; workflow failed.` }, undefined, params.workflowId, true);
                            }
                            else if (definition.name === "sequential_workflow_evaluate" && (params.outcome === "retry" || params.accepted === false))
                                audit("task_retry", { taskId: params.taskId, message: `Task #${params.taskId} will be retried.` }, undefined, params.workflowId, true);
                            if ((definition.name === "sequential_workflow_evaluate" || definition.name === "sequential_workflow_record_result") && result.details?.next?.completed)
                                audit("workflow_completed", { message: `Workflow #${params.workflowId} completed.` }, undefined, params.workflowId, true);
                            return result;
                        });
                    } };
                tools.set(definition.name, wrapped);
                host.registerTool(wrapped);
            };
        } });
    host.on("before_agent_start", (_event, ctx) => context.run(ctx, () => {
        // Requirement checks are emitted immediately by the input/tool handler so
        // their visible custom message is persisted before any model turn begins.
        return;
    }));
    host.on("before_agent_start", (_event, ctx) => context.run(ctx, () => {
        const pending = pendingWorkflow();
        const mode = definitionMode(pending);
        if (!pending || !mode || mode.origin !== "user_input" || definitionEvaluationSent(pending))
            return;
        addEvent(pending, "definition_mode_evaluated", { requiresSequentialWorkflow: true });
        return { message: { customType: "sequential-workflow-evaluation", content: "Sequential Workflow is required for this request.", display: true, details: { workflowId: pending, requiresSequentialWorkflow: true } } };
    }));
    host.on("before_agent_start", (_event, ctx) => context.run(ctx, () => {
        const pending = pendingWorkflow();
        if (!pending)
            return;
        const message = announceDefinitionMode(pending);
        return message ? { message } : undefined;
    }));
    const workflowKeyword = /\b(?:sequential[\s-]workflow|workflow[\s-]sequencial|fluxo de trabalho sequencial)\b/i;
    const explicitWorkflowRequest = (text: string) => workflowKeyword.test(text);
    const skillRequiresWorkflowEvaluation = (content: string) => workflowKeyword.test(content);
    // Requirement decisions remain evaluator-owned, but evaluation starts as soon
    // as an explicit user request or a read Skill mentions Sequential Workflow.
    host.on("input", async (event, ctx) => context.run(ctx, async () => {
        // An unavailable requirement evaluator must not permanently lock a session
        // with no active workflow. A later user request is new evidence and can be
        // evaluated normally if it explicitly requests a workflow.
        if (event.source !== "extension" && focus() === undefined && requirementBlock()) {
            clearRequirementBlock();
            audit("requirement_block_released", { message: "A new user input released the unresolved Sequential Workflow evaluation block." }, "user_input");
        }
        const focused = focus();
        const focusedTask = focused ? task(focused) : undefined;
        const evaluationConfig = await workflowEvaluationConfig().catch(() => undefined);
        if (evaluationConfig?.modelType === "system_one" && focused && focusedTask?.type === "collect" && focusedTask.status === "awaiting_user") {
            const record = rawTools.get("sequential_workflow_record_result");
            if (!record)
                throw new Error("Sequential Workflow result recorder is unavailable.");
            const recorded = await transaction(ctx, () => record.execute("system-one-collect", { workflowId: focused, taskId: focusedTask.id, phase: "collect", result: event.text }, ctx.signal, undefined, ctx));
            if (recorded.details?.needsEvaluation)
                await transaction(ctx, () => automaticTaskEvaluation(ctx, focused, focusedTask.id, event.text));
            return { action: "continue" as const };
        }
        if (pendingWorkflow() && explicitUserOverride(event.text))
            await transaction(ctx, () => { cancelPendingWorkflowByUser(event.text); });
        if (focus() !== undefined || !event.text.trim() || !explicitWorkflowRequest(event.text))
            return;
        clearRequirementBlock();
        audit("requirement_check_started", { message: "Checking whether Sequential Workflow is required…" }, "user_input", undefined, true);
        const decision = await classifyRequirement(ctx, "user_input", event.text, event.text);
        const message = decision.status === "required" ? "Sequential Workflow is required for this request." : decision.status === "not_required" ? "Sequential Workflow is not required for this request." : decision.status === "uncertain" ? "Sequential Workflow decision is uncertain; work remains blocked." : "Sequential Workflow requirement could not be classified.";
        audit(`requirement_classified_${decision.status}`, { ...decision, requiresSequentialWorkflow: decision.status === "required", message }, "user_input", undefined, true);
        if (decision.status !== "required") {
            if (decision.status !== "not_required") await transaction(ctx, () => { blockEvaluation(decision.reasoning, decision as any, "user_input"); });
            return;
        }
        await transaction(ctx, async () => {
            if (focus() === undefined) {
                const workflowId = createPendingWorkflow("user_input", event.text, decision.reasoning);
                const template = decision.templateId ? (await templateCandidates()).find(candidate => candidate.id === decision.templateId) : undefined;
                startDefinitionMode(workflowId, "user_input", event.text, decision.activation ?? "definition", template?.source);
                audit("definition_mode_started", { evaluator: decision.evaluator, model: decision.model, message: `Sequential Workflow definition mode started for workflow #${workflowId}.` }, "user_input", workflowId);
            }
        });
    }));
    let continuationKey = "";
    let continuations = 0;
    host.on("input", (event) => { if (event.source !== "extension")
        continuations = 0; });
    host.on("agent_before_settle", (event, ctx) => context.run(ctx, () => {
        const pending = pendingWorkflow();
        if (pending && definitionMode(pending) && event.context.canContinue)
            return { continue: true };
    }));
    host.on("agent_end", (event, ctx) => context.run(ctx, () => {
        const last = event.messages.filter(m => m.role === "assistant").at(-1);
        if (last?.role === "assistant" && ["aborted", "error"].includes(last.stopReason))
            return;
        const id = focus();
        const pending = pendingWorkflow();
        if (pending && definitionMode(pending))
            return;
        const t = id ? task(id) : undefined;
        if (requirementBlock() || !pending && (!t || t.status === "awaiting_user" || t.status === "waiting_subworkflow" || t.status === "evaluating"))
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
    let definitionCutover = false;
    let definitionCutoverOrigin: "user_input" | "skill" | undefined;
    let definitionCutoverReadCallId: string | undefined;
    const latestUserRequest = (ctx: ExtensionContext) => {
        const content = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "message" && entry.message?.role === "user").at(-1)?.message?.content;
        return typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part.text ?? "").join("") : "";
    };
    host.on("turn_start", () => { dispatched = false; definitionCutover = false; definitionCutoverOrigin = undefined; definitionCutoverReadCallId = undefined; });
    host.on("tool_call", async (event, ctx) => context.run(ctx, async () => {
        if (event.toolName === "read" && typeof event.input?.path === "string" && basename(event.input.path) === "SKILL.md" && focus() === undefined) {
            try {
                const path = resolve(ctx.cwd, event.input.path);
                const content = await readFile(path, "utf8");
                {
                    if (skillRequiresWorkflowEvaluation(content)) {
                    const userRequest = latestUserRequest(ctx);
                    audit("requirement_check_started", { path, message: "Checking whether Sequential Workflow is required…" }, "skill", undefined, true);
                    const decision = await classifyRequirement(ctx, "skill", content, userRequest);
                    const message = decision.status === "required" ? "Sequential Workflow is required for this request." : decision.status === "not_required" ? "Sequential Workflow is not required for this request." : decision.status === "uncertain" ? "Sequential Workflow decision is uncertain; work remains blocked." : "Sequential Workflow requirement could not be classified.";
                    audit(`requirement_classified_${decision.status}`, { path, ...decision, requiresSequentialWorkflow: decision.status === "required", message }, "skill", undefined, true);
                    if (decision.status === "required") {
                        await transaction(ctx, async () => {
                            if (focus() === undefined) {
                                const workflowId = createPendingWorkflow("skill", path, decision.reasoning);
                                const template = decision.templateId ? (await templateCandidates()).find(candidate => candidate.id === decision.templateId) : undefined;
                                startDefinitionMode(workflowId, "skill", userRequest, decision.activation ?? "definition", template?.source, path, content);
                                audit("definition_mode_started", { path, message: `Sequential Workflow definition mode started for workflow #${workflowId}.` }, "skill", workflowId, true);
                            }
                        });
                        definitionCutover = true;
                        definitionCutoverOrigin = "skill";
                        definitionCutoverReadCallId = event.toolCallId;
                    }
                    else if (decision.status !== "not_required") {
                        await transaction(ctx, () => { blockEvaluation(decision.reasoning, decision as any, "skill"); });
                        definitionCutover = true;
                        definitionCutoverOrigin = "skill";
                    }
                    }
                }
            }
            catch {
                // The original read tool reports path and access errors.
            }
        }
        const allowCutoverRead = definitionCutoverReadCallId !== undefined && event.toolCallId === definitionCutoverReadCallId;
        if (definitionCutover && !allowCutoverRead)
            return { block: true, terminate: true, reason: definitionCutoverOrigin === "skill" ? "Sequential Workflow definition mode has started from the required Skill." : "Sequential Workflow definition mode has started from the user request." };
        // Let the already-preflighted Skill read complete. Its successful result is
        // replaced below, so the agent receives a controlled transition, not an error.
        if (allowCutoverRead)
            return;
        const id = focus();
        const blockedRequirement = requirementBlock();
        if (blockedRequirement && !["sequential_workflow_cancel", "sequential_workflow_status"].includes(event.toolName))
            return { block: true, terminate: true, reason: `Sequential Workflow evaluation is unresolved: ${blockedRequirement.reason}` };
        if (id === undefined && !event.toolName.startsWith("sequential_workflow_create")) {
            dispatched = true;
            return;
        }
        if (dispatched)
            return { block: true, reason: "Sequential Workflow requires one tool call per model turn." };
        const t = id ? task(id) : undefined;
        const workflowTool = event.toolName.startsWith("sequential_workflow_");
        if (pendingWorkflow() !== undefined && !workflowTool)
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
    host.on("tool_result", (event) => {
        if (definitionCutover && (event as any).toolCallId === definitionCutoverReadCallId && (event as any).toolName === "read" && !(event as any).isError)
            return { content: [{ type: "text", text: "Skill recognized. Sequential Workflow definition mode is active; create the required workflow before performing work." }], details: { definitionMode: true }, isError: false };
    });
    host.on("context_with_system", (event, ctx) => context.run(ctx, () => {
        const workflowId = pendingWorkflow();
        const mode = definitionMode(workflowId);
        if (!workflowId || !mode)
            return;
        const messages = event.messages.filter((message: any) => !(message.role === "custom" && message.customType === "sequential-workflow-state"));
        const skill = mode.skillContent ? `\n\nRequired Skill (${mode.skillPath ?? "SKILL.md"}):\n${mode.skillContent}` : "";
        const creationTool = definitionTools(mode.activation)[0];
        const template = mode.activation === "template" ? ` using the explicitly requested template path ${mode.templatePath}` : " from the original request";
        messages.push({ role: "system", content: `Sequential Workflow definition mode is active for workflow #${workflowId}. Create or hydrate it${template}${skill}. Make exactly one tool call to ${creationTool}. Do not read files or Skills, perform work, inspect state, create a subworkflow, or call any other tool.` } as any);
        return { messages };
    }));
    host.on("context", (event, ctx) => context.run(ctx, () => {
        const messages = event.messages.filter(m => !(m.role === "custom" && m.customType === "sequential-workflow-state"));
        const id = focus();
        if (id !== undefined) {
            const pending = pendingWorkflow();
            const mode = definitionMode(pending);
            const creationTool = mode ? definitionTools(mode.activation)[0] : "sequential_workflow_create";
            messages.push({ role: "custom", customType: "sequential-workflow-state", display: false, timestamp: Date.now(), content: pending
                ? `Session workflow focus: ${pending}. This workflow is pending definition because Sequential Workflow creation is required. Do not perform work or use external tools. Create or initialize this focused workflow using ${creationTool}.`
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
