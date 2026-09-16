import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import { mkdir, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

type TaskType = "action" | "collect" | "evaluate" | "workflow";
type TaskStatus = "pending" | "running" | "awaiting_user" | "waiting_subworkflow" | "evaluating" | "accepted" | "rejected" | "failed";
type WorkflowStatus = "running" | "awaiting_user" | "evaluating" | "completed" | "cancelled" | "failed";

type Task = { id: number; workflow_id: number; position: number; type: TaskType; instruction: string; criteria: string | null; status: TaskStatus; attempts: number; result: string | null; evaluation: string | null; child_workflow_id: number | null };
type Workflow = { id: number; title: string; source: string; status: WorkflowStatus; parent_workflow_id: number | null };
type WorkflowTaskDefinition = { type: TaskType; instruction: string; criteria?: string };
type WorkflowDefinition = { title: string; source: string; tasks: WorkflowTaskDefinition[] };
type WorkflowTemplate = WorkflowDefinition & { version: 1 };

const templateMaxBytes = 1024 * 1024;
const templateMaxTasks = 1000;
const templateMaxTitleLength = 1000;
const templateMaxSourceLength = 2000;
const templateMaxTextLength = 10000;
const taskType = StringEnum(["action", "collect", "evaluate", "workflow"] as const);
const phaseType = StringEnum(["action", "collect"] as const);
const workflowRoot = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const workflowDatabase = () => join(workflowRoot(), "sequential-workflow.db");
const templateDirectory = () => join(workflowRoot(), "sequential_workflow_templates");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const requiredText = (value: unknown, field: string, maxLength: number) => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Template inválido: ${field} é obrigatório.`);
  if (value.length > maxLength) throw new Error(`Template inválido: ${field} excede ${maxLength} caracteres.`);
  return value;
};
const onlyProperties = (value: Record<string, unknown>, allowed: string[], field: string) => {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Template inválido: ${field} contém a propriedade não permitida ${unexpected}.`);
};
const validateTemplate = (value: unknown): WorkflowTemplate => {
  if (!isRecord(value)) throw new Error("Template inválido: a raiz deve ser um objeto JSON.");
  onlyProperties(value, ["version", "title", "source", "tasks"], "raiz");
  if (value.version !== 1) throw new Error("Template inválido: version deve ser 1.");
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error("Template inválido: tasks deve conter ao menos uma task.");
  if (value.tasks.length > templateMaxTasks) throw new Error(`Template inválido: tasks não pode exceder ${templateMaxTasks} itens.`);
  const tasks = value.tasks.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Template inválido: tasks[${index}] deve ser um objeto.`);
    onlyProperties(item, ["type", "instruction", "criteria"], `tasks[${index}]`);
    if (item.type !== "action" && item.type !== "collect" && item.type !== "evaluate" && item.type !== "workflow") throw new Error(`Template inválido: tasks[${index}].type deve ser action, collect, evaluate ou workflow.`);
    const criteria = item.criteria === undefined ? undefined : requiredText(item.criteria, `tasks[${index}].criteria`, templateMaxTextLength);
    if (item.type === "collect" && !criteria) throw new Error(`Template inválido: tasks[${index}] é Collect e exige criteria.`);
    return { type: item.type as TaskType, instruction: requiredText(item.instruction, `tasks[${index}].instruction`, templateMaxTextLength), criteria };
  });
  return { version: 1, title: requiredText(value.title, "title", templateMaxTitleLength), source: requiredText(value.source, "source", templateMaxSourceLength), tasks };
};
const resolveTemplatePath = (inputPath: string) => {
  const expanded = inputPath === "~" ? homedir() : inputPath.startsWith("~/") ? join(homedir(), inputPath.slice(2)) : inputPath;
  return isAbsolute(expanded) || expanded === "." || expanded === ".." || expanded.startsWith("./") || expanded.startsWith("../") || expanded.startsWith(".\\") || expanded.startsWith("..\\") ? resolve(process.cwd(), expanded) : resolve(templateDirectory(), expanded);
};
const loadTemplate = async (inputPath: string) => {
  const path = resolveTemplatePath(inputPath);
  let content: string;
  try { const info = await stat(path); if (!info.isFile()) throw new Error("não é um arquivo regular"); if (info.size > templateMaxBytes) throw new Error(`excede o limite de ${templateMaxBytes} bytes`); content = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`Não foi possível ler o template ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  let document: unknown;
  try { document = JSON.parse(content); } catch (error) { throw new Error(`Template inválido: JSON malformado em ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  return { path, hash: createHash("sha256").update(content).digest("hex"), template: validateTemplate(document) };
};

export default function (pi: ExtensionAPI) {
  const db = new DatabaseSync(workflowDatabase());
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS workflow_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER NOT NULL REFERENCES workflows(id), position INTEGER NOT NULL, type TEXT NOT NULL, instruction TEXT NOT NULL, criteria TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, evaluation TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(workflow_id, position));
CREATE TABLE IF NOT EXISTS workflow_events (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER NOT NULL REFERENCES workflows(id), task_id INTEGER REFERENCES workflow_tasks(id), phase TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns("workflows").some((column) => column.name === "parent_workflow_id")) db.exec("ALTER TABLE workflows ADD COLUMN parent_workflow_id INTEGER REFERENCES workflows(id)");
  if (!columns("workflow_tasks").some((column) => column.name === "child_workflow_id")) db.exec("ALTER TABLE workflow_tasks ADD COLUMN child_workflow_id INTEGER REFERENCES workflows(id)");
  db.exec("CREATE INDEX IF NOT EXISTS workflows_parent_workflow_id_idx ON workflows(parent_workflow_id); CREATE INDEX IF NOT EXISTS workflow_tasks_child_workflow_id_idx ON workflow_tasks(child_workflow_id); CREATE UNIQUE INDEX IF NOT EXISTS workflow_tasks_unique_child_workflow_idx ON workflow_tasks(child_workflow_id) WHERE child_workflow_id IS NOT NULL;");

  const one = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined;
  const many = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];
  const event = (workflowId: number, taskId: number | null, phase: string, payload: unknown) => db.prepare("INSERT INTO workflow_events (workflow_id, task_id, phase, payload) VALUES (?, ?, ?, ?)").run(workflowId, taskId, phase, JSON.stringify(payload));
  const workflow = (id: number) => one<Workflow>("SELECT id, title, source, status, parent_workflow_id FROM workflows WHERE id = ?", id);
  const isActive = (item: Workflow) => ["running", "awaiting_user", "evaluating"].includes(item.status);
  const currentTask = (workflowId: number) => one<Task>("SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation, child_workflow_id FROM workflow_tasks WHERE workflow_id = ? AND status NOT IN ('accepted', 'failed') ORDER BY position LIMIT 1", workflowId);
  const taskSummary = (task: Task) => ({ id: task.id, position: task.position, type: task.type, instruction: task.instruction, criteria: task.criteria, status: task.status, attempts: task.attempts, childWorkflowId: task.child_workflow_id });
  const requireActiveWorkflow = (id: number) => { const item = workflow(id); if (!item) throw new Error(`Workflow #${id} não existe.`); if (!isActive(item)) throw new Error(`Workflow #${id} está ${item.status} e não pode ser alterado.`); return item; };

  const resolveParentAfterChild = (child: Workflow) => {
    const parentTask = one<Task>("SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation, child_workflow_id FROM workflow_tasks WHERE child_workflow_id = ? AND status = 'waiting_subworkflow'", child.id);
    if (!parentTask) return;
    const parent = workflow(parentTask.workflow_id);
    if (!parent || !isActive(parent)) return;
    const result = `Subworkflow #${child.id} (${child.title}) terminou com status ${child.status}.`;
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
  const activateNext = (item: Workflow): { completed: boolean; task?: Task } => {
    const next = currentTask(item.id);
    if (!next) {
      db.prepare("UPDATE workflows SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.id);
      const completed = workflow(item.id)!;
      event(item.id, null, "completed", { message: "Todas as tasks foram aceitas." });
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

  const createWorkflow = (definition: WorkflowDefinition, parentWorkflowId?: number, parentTaskId?: number) => {
    for (const [index, task] of definition.tasks.entries()) if (task.type === "collect" && !task.criteria) throw new Error(`Task ${index + 1} é Collect e exige criteria.`);
    let parentTask: Task | undefined;
    if (parentTaskId !== undefined) {
      parentTask = one<Task>("SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation, child_workflow_id FROM workflow_tasks WHERE id = ?", parentTaskId);
      if (!parentTask) throw new Error(`Task pai #${parentTaskId} não existe.`);
      if (parentTask.type !== "workflow") throw new Error(`Task pai #${parentTaskId} deve ser do tipo workflow.`);
      if (parentTask.status !== "running") throw new Error(`Task pai #${parentTaskId} não está pronta para iniciar um subworkflow.`);
      if (parentTask.child_workflow_id !== null) throw new Error(`Task pai #${parentTaskId} já possui um subworkflow vinculado.`);
      if (parentWorkflowId !== undefined && parentWorkflowId !== parentTask.workflow_id) throw new Error("parentWorkflowId não corresponde ao workflow da parentTaskId.");
      parentWorkflowId = parentTask.workflow_id;
      requireActiveWorkflow(parentWorkflowId);
    } else if (parentWorkflowId !== undefined && !workflow(parentWorkflowId)) throw new Error(`Workflow pai #${parentWorkflowId} não existe.`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = db.prepare("INSERT INTO workflows (title, source, status, parent_workflow_id) VALUES (?, ?, 'running', ?)").run(definition.title, definition.source, parentWorkflowId ?? null);
      const workflowId = Number(inserted.lastInsertRowid);
      const insertTask = db.prepare("INSERT INTO workflow_tasks (workflow_id, position, type, instruction, criteria, status) VALUES (?, ?, ?, ?, ?, 'pending')");
      definition.tasks.forEach((task, index) => insertTask.run(workflowId, index + 1, task.type, task.instruction, task.criteria ?? null));
      event(workflowId, null, "created", { title: definition.title, taskCount: definition.tasks.length, parentWorkflowId: parentWorkflowId ?? null });
      if (parentTask) {
        db.prepare("UPDATE workflow_tasks SET child_workflow_id = ?, status = 'waiting_subworkflow', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflowId, parentTask.id);
        event(parentTask.workflow_id, parentTask.id, "child_linked", { childWorkflowId: workflowId });
      }
      const next = activateNext(workflow(workflowId)!);
      db.exec("COMMIT");
      const suffix = parentTask ? ` vinculado à task pai #${parentTask.id}.` : ".";
      return { content: [{ type: "text" as const, text: next.completed ? `Workflow #${workflowId} criado e concluído${suffix}` : `Workflow #${workflowId} criado${suffix} Execute somente a task #${next.task!.position}: ${next.task!.instruction}` }], details: { workflowId, parentWorkflowId: parentWorkflowId ?? null, parentTaskId: parentTask?.id ?? null, next } };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };

  pi.on("before_agent_start", () => {
    const items = many<Workflow>("SELECT id, title, source, status, parent_workflow_id FROM workflows WHERE status IN ('running', 'awaiting_user', 'evaluating') ORDER BY id DESC LIMIT 20");
    if (!items.length) return;
    const summary = items.map((item) => { const task = currentTask(item.id); return `#${item.id}${item.parent_workflow_id ? ` (pai #${item.parent_workflow_id})` : ""} ${item.title}: ${item.status}; task #${task?.position ?? "nenhuma"} [${task?.type ?? "—"}] ${task?.status ?? "—"}`; }).join("\n");
    return { message: { customType: "sequential-workflow-state", display: false, content: `Workflows ativos (máximo 20):\n${summary}\nAntes de registrar, avaliar ou cancelar, selecione o workflow correto e use seu workflowId. Execute somente a task atual daquele workflow.` } };
  });

  pi.registerTool({ name: "sequential_workflow_create", label: "Create Sequential Workflow", description: "Persiste um workflow e ativa sua primeira task, sem bloquear outros workflows.", promptSnippet: "Create a persisted sequential workflow", promptGuidelines: ["Use sequential_workflow_create only after the user explicitly names Sequential Workflow, sequential-workflow, workflow sequencial, or fluxo de trabalho sequencial and asks to create or execute it.", "A Collect task passed to sequential_workflow_create must include acceptance criteria."], parameters: Type.Object({ title: Type.String({ minLength: 1 }), source: Type.String({ minLength: 1 }), parentWorkflowId: Type.Optional(Type.Integer({ minimum: 1 })), parentTaskId: Type.Optional(Type.Integer({ minimum: 1 })), tasks: Type.Array(Type.Object({ type: taskType, instruction: Type.String({ minLength: 1 }), criteria: Type.Optional(Type.String({ minLength: 1 })) }), { minItems: 1 }) }), async execute(_id, params) { return createWorkflow(params, params.parentWorkflowId, params.parentTaskId); } });
  pi.registerTool({ name: "sequential_workflow_prepare_template_directory", label: "Prepare Sequential Workflow Template Directory", description: "Cria, quando necessário, e informa o diretório padrão de templates JSON de Sequential Workflow do profile ativo.", promptSnippet: "Prepare the active profile's default Sequential Workflow template directory", promptGuidelines: ["Use sequential_workflow_prepare_template_directory only when the user explicitly names Sequential Workflow and asks to create or edit its JSON template without specifying an output directory."], parameters: Type.Object({}), async execute() { const path = templateDirectory(); await mkdir(path, { recursive: true }); return { content: [{ type: "text", text: `Diretório de templates pronto: ${path}` }], details: { path } }; } });
  pi.registerTool({ name: "sequential_workflow_validate_template", label: "Validate Sequential Workflow Template", description: "Lê e valida um arquivo JSON de template de Sequential Workflow sem criar ou executar um workflow.", promptSnippet: "Validate a Sequential Workflow JSON template before it is used", promptGuidelines: ["Use sequential_workflow_validate_template only when the user explicitly names Sequential Workflow and asks to create, edit, or validate its JSON template."], parameters: Type.Object({ path: Type.String({ minLength: 1 }) }), async execute(_id, params) { const loaded = await loadTemplate(params.path); return { content: [{ type: "text", text: `Template válido: ${loaded.path} (${loaded.template.tasks.length} tasks, SHA-256: ${loaded.hash}).` }], details: loaded }; } });
  pi.registerTool({ name: "sequential_workflow_create_from_template", label: "Create Sequential Workflow from Template", description: "Lê um template JSON validado e cria um workflow.", promptSnippet: "Create and start a persisted Sequential Workflow from a validated JSON template", promptGuidelines: ["Use sequential_workflow_create_from_template only when the user explicitly names Sequential Workflow and asks to execute a JSON template."], parameters: Type.Object({ path: Type.String({ minLength: 1 }), parentWorkflowId: Type.Optional(Type.Integer({ minimum: 1 })), parentTaskId: Type.Optional(Type.Integer({ minimum: 1 })) }), async execute(_id, params) { const loaded = await loadTemplate(params.path); return createWorkflow({ title: loaded.template.title, source: `Template ${loaded.path} (SHA-256: ${loaded.hash}): ${loaded.template.source}`, tasks: loaded.template.tasks }, params.parentWorkflowId, params.parentTaskId); } });
  pi.registerTool({ name: "sequential_workflow_record_result", label: "Record Workflow Result", description: "Registra o resultado da Action ou Collect atual de um workflow identificado.", promptSnippet: "Record the result of the active Action or Collect task", promptGuidelines: ["Use sequential_workflow_record_result immediately after completing the active Action or receiving the active Collect response."], parameters: Type.Object({ workflowId: Type.Integer({ minimum: 1 }), phase: phaseType, result: Type.String({ minLength: 1 }) }), async execute(_id, params) {
    const item = requireActiveWorkflow(params.workflowId); const task = currentTask(item.id); if (!task) throw new Error("Não existe task pendente."); if (task.type !== params.phase) throw new Error(`A task atual é ${task.type}, não ${params.phase}.`); if (task.status === "evaluating") throw new Error("O resultado já foi registrado; avalie a task atual.");
    if (task.criteria) { db.prepare("UPDATE workflow_tasks SET result = ?, status = 'evaluating', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.result, task.id); db.prepare("UPDATE workflows SET status = 'evaluating', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.id); event(item.id, task.id, "result_recorded", { phase: params.phase, result: params.result }); return { content: [{ type: "text", text: `Resultado registrado. Agora avalie a task #${task.position} contra o critério.` }], details: { taskId: task.id, needsEvaluation: true } }; }
    db.prepare("UPDATE workflow_tasks SET result = ?, status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.result, task.id); event(item.id, task.id, "accepted_without_criteria", { result: params.result }); const next = activateNext(item); return { content: [{ type: "text", text: next.completed ? "Task aceita; workflow concluído." : `Task aceita. Execute a task #${next.task!.position}: ${next.task!.instruction}` }], details: { next } };
  } });
  pi.registerTool({ name: "sequential_workflow_evaluate", label: "Evaluate Workflow Task", description: "Registra a aceitação ou reprovação da task atual de um workflow identificado.", promptSnippet: "Accept or reject the active workflow task after evaluation", promptGuidelines: ["Use sequential_workflow_evaluate after every task with criteria and for every Evaluate task; never advance a rejected task."], parameters: Type.Object({ workflowId: Type.Integer({ minimum: 1 }), accepted: Type.Boolean(), reasoning: Type.String({ minLength: 1 }) }), async execute(_id, params) {
    const item = requireActiveWorkflow(params.workflowId); const task = currentTask(item.id); if (!task) throw new Error("Não existe task pendente."); if (task.type !== "evaluate" && task.status !== "evaluating") throw new Error("Registre o resultado da task antes de avaliá-la.");
    if (params.accepted) { db.prepare("UPDATE workflow_tasks SET status = 'accepted', evaluation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.reasoning, task.id); event(item.id, task.id, "accepted", { reasoning: params.reasoning }); const next = activateNext(item); return { content: [{ type: "text", text: next.completed ? "Avaliação aceita; workflow concluído." : `Avaliação aceita. Execute somente a task #${next.task!.position}: ${next.task!.instruction}` }], details: { accepted: true, next } }; }
    const retryStatus: TaskStatus = task.type === "collect" ? "awaiting_user" : "running"; const workflowStatus: WorkflowStatus = task.type === "collect" ? "awaiting_user" : "running"; db.prepare("UPDATE workflow_tasks SET status = ?, attempts = attempts + 1, evaluation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(retryStatus, params.reasoning, task.id); db.prepare("UPDATE workflows SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflowStatus, item.id); event(item.id, task.id, "rejected", { reasoning: params.reasoning }); return { content: [{ type: "text", text: task.type === "collect" ? `Critério reprovado. Permaneça na task #${task.position}.` : `Critério reprovado. Permaneça na task #${task.position} e repita a ação.` }], details: { accepted: false, task: taskSummary(currentTask(item.id)!) } };
  } });
  pi.registerTool({ name: "sequential_workflow_status", label: "Sequential Workflow Status", description: "Lista workflows ativos ou consulta o estado persistido de um workflow.", parameters: Type.Object({ workflowId: Type.Optional(Type.Integer({ minimum: 1 })), includeChildren: Type.Optional(Type.Boolean()) }), async execute(_id, params) {
    if (params.workflowId === undefined) { const items = many<Workflow>("SELECT id, title, source, status, parent_workflow_id FROM workflows WHERE status IN ('running', 'awaiting_user', 'evaluating') ORDER BY id DESC"); return { content: [{ type: "text", text: items.length ? items.map((item) => `#${item.id} ${item.title} (${item.status})${item.parent_workflow_id ? `, pai #${item.parent_workflow_id}` : ""}; task #${currentTask(item.id)?.position ?? "nenhuma"}.`).join("\n") : "Não há workflows ativos." }], details: { workflows: items.map((item) => ({ ...item, currentTask: currentTask(item.id) })) } }; }
    const item = workflow(params.workflowId); if (!item) throw new Error(`Workflow #${params.workflowId} não existe.`); const tasks = many<Task>("SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation, child_workflow_id FROM workflow_tasks WHERE workflow_id = ? ORDER BY position", item.id); const children = params.includeChildren ? many<Workflow>("SELECT id, title, source, status, parent_workflow_id FROM workflows WHERE parent_workflow_id = ? ORDER BY id", item.id) : []; return { content: [{ type: "text", text: `Workflow #${item.id} (${item.status}). Task atual: ${currentTask(item.id)?.position ?? "nenhuma"}.` }], details: { workflow: item, tasks, children } };
  } });
  pi.registerCommand("workflow-status", { description: "Lista workflows sequenciais ativos ou mostra um workflow pelo ID", handler: async (args, ctx) => { const raw = Array.isArray(args) ? args[0] : String(args ?? "").trim().split(/\s+/)[0]; const id = raw ? Number(raw) : undefined; if (raw && (!Number.isInteger(id) || id! < 1)) return ctx.ui.notify("Uso: /workflow-status [workflowId]", "warning"); const item = id === undefined ? undefined : workflow(id); if (id !== undefined && !item) return ctx.ui.notify(`Workflow #${id} não existe.`, "warning"); if (item) return ctx.ui.notify(`Workflow #${item.id}: ${item.status}. Task atual: #${currentTask(item.id)?.position ?? "nenhuma"}.`, "info"); const items = many<Workflow>("SELECT id, title, source, status, parent_workflow_id FROM workflows WHERE status IN ('running', 'awaiting_user', 'evaluating') ORDER BY id DESC LIMIT 10"); ctx.ui.notify(items.length ? items.map((active) => `#${active.id} ${active.title} (${active.status})`).join(" | ") : "Não há workflows ativos.", "info"); } });
  pi.registerCommand("workflow-cancel", { description: "Cancela um workflow sequencial pelo ID", handler: async (args, ctx) => { const raw = Array.isArray(args) ? args[0] : String(args ?? "").trim().split(/\s+/)[0]; const id = Number(raw); if (!Number.isInteger(id) || id < 1) return ctx.ui.notify("Uso: /workflow-cancel <workflowId>", "warning"); const item = workflow(id); if (!item) return ctx.ui.notify(`Workflow #${id} não existe.`, "warning"); if (!isActive(item)) return ctx.ui.notify(`Workflow #${id} já está ${item.status}.`, "info"); db.prepare("UPDATE workflows SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(item.id); const cancelled = workflow(item.id)!; event(item.id, null, "cancelled", { by: "user" }); resolveParentAfterChild(cancelled); ctx.ui.notify(`Workflow #${item.id} cancelado.`, "warning"); } });
  pi.on("session_shutdown", () => db.close());
}
