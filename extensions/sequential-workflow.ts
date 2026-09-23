import { workflowHarness } from "./lib/workflow-harness.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdir, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
type TaskType = "action" | "collect" | "evaluate" | "workflow";
type TaskStatus = "pending" | "running" | "awaiting_user" | "waiting_subworkflow" | "evaluating" | "accepted" | "rejected" | "failed";
type WorkflowStatus = "pending_definition" | "running" | "awaiting_user" | "evaluating" | "completed" | "cancelled" | "failed";
type Task = {
    id: number;
    workflow_id: number;
    position: number;
    type: TaskType;
    instruction: string;
    criteria: string | null;
    status: TaskStatus;
    attempts: number;
    result: string | null;
    evaluation: string | null;
    child_workflow_id: number | null;
};
type Workflow = {
    id: number;
    title: string;
    source: string;
    status: WorkflowStatus;
    parent_workflow_id: number | null;
};
type WorkflowTaskDefinition = {
    type: TaskType;
    instruction: string;
    criteria?: string;
};
type WorkflowDefinition = {
    title: string;
    source: string;
    tasks: WorkflowTaskDefinition[];
};
type WorkflowTemplate = WorkflowDefinition & {
    version: 1;
};
const templateMaxBytes = 1024 * 1024;
const templateMaxTasks = 1000;
const templateMaxTitleLength = 1000;
const templateMaxSourceLength = 2000;
const templateMaxTextLength = 10000;
const maxActionAttempts = 5;
const taskType = StringEnum(["action", "collect", "evaluate", "workflow"] as const);
const phaseType = StringEnum(["action", "collect"] as const);
const workflowRoot = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const workflowDatabase = () => join(workflowRoot(), "sequential-workflow.db");
const templateDirectory = () => join(workflowRoot(), "sequential_workflow_templates");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const requiredText = (value: unknown, field: string, maxLength: number) => {
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error(`Invalid template: ${field} is required.`);
    if (value.length > maxLength)
        throw new Error(`Invalid template: ${field} exceeds ${maxLength} characters.`);
    return value;
};
const onlyProperties = (value: Record<string, unknown>, allowed: string[], field: string) => {
    const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
    if (unexpected)
        throw new Error(`Invalid template: ${field} contains unsupported property ${unexpected}.`);
};
const validateTemplate = (value: unknown): WorkflowTemplate => {
    if (!isRecord(value))
        throw new Error("Invalid template: root must be a JSON object.");
    onlyProperties(value, ["version", "title", "source", "tasks"], "raiz");
    if (value.version !== 1)
        throw new Error("Invalid template: version must be 1.");
    if (!Array.isArray(value.tasks) || value.tasks.length === 0)
        throw new Error("Invalid template: tasks must contain at least one task.");
    if (value.tasks.length > templateMaxTasks)
        throw new Error(`Invalid template: tasks cannot exceed ${templateMaxTasks} items.`);
    const tasks = value.tasks.map((item, index) => {
        if (!isRecord(item))
            throw new Error(`Invalid template: tasks[${index}] must be an object.`);
        onlyProperties(item, ["type", "instruction", "criteria"], `tasks[${index}]`);
        if (item.type !== "action" && item.type !== "collect" && item.type !== "evaluate" && item.type !== "workflow")
            throw new Error(`Invalid template: tasks[${index}].type must be action, collect, evaluate, or workflow.`);
        const criteria = item.criteria === undefined ? undefined : requiredText(item.criteria, `tasks[${index}].criteria`, templateMaxTextLength);
        if (item.type === "collect" && !criteria)
            throw new Error(`Invalid template: tasks[${index}] is Collect and requires criteria.`);
        return { type: item.type as TaskType, instruction: requiredText(item.instruction, `tasks[${index}].instruction`, templateMaxTextLength), criteria };
    });
    return { version: 1, title: requiredText(value.title, "title", templateMaxTitleLength), source: requiredText(value.source, "source", templateMaxSourceLength), tasks };
};
const resolveTemplatePath = (inputPath: string) => {
    const expanded = inputPath === "~" ? homedir() : inputPath.startsWith("~/") ? join(homedir(), inputPath.slice(2)) : inputPath;
    return isAbsolute(expanded) || expanded === "." || expanded === ".." || expanded.startsWith("./") || expanded.startsWith("../") || expanded.startsWith(".\\") || expanded.startsWith("..\\") ? resolve(process.cwd(), expanded) : resolve(templateDirectory(), expanded);
};
const loadTemplate = async (inputPath: string) => {
    const path = resolveTemplatePath(!inputPath.includes("/") && !inputPath.includes("\\") && !inputPath.endsWith(".json") ? `${inputPath}.json` : inputPath);
    let content: string;
    try {
        const info = await stat(path);
        if (!info.isFile())
            throw new Error("not a regular file");
        if (info.size > templateMaxBytes)
            throw new Error(`excede o limite de ${templateMaxBytes} bytes`);
        content = await readFile(path, "utf8");
    }
    catch (error) {
        throw new Error(`Could not read template ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let document: unknown;
    try {
        document = JSON.parse(content);
    }
    catch (error) {
        throw new Error(`Invalid template: malformed JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { path, hash: createHash("sha256").update(content).digest("hex"), template: validateTemplate(document) };
};
export default function (host: ExtensionAPI) {
    const db = new DatabaseSync(workflowDatabase());
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    db.exec(`CREATE TABLE IF NOT EXISTS workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS workflow_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER NOT NULL REFERENCES workflows(id), position INTEGER NOT NULL, type TEXT NOT NULL, instruction TEXT NOT NULL, criteria TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, evaluation TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(workflow_id, position));
CREATE TABLE IF NOT EXISTS workflow_events (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER NOT NULL REFERENCES workflows(id), task_id INTEGER REFERENCES workflow_tasks(id), phase TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
    const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
    }>;
    if (!columns("workflows").some((column) => column.name === "parent_workflow_id"))
        db.exec("ALTER TABLE workflows ADD COLUMN parent_workflow_id INTEGER REFERENCES workflows(id)");
    if (!columns("workflow_tasks").some((column) => column.name === "child_workflow_id"))
        db.exec("ALTER TABLE workflow_tasks ADD COLUMN child_workflow_id INTEGER REFERENCES workflows(id)");
    db.exec("CREATE INDEX IF NOT EXISTS workflows_parent_workflow_id_idx ON workflows(parent_workflow_id); CREATE INDEX IF NOT EXISTS workflow_tasks_child_workflow_id_idx ON workflow_tasks(child_workflow_id); CREATE UNIQUE INDEX IF NOT EXISTS workflow_tasks_unique_child_workflow_idx ON workflow_tasks(child_workflow_id) WHERE child_workflow_id IS NOT NULL;");
    const harness = workflowHarness(host, db);
    const pi = harness.api;
    const one = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as T | undefined;
    const many = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as T[];
    const event = (workflowId: number, taskId: number | null, phase: string, payload: unknown) => db.prepare("INSERT INTO workflow_events (workflow_id, task_id, phase, payload) VALUES (?, ?, ?, ?)").run(workflowId, taskId, phase, JSON.stringify(payload));
    const workflow = (id: number) => one<Workflow>("SELECT id, title, source, status, parent_workflow_id FROM workflows WHERE id = ?", id);
    const isActive = (item: Workflow) => ["pending_definition", "running", "awaiting_user", "evaluating"].includes(item.status);
    const currentTask = (workflowId: number) => one<Task>("SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation, child_workflow_id FROM workflow_tasks WHERE workflow_id = ? AND status NOT IN ('accepted', 'failed') ORDER BY position LIMIT 1", workflowId);
    const taskSummary = (task: Task) => ({ id: task.id, position: task.position, type: task.type, instruction: task.instruction, criteria: task.criteria, status: task.status, attempts: task.attempts, childWorkflowId: task.child_workflow_id });
    const requireActiveWorkflow = (id: number) => { const item = workflow(id); if (!item)
        throw new Error(`Workflow #${id} does not exist.`); if (!isActive(item))
        throw new Error(`Workflow #${id} is ${item.status} and cannot be changed.`); return item; };
    const resolveParentAfterChild = (child: Workflow) => {
        const parentTask = one<Task>("SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation, child_workflow_id FROM workflow_tasks WHERE child_workflow_id = ? AND status = 'waiting_subworkflow'", child.id);
        if (!parentTask)
            return;
        const parent = workflow(parentTask.workflow_id);
        if (!parent || !isActive(parent))
            return;
        const result = `Subworkflow #${child.id} (${child.title}) finished with status ${child.status}.`;
        if (child.status === "completed" && !parentTask.criteria) {
            db.prepare("UPDATE workflow_tasks SET result = ?, status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(result, parentTask.id);
            event(parent.id, parentTask.id, "subworkflow_completed", { childWorkflowId: child.id, accepted: true });
            activateNext(parent);
            return;
        }
        db.prepare("UPDATE workflow_tasks SET result = ?, status = 'evaluating', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(result, parentTask.id);
        db.prepare("UPDATE workflows SET status = 'evaluating', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(parent.id);
        event(parent.id, parentTask.id, child.status === "completed" ? "subworkflow_completed" : "subworkflow_terminal", { childWorkflowId: child.id, status: child.status });
    };
    const activateNext = (item: Workflow): {
        completed: boolean;
        task?: Task;
    } => {
        const next = currentTask(item.id);
        if (!next) {
            db.prepare("UPDATE workflows SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.id);
            const completed = workflow(item.id)!;
            event(item.id, null, "completed", { message: "All tasks were accepted." });
            resolveParentAfterChild(completed);
            return { completed: true };
        }
        const status: TaskStatus = next.type === "collect" ? "awaiting_user" : "running";
        const workflowStatus: WorkflowStatus = next.type === "collect" ? "awaiting_user" : "running";
        db.prepare("UPDATE workflow_tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, next.id);
        db.prepare("UPDATE workflows SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflowStatus, item.id);
        const activated = currentTask(item.id)!;
        event(item.id, activated.id, "activated", taskSummary(activated));
        return { completed: false, task: activated };
    };
    const cancelWorkflow = (workflowId: number) => {
        const item = requireActiveWorkflow(workflowId);
        db.prepare("UPDATE workflows SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(item.id);
        event(item.id, null, "cancelled", { by: "user", sessionId: harness.session() });
        resolveParentAfterChild(workflow(item.id)!);
        return { content: [{ type: "text" as const, text: `Workflow #${item.id} cancelled.` }], details: { workflowId: item.id, status: "cancelled" } };
    };
    const validateDefinition = (definition: WorkflowDefinition) => {
        for (const [index, task] of definition.tasks.entries())
            if (task.type === "collect" && !task.criteria)
                throw new Error(`Task ${index + 1} is Collect and requires criteria.`);
    };
    const insertTasks = (workflowId: number, definition: WorkflowDefinition) => {
        const insertTask = db.prepare("INSERT INTO workflow_tasks (workflow_id, position, type, instruction, criteria, status) VALUES (?, ?, ?, ?, ?, 'pending')");
        definition.tasks.forEach((task, index) => insertTask.run(workflowId, index + 1, task.type, task.instruction, task.criteria ?? null));
    };
    const workflowResult = (workflowId: number, parentTask?: Task) => {
        const next = activateNext(workflow(workflowId)!);
        const suffix = parentTask ? ` linked to parent task #${parentTask.id}.` : ".";
        return { content: [{ type: "text" as const, text: next.completed ? `Workflow #${workflowId} created and completed${suffix}` : `Workflow #${workflowId} created${suffix} Execute only task #${next.task!.position}: ${next.task!.instruction}` }], details: { workflowId, parentWorkflowId: parentTask?.workflow_id ?? null, parentTaskId: parentTask?.id ?? null, next } };
    };
    const createRootWorkflow = (definition: WorkflowDefinition) => {
        validateDefinition(definition);
        const pendingWorkflowId = harness.pendingWorkflow();
        const workflowId = pendingWorkflowId ?? Number(db.prepare("INSERT INTO workflows (title, source, status, session_id) VALUES (?, ?, 'running', ?)").run(definition.title, definition.source, harness.session()).lastInsertRowid);
        if (pendingWorkflowId) {
            db.prepare("UPDATE workflows SET title=?, source=?, status='running', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(definition.title, definition.source, workflowId);
            event(workflowId, null, "definition_supplied", { title: definition.title, taskCount: definition.tasks.length });
        }
        else
            event(workflowId, null, "created", { title: definition.title, taskCount: definition.tasks.length, parentWorkflowId: null });
        insertTasks(workflowId, definition);
        return workflowResult(workflowId);
    };
    const createSubworkflow = (definition: WorkflowDefinition, parentWorkflowId: number, parentTaskId: number) => {
        validateDefinition(definition);
        const parentTask = one<Task>("SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation, child_workflow_id FROM workflow_tasks WHERE id = ?", parentTaskId);
        if (!parentTask)
            throw new Error(`Parent task #${parentTaskId} does not exist.`);
        if (parentTask.workflow_id !== parentWorkflowId)
            throw new Error("parentWorkflowId does not match parentTaskId's workflow.");
        if (parentTask.type !== "workflow")
            throw new Error(`Task pai #${parentTaskId} deve ser do tipo workflow.`);
        if (parentTask.status !== "running")
            throw new Error(`Parent task #${parentTaskId} is not ready to start a subworkflow.`);
        if (parentTask.child_workflow_id !== null)
            throw new Error(`Parent task #${parentTaskId} already has a linked subworkflow.`);
        requireActiveWorkflow(parentWorkflowId);
        const workflowId = Number(db.prepare("INSERT INTO workflows (title, source, status, parent_workflow_id, session_id) VALUES (?, ?, 'running', ?, ?)").run(definition.title, definition.source, parentWorkflowId, harness.session()).lastInsertRowid);
        event(workflowId, null, "created", { title: definition.title, taskCount: definition.tasks.length, parentWorkflowId });
        insertTasks(workflowId, definition);
        db.prepare("UPDATE workflow_tasks SET child_workflow_id = ?, status = 'waiting_subworkflow', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflowId, parentTask.id);
        event(parentTask.workflow_id, parentTask.id, "child_linked", { childWorkflowId: workflowId });
        return workflowResult(workflowId, parentTask);
    };
    const definitionParameters = { title: Type.String({ minLength: 1 }), source: Type.String({ minLength: 1 }), tasks: Type.Array(Type.Object({ type: taskType, instruction: Type.String({ minLength: 1 }), criteria: Type.Optional(Type.String({ minLength: 1 })) }), { minItems: 1 }) };
    pi.registerTool({ name: "sequential_workflow_create", label: "Create Sequential Workflow", description: "Creates a root workflow or defines the focused pending workflow.", promptSnippet: "Create or define a root Sequential Workflow", promptGuidelines: ["Use sequential_workflow_create to create a root workflow or define the focused pending workflow from an ordinary user request. It never creates a subworkflow.", "Do not use a template unless the user explicitly requested a named template; use sequential_workflow_create_from_template only for that case.", "A Collect task passed to sequential_workflow_create must include acceptance criteria.", "An Action task with criteria fails its workflow after five rejected attempts."], parameters: Type.Object(definitionParameters), async execute(_id, params): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
            details: Record<string, unknown>;
        }> { return createRootWorkflow(params); } });
    pi.registerTool({ name: "sequential_workflow_create_subworkflow", label: "Create Sequential Subworkflow", description: "Creates a child workflow for the focused running workflow task.", promptSnippet: "Create a Sequential Workflow child", promptGuidelines: ["Use only when the focused current task has type workflow and requires a child workflow.", "parentWorkflowId and parentTaskId are required and must identify that focused running task."], parameters: Type.Object({ parentWorkflowId: Type.Integer({ minimum: 1 }), parentTaskId: Type.Integer({ minimum: 1 }), ...definitionParameters }), async execute(_id, params): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
            details: Record<string, unknown>;
        }> { return createSubworkflow(params, params.parentWorkflowId, params.parentTaskId); } });
    pi.registerTool({ name: "sequential_workflow_prepare_template_directory", label: "Prepare Sequential Workflow Template Directory", description: "Creates when needed and reports the active profile's default Sequential Workflow JSON template directory.", promptSnippet: "Prepare the active profile's default Sequential Workflow template directory", promptGuidelines: ["Use sequential_workflow_prepare_template_directory only when the user explicitly names Sequential Workflow and asks to create or edit its JSON template without specifying an output directory."], parameters: Type.Object({}), async execute() { const path = templateDirectory(); await mkdir(path, { recursive: true }); return { content: [{ type: "text", text: `Template directory is ready: ${path}` }], details: { path } }; } });
    pi.registerTool({ name: "sequential_workflow_validate_template", label: "Validate Sequential Workflow Template", description: "Reads and validates a Sequential Workflow JSON template without creating or executing a workflow.", promptSnippet: "Validate a Sequential Workflow JSON template before it is used", promptGuidelines: ["Use sequential_workflow_validate_template only when the user explicitly names Sequential Workflow and asks to create, edit, or validate its JSON template."], parameters: Type.Object({ path: Type.String({ minLength: 1 }) }), async execute(_id, params): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
            details: Record<string, unknown>;
        }> { const loaded = await loadTemplate(params.path); return { content: [{ type: "text", text: `Valid template: ${loaded.path} (${loaded.template.tasks.length} tasks, SHA-256: ${loaded.hash}).` }], details: loaded }; } });
    pi.registerTool({ name: "sequential_workflow_create_from_template", label: "Create Sequential Workflow from Template", description: "Loads an explicitly named reusable template to create a root workflow or hydrate a template-mode pending workflow.", promptSnippet: "Create a root Sequential Workflow from an explicitly named template", promptGuidelines: ["Use sequential_workflow_create_from_template only when the user explicitly requested activation from a named reusable Sequential Workflow JSON template, or when template-mode definition context supplies that exact path.", "The path must be explicitly supplied by the user or the controlled template-mode context. Never guess, search for, infer, or invent a template name or use this tool as a fallback for an ordinary workflow request.", "This tool never creates a subworkflow."], parameters: Type.Object({ path: Type.String({ minLength: 1 }) }), async execute(_id, params): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
            details: Record<string, unknown>;
        }> { const loaded = await loadTemplate(params.path); return createRootWorkflow({ title: loaded.template.title, source: `Template ${loaded.path} (SHA-256: ${loaded.hash}): ${loaded.template.source}`, tasks: loaded.template.tasks }); } });
    pi.registerTool({ name: "sequential_workflow_record_result", label: "Record Workflow Result", description: "Registra o resultado da Action ou Collect atual de um workflow identificado.", promptSnippet: "Record the result of the active Action or Collect task", promptGuidelines: ["Use sequential_workflow_record_result immediately after completing the active Action or receiving the active Collect response."], parameters: Type.Object({ workflowId: Type.Integer({ minimum: 1 }), taskId: Type.Integer({ minimum: 1 }), phase: phaseType, result: Type.String({ minLength: 1 }) }), async execute(_id, params): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
            details: Record<string, unknown>;
        }> {
            const item = requireActiveWorkflow(params.workflowId);
            const task = currentTask(item.id);
            if (!task)
                throw new Error("There is no pending task.");
            if (task.type !== params.phase)
                throw new Error(`The current task is ${task.type}, not ${params.phase}.`);
            if (task.status === "evaluating")
                throw new Error("The result is already recorded; evaluate the current task.");
            if (task.criteria) {
                db.prepare("UPDATE workflow_tasks SET result = ?, status = 'evaluating', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.result, task.id);
                db.prepare("UPDATE workflows SET status = 'evaluating', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.id);
                event(item.id, task.id, "result_recorded", { phase: params.phase, result: params.result });
                return { content: [{ type: "text", text: `Result recorded. Now evaluate task #${task.position} against its criteria.` }], details: { taskId: task.id, needsEvaluation: true } };
            }
            db.prepare("UPDATE workflow_tasks SET result = ?, status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.result, task.id);
            event(item.id, task.id, "accepted_without_criteria", { result: params.result });
            const next = activateNext(item);
            return { content: [{ type: "text", text: next.completed ? "Task accepted; workflow completed." : `Task accepted. Execute task #${next.task!.position}: ${next.task!.instruction}` }], details: { next } };
        } });
    pi.registerTool({ name: "sequential_workflow_evaluate", label: "Evaluate Workflow Task", description: "Records acceptance or rejection of the current task in an identified workflow.", promptSnippet: "Accept or reject the active workflow task after evaluation", promptGuidelines: ["Use sequential_workflow_evaluate after every task with criteria and for every Evaluate task; never advance a rejected task."], parameters: Type.Object({ workflowId: Type.Integer({ minimum: 1 }), taskId: Type.Integer({ minimum: 1 }), accepted: Type.Boolean(), reasoning: Type.String({ minLength: 1 }) }), async execute(_id, params): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
            details: Record<string, unknown>;
        }> {
            const item = requireActiveWorkflow(params.workflowId);
            const task = currentTask(item.id);
            if (!task)
                throw new Error("There is no pending task.");
            if (task.type !== "evaluate" && task.status !== "evaluating")
                throw new Error("Record the task result before evaluating it.");
            if (params.accepted) {
                db.prepare("UPDATE workflow_tasks SET status = 'accepted', evaluation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.reasoning, task.id);
                event(item.id, task.id, "accepted", { reasoning: params.reasoning });
                const next = activateNext(item);
                return { content: [{ type: "text", text: next.completed ? "Evaluation accepted; workflow completed." : `Evaluation accepted. Execute only task #${next.task!.position}: ${next.task!.instruction}` }], details: { accepted: true, next } };
            }
            if (task.type === "action" && task.attempts + 1 >= maxActionAttempts) {
                db.prepare("UPDATE workflow_tasks SET status = 'failed', attempts = attempts + 1, evaluation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.reasoning, task.id);
                db.prepare("UPDATE workflows SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.id);
                event(item.id, task.id, "failed_attempt_limit", { reasoning: params.reasoning, attempts: task.attempts + 1, maxAttempts: maxActionAttempts });
                resolveParentAfterChild(workflow(item.id)!);
                return { content: [{ type: "text", text: `Task #${task.position} failed after ${maxActionAttempts} rejected attempts; workflow failed.` }], details: { accepted: false, failed: true, attempts: task.attempts + 1, maxAttempts: maxActionAttempts } };
            }
            if (task.type === "workflow") {
                event(item.id, task.id, "child_detached", { childWorkflowId: task.child_workflow_id });
                db.prepare("UPDATE workflow_tasks SET child_workflow_id=NULL, result=NULL WHERE id=?").run(task.id);
            }
            db.prepare("DELETE FROM workflow_collect_checkpoint WHERE task_id=?").run(task.id);
            const retryStatus: TaskStatus = task.type === "collect" ? "awaiting_user" : "running";
            const workflowStatus: WorkflowStatus = task.type === "collect" ? "awaiting_user" : "running";
            db.prepare("UPDATE workflow_tasks SET status = ?, attempts = attempts + 1, evaluation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(retryStatus, params.reasoning, task.id);
            db.prepare("UPDATE workflows SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflowStatus, item.id);
            event(item.id, task.id, "rejected", { reasoning: params.reasoning });
            return { content: [{ type: "text", text: task.type === "collect" ? `Criteria rejected. Remain on task #${task.position}.` : `Criteria rejected. Remain on task #${task.position} and repeat the action.` }], details: { accepted: false, task: taskSummary(currentTask(item.id)!) } };
        } });
    pi.registerTool({ name: "sequential_workflow_cancel", label: "Cancel Sequential Workflow", description: "Cancela um workflow ativo deste profile, sem cancelar seus descendentes.", promptSnippet: "Cancel a Sequential Workflow", promptGuidelines: ["Use sequential_workflow_cancel only after the user explicitly asks to cancel a named Sequential Workflow.", "sequential_workflow_cancel can cancel a workflow created in another session of the same profile; do not require adoption first.", "Cancelling a child workflow lets its parent handle the terminal child state; do not cancel descendants automatically."], parameters: Type.Object({ workflowId: Type.Integer({ minimum: 1 }) }), async execute(_id, params): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
            details: Record<string, unknown>;
        }> { return cancelWorkflow(params.workflowId); } });
    pi.registerTool({ name: "sequential_workflow_status", label: "Sequential Workflow Status", description: "Lista workflows ativos ou consulta o estado persistido de um workflow.", promptGuidelines: ["Use sequential_workflow_status only when the user explicitly asks to inspect, list, or continue a persisted Sequential Workflow. Never select or resume an existing workflow merely because it is active."], parameters: Type.Object({ workflowId: Type.Optional(Type.Integer({ minimum: 1 })), includeChildren: Type.Optional(Type.Boolean()) }), async execute(_id, params): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
            details: Record<string, unknown>;
        }> {
            if (params.workflowId === undefined) {
                const items = many<Workflow>("SELECT id, title, source, status, parent_workflow_id FROM workflows WHERE session_id = ? AND status IN ('pending_definition', 'running', 'awaiting_user', 'evaluating') ORDER BY id DESC", harness.session());
                return { content: [{ type: "text", text: items.length ? items.map((item) => `#${item.id} ${item.title} (${item.status})${item.parent_workflow_id ? `, parent #${item.parent_workflow_id}` : ""}; current task #${currentTask(item.id)?.position ?? "none"}.`).join("\n") : "There are no active workflows." }], details: { workflows: items.map((item) => ({ ...item, currentTask: currentTask(item.id) })) } };
            }
            const item = workflow(params.workflowId);
            if (!item)
                throw new Error(`Workflow #${params.workflowId} does not exist.`);
            const tasks = many<Task>("SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation, child_workflow_id FROM workflow_tasks WHERE workflow_id = ? ORDER BY position", item.id);
            const children = params.includeChildren ? many<Workflow>("SELECT id, title, source, status, parent_workflow_id FROM workflows WHERE parent_workflow_id = ? ORDER BY id", item.id) : [];
            return { content: [{ type: "text", text: `Workflow #${item.id} (${item.status}). Task atual: ${currentTask(item.id)?.position ?? "nenhuma"}.` }], details: { workflow: item, tasks, children } };
        } });
    pi.registerCommand("workflow-status", { description: "Show this session's workflows", handler: async (args, ctx) => {
            try {
                await harness.transaction(ctx, () => {
                    const rows = args.trim() ? [harness.own(Number(args.trim()))] : many<Workflow>("SELECT * FROM workflows WHERE session_id=? ORDER BY id DESC LIMIT 50", harness.session());
                    ctx.ui.notify(rows.map(w => `#${w.id} ${w.title}: ${w.status}`).join("\n") || "No workflows in this session.", "info");
                });
            }
            catch (error) {
                ctx.ui.notify(String(error), "error");
            }
        } });
    pi.registerCommand("workflow-cancel", { description: "Cancel an active workflow by ID without cancelling descendants", handler: async (args, ctx) => {
            try {
                await harness.transaction(ctx, () => {
                    cancelWorkflow(Number(args.trim()));
                });
                ctx.ui.notify("Workflow cancelled.", "warning");
            }
            catch (error) {
                ctx.ui.notify(String(error), "error");
            }
        } });
    pi.on("session_shutdown", () => db.close());
}
