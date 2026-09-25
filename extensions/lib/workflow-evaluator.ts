import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type WorkflowEvaluationConfig = { modelType: "llm" | "system_one"; systemOne?: { provider: string; model: string; endpoint?: { baseUrl: string; path: string }; onUncertain?: "block" } };
const defaultOpenRouterEndpoint = { baseUrl: "https://openrouter.ai/api/", path: "alpha/decisions" };
export type RequirementDecision = { status: "required" | "not_required" | "uncertain" | "unavailable" | "invalid_response" | "error"; reasoning: string; activation?: "definition" | "template"; templateId?: string; evaluator: "llm" | "system_one"; model?: string; confidence?: number; probabilities?: Record<string, number> };
export type TaskDecision = { outcome: "accept" | "retry" | "fail" | "uncertain" | "unavailable" | "invalid_response" | "error"; reasoning: string; evaluator: "llm" | "system_one"; model?: string; confidence?: number; probabilities?: Record<string, number> };
type WorkflowTemplate = { id: string; title: string; source: string };
type ConversationMessage = { role: "user" | "assistant"; content: string };
type UserInputRequirement = { origin: "user_input"; userLastMessage: string; conversationHistory: ConversationMessage[]; templates: WorkflowTemplate[] };
type SkillRequirement = { origin: "skill"; evidence: string; userRequest: string; recentUserMessages: string[]; templates: WorkflowTemplate[] };
export type RequirementInput = UserInputRequirement | SkillRequirement;
export type TaskInput = { workflow: { title: string; source: string }; task: { type: "action" | "collect" | "workflow"; instruction: string; criteria: string }; result: string };
const minimumAutomaticTaskConfidence = 0.85;

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
    const endpoint = object(systemOne?.endpoint) ? systemOne.endpoint : defaultOpenRouterEndpoint;
    const baseUrl = text(endpoint.baseUrl).trim() || defaultOpenRouterEndpoint.baseUrl, path = text(endpoint.path).trim() || defaultOpenRouterEndpoint.path;
    try { const url = new URL(baseUrl); if (!/^https?:$/.test(url.protocol) || /^(?:https?:)?\/\//i.test(path)) throw new Error(); }
    catch { throw new Error("Invalid System One endpoint configuration."); }
    if (evaluation.modelType !== "system_one" || !systemOne || !text(systemOne.provider).trim() || !text(systemOne.model).trim() || (systemOne.onUncertain !== undefined && systemOne.onUncertain !== "block")) throw new Error("Invalid sequentialWorkflow.evaluation configuration.");
    return { modelType: "system_one", systemOne: { provider: text(systemOne.provider).trim(), model: text(systemOne.model).trim(), endpoint: { baseUrl, path: path.replace(/^\/+/, "") }, onUncertain: "block" } };
}

const endpointUrl = (endpoint: { baseUrl: string; path: string }) => new URL(endpoint.path.replace(/^\/+/, ""), endpoint.baseUrl.endsWith("/") ? endpoint.baseUrl : `${endpoint.baseUrl}/`).toString();

async function openRouterApiKey(): Promise<string | undefined> {
    const environmentKey = process.env.OPENROUTER_API_KEY?.trim();
    if (environmentKey) return environmentKey;
    try {
        const auth: unknown = JSON.parse(await readFile(join(root(), "auth.json"), "utf8"));
        const key = object(auth) && object(auth.openrouter) ? text(auth.openrouter.key).trim() : "";
        return key || undefined;
    } catch { return undefined; }
}

async function decisionEndpointChoice(ctx: ExtensionContext, model: string, endpoint: { baseUrl: string; path: string }, state: unknown, instructions: string, criteria: Record<string, string>): Promise<{ answer?: Record<string, unknown>; error?: string }> {
    const apiKey = await openRouterApiKey();
    if (!apiKey) return { error: "OpenRouter API credentials are unavailable." };
    try {
        const response = await fetch(endpointUrl(endpoint), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: model.replace(/^openrouter\//, ""), state, questions: { decision: { type: "choice", instructions, criteria } } }), signal: ctx.signal });
        if (!response.ok) return { error: `Configured Decisions API returned HTTP ${response.status}.` };
        const body: unknown = await response.json();
        const answer = object(body) && object(body.answers) && object(body.answers.decision) ? body.answers.decision : undefined;
        return answer ? { answer } : { error: "Configured Decisions API returned an invalid Choice response." };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

async function configuredSystemOneChoice(ctx: ExtensionContext, config: WorkflowEvaluationConfig, state: unknown, instructions: string, criteria: Record<string, string>): Promise<{ answer?: Record<string, unknown>; error?: string }> {
    const systemOne = config.systemOne!;
    return decisionEndpointChoice(ctx, systemOne.model, systemOne.endpoint ?? defaultOpenRouterEndpoint, state, instructions, criteria);
}

const workflowRequirementPolicy = `Decide whether the supplied state requests an actual, new persisted Sequential Workflow execution. The keyword “Sequential Workflow” (including spelling variants) is only a trigger to evaluate; it is never evidence by itself that a workflow is required. For user_input origin, userLastMessage is the primary and decisive evidence: evaluate its current operative intent first. conversationHistory is background context only; it may explain references but must never cause a workflow to be created merely because an earlier message mentioned, requested, created, or completed one. Select a workflow route only when the current user message asks the agent to actually use, create, run, continue, inspect, or cancel a Sequential Workflow to perform current work. Select no_workflow when the current user message is a question, hypothetical, conditional, explanation request, discussion, correction, implementation request, test, configuration request, documentation request, plan, analysis, report, or meta-level question about Sequential Workflow, its Skills, templates, Harness, or System One. A quoted, illustrative, or referenced workflow command is not a command to execute. For example, “Se eu disser ‘Faça X usando Sequential Workflow’, você criaria um?” requires no_workflow. Do not confuse a request to modify or discuss the feature with a request to execute the feature. For Skill origin, decide from both the active user request and the complete supplied Skill: a keyword in documentation, an example, a comment, frontmatter, a Skill name, or a template mention alone is not enough. Select a template route only when the supplied Skill explicitly requires creating the workflow from a named JSON template. Return uncertain only when the current evidence is genuinely ambiguous.`;

const llmDecision = async (ctx: ExtensionContext, input: RequirementInput): Promise<RequirementDecision> => {
    if (!ctx.model) return { status: "unavailable", reasoning: "No classifier model is available.", evaluator: "llm" };
    const messages: any[] = [{ role: "system", content: `${workflowRequirementPolicy} Return only JSON with status (required, not_required, uncertain), non-empty reasoning, activation (definition or template only when required), and templateId only when activation is template. Select template only when one supplied template ID is appropriate, except a Skill may explicitly name a colocated JSON template without a catalog ID.` }, { role: "user", content: JSON.stringify(input) }];
    try {
        const response: any = await (ctx.modelRegistry as any).streamSimple(ctx.model, { messages } as any, { signal: ctx.signal }).result();
        const content = typeof response?.content === "string" ? response.content : (response?.content ?? []).map((part: any) => part.text ?? "").join("");
        const parsed: unknown = JSON.parse(content);
        if (!object(parsed) || !["required", "not_required", "uncertain"].includes(text(parsed.status)) || !text(parsed.reasoning).trim()) throw new Error("Invalid classifier response.");
        if (parsed.status !== "required") return { status: parsed.status as "not_required" | "uncertain", reasoning: text(parsed.reasoning), evaluator: "llm" };
        const activation = parsed.activation === "template" ? "template" : "definition", templateId = text(parsed.templateId).trim() || undefined;
        if (activation === "template" && input.origin !== "skill" && (!templateId || !input.templates.some(template => template.id === templateId))) return { status: "invalid_response", reasoning: "Template activation selected an unavailable template.", evaluator: "llm" };
        return { status: "required", reasoning: text(parsed.reasoning), activation, templateId, evaluator: "llm" };
    } catch (error) { const reasoning = error instanceof Error ? error.message : String(error); return { status: reasoning === "Invalid classifier response." ? "invalid_response" : "error", reasoning, evaluator: "llm" }; }
};

const systemOneRequirement = async (ctx: ExtensionContext, config: WorkflowEvaluationConfig, input: RequirementInput): Promise<RequirementDecision> => {
    const model = config.systemOne!.model, options: Record<string, string> = { no_workflow: "A persisted Sequential Workflow is not needed.", workflow_definition: "A persisted Sequential Workflow is needed and should be defined from the supplied state.", workflow_from_template: "A persisted Sequential Workflow is needed and the supplied Skill explicitly requires creating it from a named JSON template.", uncertain: "The state does not provide enough evidence for a safe decision." };
    const response = await configuredSystemOneChoice(ctx, config, input, `${workflowRequirementPolicy} Choose exactly one route: no_workflow, workflow_definition, workflow_from_template, or uncertain.`, options);
    if (!response.answer) return { status: response.error?.endsWith("API credentials are unavailable.") ? "unavailable" : "error", reasoning: response.error!, evaluator: "system_one", model };
    const choice = text(response.answer.choice), common = metadata(response.answer, "system_one", model);
    if (choice === "workflow_definition") return { status: "required", reasoning: "TypeSafe System One selected workflow definition.", activation: "definition", ...common };
    if (choice === "workflow_from_template") return { status: "required", reasoning: "TypeSafe System One selected workflow creation from the Skill's named template.", activation: "template", ...common };
    if (choice === "no_workflow") return { status: "not_required", reasoning: "TypeSafe System One selected no workflow.", ...common };
    if (choice === "uncertain") return { status: "uncertain", reasoning: "TypeSafe System One selected an uncertain workflow decision.", ...common };
    return { status: "invalid_response", reasoning: "TypeSafe API returned an unsupported workflow route.", ...common };
};

export async function evaluateWorkflowRequirement(ctx: ExtensionContext, input: RequirementInput): Promise<RequirementDecision> { try { const config = await workflowEvaluationConfig(); return config.modelType === "system_one" ? systemOneRequirement(ctx, config, input) : llmDecision(ctx, input); } catch (error) { return { status: "error", reasoning: error instanceof Error ? error.message : String(error), evaluator: "llm" }; } }

export async function evaluateWorkflowTask(ctx: ExtensionContext, input: TaskInput): Promise<TaskDecision | undefined> {
    let config: WorkflowEvaluationConfig;
    try { config = await workflowEvaluationConfig(); } catch (error) { return { outcome: "error", reasoning: error instanceof Error ? error.message : String(error), evaluator: "llm" }; }
    if (config.modelType === "llm") return undefined;
    const model = config.systemOne!.model;
    const response = await configuredSystemOneChoice(ctx, config, input, "Evaluate the recorded result against the complete task contract: workflow source, task instruction, and acceptance criterion. The criterion is a minimum condition, never permission to weaken a more specific requirement in the instruction or workflow source. Accept only when every material requirement is demonstrably satisfied by the result. For a request for a full name, require at least a given name and surname; a single token is incomplete. Select fail only when the task cannot safely progress; select retry when another attempt may succeed; select uncertain when the evidence or confidence is insufficient for a safe transition.", { accept: "The result fully and demonstrably meets every material requirement of the task contract.", retry: "The result is incomplete or does not meet the task contract, but another attempt may succeed.", fail: "The result cannot safely satisfy the task contract and the workflow must fail.", uncertain: "The evidence is insufficient for a safe transition." });
    if (!response.answer) return { outcome: response.error?.endsWith("API credentials are unavailable.") ? "unavailable" : "error", reasoning: response.error!, evaluator: "system_one", model };
    const choice = text(response.answer.choice), common = metadata(response.answer, "system_one", model);
    if (choice === "uncertain" || typeof common.confidence !== "number" || common.confidence < minimumAutomaticTaskConfidence) return { outcome: "uncertain", reasoning: choice === "uncertain" ? "TypeSafe System One selected an uncertain task decision." : `TypeSafe System One confidence (${common.confidence ?? "missing"}) is below the automatic-transition threshold (${minimumAutomaticTaskConfidence}).`, ...common };
    if (["accept", "retry", "fail"].includes(choice)) return { outcome: choice as "accept" | "retry" | "fail", reasoning: `TypeSafe System One selected ${choice}.`, ...common };
    return { outcome: "invalid_response", reasoning: "TypeSafe API returned an unsupported task decision.", ...common };
}
