import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../llm/adapter.js";
import { OpenAiChatAdapter } from "../llm/openai.js";
import { openAiToolDefinitions, processDeterministically, runTool, type ToolCallResult, type ToolName } from "../tools/po.js";

export type VisibleTurn = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallResult[];
  needsConfirmation?: boolean;
  createdAt: string;
};
type Session = {
  id: string;
  messages: ChatMessage[];
  turns: VisibleTurn[];
  pendingCaseId: string | null;
  estimatedTokens: number;
};
export type ChatResponse = { sessionId: string; reply: string; toolCalls: ToolCallResult[]; needsConfirmation: boolean };

const sessions = new Map<string, Session>();
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const MAX_ITERATIONS = positiveInteger(process.env.MAX_TOOL_ITERATIONS, 10);
const MAX_SESSION_TOKENS = positiveInteger(process.env.MAX_SESSION_TOKENS, 30000);
const MAX_TOTAL_TOKENS = positiveInteger(process.env.MAX_TOTAL_TOKENS, 120000);
let estimatedProcessTokens = 0;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function providerInfo(): { provider: string; model: string } {
  return process.env.OPENAI_API_KEY
    ? { provider: "OpenAI", model: OPENAI_MODEL }
    : { provider: "local-demo", model: "deterministic workflow" };
}

export function getSession(id: string): { sessionId: string; turns: VisibleTurn[]; pendingConfirmation: boolean } | null {
  const session = sessions.get(id);
  return session ? { sessionId: id, turns: session.turns, pendingConfirmation: session.pendingCaseId !== null } : null;
}

export async function handleChat(sessionId: string | undefined, rawMessage: string, directory: string): Promise<ChatResponse> {
  const message = rawMessage.trim();
  if (!message) throw new Error("Enter a message before sending.");
  if (message.length > 6000) throw new Error("Messages must be 6,000 characters or fewer.");

  const id = sessionId && /^[a-zA-Z0-9_-]{8,80}$/.test(sessionId) ? sessionId : crypto.randomUUID();
  const session = sessions.get(id) ?? { id, messages: [], turns: [], pendingCaseId: null, estimatedTokens: 0 };
  const pendingCase = session.pendingCaseId;
  const confirmationGranted = pendingCase !== null && isExplicitConfirmation(message);
  const explicitDecline = pendingCase !== null && isExplicitDecline(message);

  if (pendingCase && (confirmationGranted || explicitDecline)) {
    return finishPending(session, message, directory, confirmationGranted);
  }
  // Any unrelated next message consumes the confirmation opportunity.
  session.pendingCaseId = null;

  const userTurn: VisibleTurn = { role: "user", content: message, createdAt: new Date().toISOString() };
  session.turns.push(userTurn);
  session.messages.push({ role: "user", content: message });
  session.estimatedTokens = estimateTokens(session.messages);
  if (session.estimatedTokens > MAX_SESSION_TOKENS) {
    session.messages.pop();
    session.turns.pop();
    const reply = `This session reached its ${MAX_SESSION_TOKENS.toLocaleString()} token budget. Start a new session to continue.`;
    session.turns.push({ role: "assistant", content: reply, createdAt: new Date().toISOString() });
    sessions.set(id, session);
    return { sessionId: id, reply, toolCalls: [], needsConfirmation: false };
  }

  let response: ChatResponse;
  if (!process.env.OPENAI_API_KEY) {
    const caseId = message.match(/\breq-00[1-6]\b/i)?.[0]?.toLowerCase();
    if (!caseId) {
      response = {
        sessionId: id,
        reply: "Hello. Ask me to process one of the supplied requests, for example “Process req-001”. This chat is running in deterministic local mode; set OPENAI_API_KEY to enable the LLM tool-calling adapter.",
        toolCalls: [],
        needsConfirmation: false,
      };
    } else {
      const local = await processDeterministically(caseId, { directory, sessionId: id });
      session.pendingCaseId = local.pendingCaseId ?? null;
      response = { sessionId: id, reply: local.reply, toolCalls: local.toolCalls, needsConfirmation: local.needsConfirmation };
    }
  } else {
    try {
      response = await handleWithModel(session, directory);
      response.sessionId = id;
    } catch (error) {
      response = { sessionId: id, reply: error instanceof Error ? error.message : "The language model request failed.", toolCalls: [], needsConfirmation: false };
    }
  }

  session.turns.push({ role: "assistant", content: response.reply, toolCalls: response.toolCalls, needsConfirmation: response.needsConfirmation, createdAt: new Date().toISOString() });
  session.estimatedTokens = estimateTokens(session.messages);
  sessions.set(id, session);
  return response;
}

async function finishPending(session: Session, message: string, directory: string, confirmed: boolean): Promise<ChatResponse> {
  const caseId = session.pendingCaseId;
  if (!caseId) throw new Error("There is no pending confirmation.");
  session.pendingCaseId = null;
  session.turns.push({ role: "user", content: message, createdAt: new Date().toISOString() });
  session.messages.push({ role: "user", content: message });
  if (!confirmed) {
    const reply = `Creation for ${caseId} was cancelled. No purchase order was created.`;
    session.messages.push({ role: "assistant", content: reply });
    session.turns.push({ role: "assistant", content: reply, toolCalls: [], needsConfirmation: false, createdAt: new Date().toISOString() });
    session.estimatedTokens = estimateTokens(session.messages);
    sessions.set(session.id, session);
    return { sessionId: session.id, reply, toolCalls: [], needsConfirmation: false };
  }
  const call = await runTool("po_create", { case_id: caseId, payload: {}, confirmed: true }, { directory, sessionId: session.id, confirmationGranted: true });
  const result = call.result as { ok?: boolean; data?: { po_number?: string; idempotent?: boolean }; error?: string };
  const reply = result.ok
    ? `Confirmed. Purchase order ${result.data?.po_number ?? "created"}${result.data?.idempotent ? " (existing idempotent record)" : ""}. The confirmed exceptions and retroactive status are recorded in out/control.csv.`
    : `I could not create the order: ${result.error ?? "The request failed validation."}`;
  const lastMessage = session.messages.at(-1);
  if (lastMessage?.role !== "assistant" || lastMessage.content !== reply) session.messages.push({ role: "assistant", content: reply });
  session.turns.push({ role: "assistant", content: reply, toolCalls: [call], needsConfirmation: false, createdAt: new Date().toISOString() });
  session.estimatedTokens = estimateTokens(session.messages);
  sessions.set(session.id, session);
  return { sessionId: session.id, reply, toolCalls: [call], needsConfirmation: false };
}

async function handleWithModel(session: Session, directory: string): Promise<ChatResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  const adapter = new OpenAiChatAdapter(apiKey, OPENAI_MODEL);
  const [prompt, knowledge] = await Promise.all([
    readFile(path.join(directory, "agent", "prompt.md"), "utf8"),
    readFile(path.join(directory, "src", "knowledge", "purchase-orders.md"), "utf8"),
  ]);
  const system: ChatMessage = { role: "system", content: `${prompt}\n\nPROCESS KNOWLEDGE\n${knowledge}` };
  const toolCalls: ToolCallResult[] = [];
  let pendingCaseId: string | null = null;
  let reply = "I reached the tool-iteration limit before finishing. Ask me to continue or inspect the current session.";
  const tools = openAiToolDefinitions();

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const estimatedRequestTokens = estimateTokens([system, ...session.messages]);
    const reservation = estimatedRequestTokens + 2500;
    if (estimatedProcessTokens + reservation > MAX_TOTAL_TOKENS) {
      throw new Error(`The server reached its ${MAX_TOTAL_TOKENS.toLocaleString()} estimated-token budget. Model calls are paused until the service restarts.`);
    }
    estimatedProcessTokens += reservation;
    const result = await adapter.send([system, ...session.messages], tools);
    const assistant = result.message;
    session.messages.push(assistant);
    const calls = assistant.tool_calls ?? [];
    if (!calls.length) {
      reply = assistant.content?.trim() || "I could not prepare a response from the available tool results.";
      break;
    }

    for (const call of calls) {
      let args: unknown;
      try { args = JSON.parse(call.function.arguments) as unknown; }
      catch { args = null; }
      const name = call.function.name;
      const knownName = isToolName(name) ? name : "po_read_package";
      const invoked = isToolName(name)
        ? await runTool(knownName, args, { directory, sessionId: session.id, confirmationGranted: false })
        : { name: knownName, arguments: args, result: { ok: false, error: `Unknown tool: ${name}` } };
      toolCalls.push(invoked);
      const toolData = invoked.result as { ok?: boolean; data?: unknown; error?: string };
      if (knownName === "po_validate" && toolData.ok && hasConfirmations(toolData.data)) {
        const validation = toolData.data;
        if (validation.eligible && validation.confirmations.length > 0) {
          const input = invoked.arguments as { case_id?: string };
          if (input.case_id) pendingCaseId = input.case_id;
        }
      }
      session.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(invoked.result) });
    }
    session.estimatedTokens = estimateTokens(session.messages);
    if (session.estimatedTokens > MAX_SESSION_TOKENS) {
      reply = `This session reached its ${MAX_SESSION_TOKENS.toLocaleString()} token budget. Start a new session to continue.`;
      break;
    }
  }

  if (pendingCaseId) {
    session.pendingCaseId = pendingCaseId;
    if (!reply.includes("?")) reply = `${reply}\n\nDo you confirm creation of the purchase order for ${pendingCaseId}?`;
  }
  session.messages.push({ role: "assistant", content: reply });
  return { sessionId: session.id, reply, toolCalls, needsConfirmation: pendingCaseId !== null };
}

function isToolName(value: string): value is ToolName {
  return value === "po_read_package" || value === "po_validate" || value === "po_build_payload" || value === "po_generate_evidence" || value === "po_create";
}

function hasConfirmations(value: unknown): value is { eligible: boolean; confirmations: Array<{ code: string; detail: string }> } {
  return typeof value === "object" && value !== null && "eligible" in value && "confirmations" in value && Array.isArray(value.confirmations);
}

function isExplicitConfirmation(message: string): boolean {
  const normalized = message.trim().toLocaleLowerCase().replace(/[.!\s]+$/g, "");
  return /^(yes|yes i confirm|i confirm|confirmed|confirm|approved|i approve|proceed|go ahead|sí|si|confirmo|autorizo|adelante|de acuerdo)$/.test(normalized);
}

function isExplicitDecline(message: string): boolean {
  const normalized = message.trim().toLocaleLowerCase().replace(/[.!\s]+$/g, "");
  return /^(no|no i don't confirm|i do not confirm|cancel|cancel it|stop|reject|no confirmo|cancela|cancelar)$/.test(normalized);
}

function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}
