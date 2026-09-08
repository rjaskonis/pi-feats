import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

type TaskType = "action" | "collect" | "evaluate";
type TaskStatus = "pending" | "running" | "awaiting_user" | "evaluating" | "accepted" | "rejected" | "failed";
type WorkflowStatus = "running" | "awaiting_user" | "evaluating" | "completed" | "cancelled" | "failed";

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
};

type Workflow = {
  id: number;
  title: string;
  source: string;
  status: WorkflowStatus;
};

const taskType = StringEnum(["action", "collect", "evaluate"] as const);
const phaseType = StringEnum(["action", "collect"] as const);
// Keep workflow state inside the active profile. Named profiles run under
// nono and cannot write the shared extension directory.
const workflowDatabase = () => join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sequential-workflow.db");

export default function (pi: ExtensionAPI) {
  const db = new DatabaseSync(workflowDatabase());
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS workflow_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL REFERENCES workflows(id),
      position INTEGER NOT NULL,
      type TEXT NOT NULL,
      instruction TEXT NOT NULL,
      criteria TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      evaluation TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workflow_id, position)
    );
    CREATE TABLE IF NOT EXISTS workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL REFERENCES workflows(id),
      task_id INTEGER REFERENCES workflow_tasks(id),
      phase TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const one = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined;
  const many = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];
  const event = (workflowId: number, taskId: number | null, phase: string, payload: unknown) => {
    db.prepare("INSERT INTO workflow_events (workflow_id, task_id, phase, payload) VALUES (?, ?, ?, ?)")
      .run(workflowId, taskId, phase, JSON.stringify(payload));
  };

  const activeWorkflow = () => one<Workflow>(
    "SELECT id, title, source, status FROM workflows WHERE status IN ('running', 'awaiting_user', 'evaluating') ORDER BY id DESC LIMIT 1",
  );
  const currentTask = (workflowId: number) => one<Task>(
    "SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation FROM workflow_tasks WHERE workflow_id = ? AND status NOT IN ('accepted', 'failed') ORDER BY position LIMIT 1",
    workflowId,
  );
  const taskSummary = (task: Task) => ({
    id: task.id,
    position: task.position,
    type: task.type,
    instruction: task.instruction,
    criteria: task.criteria,
    status: task.status,
    attempts: task.attempts,
  });

  const activateNext = (workflow: Workflow) => {
    const next = currentTask(workflow.id);
    if (!next) {
      db.prepare("UPDATE workflows SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflow.id);
      event(workflow.id, null, "completed", { message: "Todas as tasks foram aceitas." });
      return { completed: true };
    }
    const status: TaskStatus = next.type === "collect" ? "awaiting_user" : "running";
    const workflowStatus: WorkflowStatus = next.type === "collect" ? "awaiting_user" : "running";
    db.prepare("UPDATE workflow_tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, next.id);
    db.prepare("UPDATE workflows SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflowStatus, workflow.id);
    const activated = currentTask(workflow.id)!;
    event(workflow.id, activated.id, "activated", taskSummary(activated));
    return { completed: false, task: activated };
  };

  pi.on("before_agent_start", (_event, _ctx) => {
    const workflow = activeWorkflow();
    if (!workflow) return;
    const task = currentTask(workflow.id);
    if (!task) return;
    return {
      message: {
        customType: "sequential-workflow-state",
        display: false,
        content: `Workflow ativo #${workflow.id} (${workflow.title}). Task atual obrigatória: #${task.position} [${task.type}] ${task.instruction}\nStatus: ${task.status}. Critério: ${task.criteria ?? "nenhum"}. Não execute ou avance para outra task. Use as tools sequential_workflow_* para registrar resultado e avaliação.`,
      },
    };
  });

  pi.registerTool({
    name: "sequential_workflow_create",
    label: "Create Sequential Workflow",
    description: "Persiste um plano de workflow e ativa exclusivamente sua primeira task.",
    promptSnippet: "Create a persisted sequential workflow from a validated Action/Collect/Evaluate plan",
    promptGuidelines: [
      "Use sequential_workflow_create only after an explicit request to create or execute a workflow has been identified.",
      "A Collect task passed to sequential_workflow_create must include acceptance criteria.",
    ],
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      source: Type.String({ minLength: 1 }),
      tasks: Type.Array(Type.Object({
        type: taskType,
        instruction: Type.String({ minLength: 1 }),
        criteria: Type.Optional(Type.String({ minLength: 1 })),
      }), { minItems: 1 }),
    }),
    async execute(_id, params) {
      const active = activeWorkflow();
      if (active) throw new Error(`Já existe um workflow ativo (#${active.id}: ${active.title}). Conclua ou cancele-o antes de criar outro.`);
      for (const [index, task] of params.tasks.entries()) {
        if (task.type === "collect" && !task.criteria) {
          throw new Error(`Task ${index + 1} é Collect e exige criteria.`);
        }
      }
      const inserted = db.prepare("INSERT INTO workflows (title, source, status) VALUES (?, ?, 'running')")
        .run(params.title, params.source);
      const workflowId = Number(inserted.lastInsertRowid);
      const insertTask = db.prepare("INSERT INTO workflow_tasks (workflow_id, position, type, instruction, criteria, status) VALUES (?, ?, ?, ?, ?, 'pending')");
      params.tasks.forEach((task, index) => insertTask.run(workflowId, index + 1, task.type, task.instruction, task.criteria ?? null));
      const workflow = one<Workflow>("SELECT id, title, source, status FROM workflows WHERE id = ?", workflowId)!;
      event(workflowId, null, "created", { title: params.title, taskCount: params.tasks.length });
      const next = activateNext(workflow);
      const message = next.completed
        ? `Workflow #${workflowId} criado e concluído sem tasks pendentes.`
        : `Workflow #${workflowId} criado. Execute somente a task #${next.task!.position}: ${next.task!.instruction}`;
      return { content: [{ type: "text", text: message }], details: { workflowId, next } };
    },
  });

  pi.registerTool({
    name: "sequential_workflow_record_result",
    label: "Record Workflow Result",
    description: "Registra o resultado da Action ou Collect atual sem avançar uma task que ainda precise de avaliação.",
    promptSnippet: "Record the result of the active Action or Collect task",
    promptGuidelines: ["Use sequential_workflow_record_result immediately after completing the active Action or receiving the active Collect response."],
    parameters: Type.Object({ phase: phaseType, result: Type.String({ minLength: 1 }) }),
    async execute(_id, params) {
      const workflow = activeWorkflow();
      if (!workflow) throw new Error("Não existe workflow ativo.");
      const task = currentTask(workflow.id);
      if (!task) throw new Error("Não existe task pendente.");
      if (task.type !== params.phase) throw new Error(`A task atual é ${task.type}, não ${params.phase}.`);
      if (task.status === "evaluating") throw new Error("O resultado já foi registrado; avalie a task atual.");

      if (task.criteria) {
        db.prepare("UPDATE workflow_tasks SET result = ?, status = 'evaluating', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.result, task.id);
        db.prepare("UPDATE workflows SET status = 'evaluating', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflow.id);
        event(workflow.id, task.id, "result_recorded", { phase: params.phase, result: params.result });
        return { content: [{ type: "text", text: `Resultado registrado. Agora avalie a task #${task.position} contra o critério e chame sequential_workflow_evaluate.` }], details: { taskId: task.id, needsEvaluation: true } };
      }

      db.prepare("UPDATE workflow_tasks SET result = ?, status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.result, task.id);
      event(workflow.id, task.id, "accepted_without_criteria", { result: params.result });
      const next = activateNext(workflow);
      return { content: [{ type: "text", text: next.completed ? "Task aceita; workflow concluído." : `Task aceita. Execute a task #${next.task!.position}: ${next.task!.instruction}` }], details: { next } };
    },
  });

  pi.registerTool({
    name: "sequential_workflow_evaluate",
    label: "Evaluate Workflow Task",
    description: "Registra a aceitação ou reprovação da task atual e mantém a mesma task ativa quando ela é reprovada.",
    promptSnippet: "Accept or reject the active workflow task after evaluation",
    promptGuidelines: ["Use sequential_workflow_evaluate after every task with criteria and for every Evaluate task; never advance a rejected task."],
    parameters: Type.Object({
      accepted: Type.Boolean(),
      reasoning: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params) {
      const workflow = activeWorkflow();
      if (!workflow) throw new Error("Não existe workflow ativo.");
      const task = currentTask(workflow.id);
      if (!task) throw new Error("Não existe task pendente.");
      if (task.type !== "evaluate" && task.status !== "evaluating") {
        throw new Error("Registre o resultado da task antes de avaliá-la.");
      }

      if (params.accepted) {
        db.prepare("UPDATE workflow_tasks SET status = 'accepted', evaluation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.reasoning, task.id);
        event(workflow.id, task.id, "accepted", { reasoning: params.reasoning });
        const next = activateNext(workflow);
        return { content: [{ type: "text", text: next.completed ? "Avaliação aceita; workflow concluído." : `Avaliação aceita. Execute somente a task #${next.task!.position}: ${next.task!.instruction}` }], details: { accepted: true, next } };
      }

      const retryStatus: TaskStatus = task.type === "collect" ? "awaiting_user" : "running";
      const workflowStatus: WorkflowStatus = task.type === "collect" ? "awaiting_user" : "running";
      db.prepare("UPDATE workflow_tasks SET status = ?, attempts = attempts + 1, evaluation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(retryStatus, params.reasoning, task.id);
      db.prepare("UPDATE workflows SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflowStatus, workflow.id);
      event(workflow.id, task.id, "rejected", { reasoning: params.reasoning });
      return { content: [{ type: "text", text: task.type === "collect" ? `Critério reprovado. Permaneça na task #${task.position}, explique o que falta e solicite novamente a informação.` : `Critério reprovado. Permaneça na task #${task.position}, corrija ou repita a ação e registre um novo resultado.` }], details: { accepted: false, task: taskSummary(currentTask(workflow.id)!) } };
    },
  });

  pi.registerTool({
    name: "sequential_workflow_status",
    label: "Sequential Workflow Status",
    description: "Consulta o workflow ativo, sua task atual e o estado persistido.",
    parameters: Type.Object({}),
    async execute() {
      const workflow = activeWorkflow();
      if (!workflow) return { content: [{ type: "text", text: "Não há workflow ativo." }], details: {} };
      const tasks = many<Task>("SELECT id, workflow_id, position, type, instruction, criteria, status, attempts, result, evaluation FROM workflow_tasks WHERE workflow_id = ? ORDER BY position", workflow.id);
      return { content: [{ type: "text", text: `Workflow #${workflow.id} (${workflow.status}). Task atual: ${currentTask(workflow.id)?.position ?? "nenhuma"}.` }], details: { workflow, tasks } };
    },
  });

  pi.registerCommand("workflow-status", {
    description: "Mostra o estado do workflow sequencial ativo",
    handler: async (_args, ctx) => {
      const workflow = activeWorkflow();
      if (!workflow) return ctx.ui.notify("Não há workflow ativo.", "info");
      const task = currentTask(workflow.id);
      ctx.ui.notify(`Workflow #${workflow.id}: ${workflow.status}. Task atual: #${task?.position ?? "nenhuma"}.`, "info");
    },
  });

  pi.registerCommand("workflow-cancel", {
    description: "Cancela o workflow sequencial ativo",
    handler: async (_args, ctx) => {
      const workflow = activeWorkflow();
      if (!workflow) return ctx.ui.notify("Não há workflow ativo.", "info");
      db.prepare("UPDATE workflows SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(workflow.id);
      event(workflow.id, null, "cancelled", { by: "user" });
      ctx.ui.notify(`Workflow #${workflow.id} cancelado.`, "warning");
    },
  });

  pi.on("session_shutdown", () => db.close());
}
