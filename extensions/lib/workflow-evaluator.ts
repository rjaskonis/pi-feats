import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type WorkflowEvaluationConfig = { modelType: "llm" | "system_one"; systemOne?: { provider: string; model: string; onUncertain?: "block" } };
export type RequirementDecision = { status: "required" | "not_required" | "uncertain" | "unavailable" | "invalid_response" | "error"; reasoning: string; activation?: "definition" | "template"; templateId?: string; evaluator: "llm" | "system_one"; model?: string; confidence?: number; probabilities?: Record<string, number> };
export type TaskDecision = { outcome: "accept" | "retry" | "fail" | "uncertain" | "unavailable" | "invalid_response" | "error"; reasoning: string; evaluator: "llm" | "system_one"; model?: string; confidence?: number; probabilities?: Record<string, number> };
export type RequirementInput = { origin: "user_input" | "skill"; evidence: string; userRequest: string; recentUserMessages: string[]; templates: Array<{ id: string; title: string; source: string }> };
export type TaskInput = { task: { type: "action" | "collect" | "workflow"; instruction: string; criteria: string }; result: string };

const root = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value : "";
const metadata = (answer: Record<string, unknown>, evaluator: "llm" | "system_one", model?: string) => ({ evaluator, model, confidence: typeof answer.confidence === "number" ? answer.confidence : undefined, probabilities: object(answer.probabilities) ? Object.fromEntries(Object.entries(answer.probabilities).filter(([, value]) => typeof value === "number")) as Record<string, number> : undefined });

export async function workflowEvaluationConfig(): Promise<WorkflowEvaluationConfig> {
    let settings: unknown = {};
    try { settings = JSON.parse(await readFile(join(root(), "settings.json"), "utf8")); } catch {}
    const evaluation = object(settings) && object(settings.sequentialWorkflow) && object(settings.sequentialWorkflow.evaluation) ? settings.sequentialWorkflow.evaluation : undefined;
    if (!evaluation || evaluation.modelType === undefined) return { modelType: "llm" };
    if (evaluation.modelType === "llm") return { modelType: "llm" };
    const systemOne = object(evaluation.systemOne) ? evaluation.systemOne : undefined;
    if (evaluation.modelType !== "system_one" || !systemOne || !text(systemOne.provider).trim() || !text(systemOne.model).trim() || (systemOne.onUncertain !== undefined && systemOne.onUncertain !== "block")) throw new Error("Invalid sequentialWorkflow.evaluation configuration.");
    return { modelType: "system_one", systemOne: { provider: text(systemOne.provider).trim(), model: text(systemOne.model).trim(), onUncertain: "block" } };
}

async function typesafeChoice(ctx: ExtensionContext, model: string, state: unknown, instructions: string, criteria: Record<string, string>): Promise<{ answer?: Record<string, unknown>; error?: string }> {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) return { error: "TypeSafe API credentials are unavailable." };
    try {
        const response = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, state, questions: { decision: { type: "choice", instructions, criteria } } }), signal: ctx.signal });
        if (!response.ok) return { error: `TypeSafe API returned HTTP ${response.status}.` };
        const body: unknown = await response.json();
        const answer = object(body) && object(body.answers) && object(body.answers.decision) ? body.answers.decision : undefined;
        return answer ? { answer } : { error: "TypeSafe API returned an invalid Choice response." };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function openRouterChoice(ctx: ExtensionContext, model: string, state: unknown, instructions: string, criteria: Record<string, string>): Promise<{ answer?: Record<string, unknown>; error?: string }> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return { error: "OpenRouter API credentials are unavailable." };
    try {
        const response = await fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: model.slice("openrouter/".length), state, questions: { decision: { type: "choice", instructions, criteria } } }), signal: ctx.signal });
        if (!response.ok) return { error: `OpenRouter Decisions API returned HTTP ${response.status}.` };
        const body: unknown = await response.json();
        const answer = object(body) && object(body.answers) && object(body.answers.decision) ? body.answers.decision : undefined;
        return answer ? { answer } : { error: "OpenRouter Decisions API returned an invalid Choice response." };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function configuredSystemOneChoice(ctx: ExtensionContext, config: WorkflowEvaluationConfig, state: unknown, instructions: string, criteria: Record<string, string>): Promise<{ answer?: Record<string, unknown>; error?: string }> {
    const systemOne = config.systemOne!;
    if (systemOne.provider === "typesafe") return typesafeChoice(ctx, systemOne.model, state, instructions, criteria);
    if (systemOne.model.startsWith("openrouter/typesafe/")) return openRouterChoice(ctx, systemOne.model, state, instructions, criteria);
    return { error: `Configured model ${systemOne.provider}/${systemOne.model} does not support structured System One decisions.` };
}

const llmDecision = async (ctx: ExtensionContext, input: RequirementInput): Promise<RequirementDecision> => {
    if (!ctx.model) return { status: "unavailable", reasoning: "No classifier model is available.", evaluator: "llm" };
    const messages: any[] = [{ role: "system", content: "Decide whether the supplied state requires a persisted Sequential Workflow. Do not infer a requirement merely from a phrase, a Skill name, frontmatter, template mention, or multiple steps. Select workflow_template only when one supplied template ID is appropriate. When uncertain return uncertain. Return only JSON with status (required, not_required, uncertain), non-empty reasoning, activation (definition or template only when required), and templateId only when activation is template." }, { role: "user", content: JSON.stringify(input) }];
    try {
        const response: any = await (ctx.modelRegistry as any).streamSimple(ctx.model, { messages } as any, { signal: ctx.signal }).result();
        const content = typeof response?.content === "string" ? response.content : (response?.content ?? []).map((part: any) => part.text ?? "").join("");
        const parsed: unknown = JSON.parse(content);
        if (!object(parsed) || !["required", "not_required", "uncertain"].includes(text(parsed.status)) || !text(parsed.reasoning).trim()) throw new Error("Invalid classifier response.");
        if (parsed.status !== "required") return { status: parsed.status as "not_required" | "uncertain", reasoning: text(parsed.reasoning), evaluator: "llm" };
        const activation = parsed.activation === "template" ? "template" : "definition", templateId = text(parsed.templateId).trim() || undefined;
        if (activation === "template" && (!templateId || !input.templates.some(template => template.id === templateId))) return { status: "invalid_response", reasoning: "Template activation selected an unavailable template.", evaluator: "llm" };
        return { status: "required", reasoning: text(parsed.reasoning), activation, templateId, evaluator: "llm" };
    } catch (error) { const reasoning = error instanceof Error ? error.message : String(error); return { status: reasoning === "Invalid classifier response." ? "invalid_response" : "error", reasoning, evaluator: "llm" }; }
};

const systemOneRequirement = async (ctx: ExtensionContext, config: WorkflowEvaluationConfig, input: RequirementInput): Promise<RequirementDecision> => {
    const model = config.systemOne!.model, options: Record<string, string> = { no_workflow: "A persisted Sequential Workflow is not needed.", workflow_definition: "A persisted Sequential Workflow is needed and should be defined from the supplied state.", uncertain: "The state does not provide enough evidence for a safe decision." };
    for (const template of input.templates) options[`template:${template.id}`] = `A persisted Sequential Workflow is needed and should use '${template.id}': ${template.title}. ${template.source}`;
    const response = await configuredSystemOneChoice(ctx, config, input, "Which workflow route is appropriate? Do not treat wording, names, frontmatter, or a template mention as conclusive by themselves.", options);
    if (!response.answer) return { status: response.error === "TypeSafe API credentials are unavailable." ? "unavailable" : "error", reasoning: response.error!, evaluator: "system_one", model };
    const choice = text(response.answer.choice), common = metadata(response.answer, "system_one", model);
    if (typeof common.confidence !== "number") return { status: "invalid_response", reasoning: "TypeSafe API returned a Choice without confidence.", ...common };
    if (choice === "workflow_definition") return { status: "required", reasoning: "TypeSafe System One selected workflow definition.", activation: "definition", ...common };
    if (choice.startsWith("template:") && input.templates.some(template => `template:${template.id}` === choice)) return { status: "required", reasoning: "TypeSafe System One selected a workflow template.", activation: "template", templateId: choice.slice(9), ...common };
    if (choice === "no_workflow") return { status: "not_required", reasoning: "TypeSafe System One selected no workflow.", ...common };
    if (choice === "uncertain" || common.confidence < 0.85) return { status: "uncertain", reasoning: "TypeSafe System One could not make a sufficiently confident workflow decision.", ...common };
    return { status: "invalid_response", reasoning: "TypeSafe API returned an unsupported workflow route.", ...common };
};

export async function evaluateWorkflowRequirement(ctx: ExtensionContext, input: RequirementInput): Promise<RequirementDecision> { try { const config = await workflowEvaluationConfig(); return config.modelType === "system_one" ? systemOneRequirement(ctx, config, input) : llmDecision(ctx, input); } catch (error) { return { status: "error", reasoning: error instanceof Error ? error.message : String(error), evaluator: "llm" }; } }

export async function evaluateWorkflowTask(ctx: ExtensionContext, input: TaskInput): Promise<TaskDecision | undefined> {
    let config: WorkflowEvaluationConfig;
    try { config = await workflowEvaluationConfig(); } catch (error) { return { outcome: "error", reasoning: error instanceof Error ? error.message : String(error), evaluator: "llm" }; }
    if (config.modelType === "llm") return undefined;
    const model = config.systemOne!.model;
    const response = await configuredSystemOneChoice(ctx, config, input, "Does the recorded result meet the task criterion? Select fail only when the task cannot safely progress; select retry when another attempt may succeed.", { accept: "The result fully meets the criterion.", retry: "The result does not meet the criterion but another attempt may succeed.", fail: "The result cannot safely satisfy the criterion and the workflow must fail.", uncertain: "The evidence is insufficient for a safe transition." });
    if (!response.answer) return { outcome: response.error === "TypeSafe API credentials are unavailable." ? "unavailable" : "error", reasoning: response.error!, evaluator: "system_one", model };
    const choice = text(response.answer.choice), common = metadata(response.answer, "system_one", model);
    if (typeof common.confidence !== "number") return { outcome: "invalid_response", reasoning: "TypeSafe API returned a Choice without confidence.", ...common };
    if (["accept", "retry", "fail"].includes(choice) && common.confidence >= 0.85) return { outcome: choice as "accept" | "retry" | "fail", reasoning: `TypeSafe System One selected ${choice}.`, ...common };
    return { outcome: "uncertain", reasoning: "TypeSafe System One could not make a sufficiently confident task decision.", ...common };
}
