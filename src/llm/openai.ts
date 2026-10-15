import { z } from "zod";
import type { ChatMessage, LlmAdapter, LlmReply, OpenAiTool, ToolCall } from "./adapter.js";

const ResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      role: z.literal("assistant"),
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).optional(),
    }),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(), total_tokens: z.number().optional() }).optional(),
});

export class OpenAiChatAdapter implements LlmAdapter {
  readonly provider = "OpenAI";
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model = "gpt-5.4-mini") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async send(messages: ChatMessage[], tools: OpenAiTool[]): Promise<LlmReply> {
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools,
          tool_choice: "auto",
          max_completion_tokens: 2500,
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error("The language model timed out. Please try again.");
      throw new Error("The language model could not be reached. Check the server connection and retry.");
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = getApiError(body);
      throw new Error(detail ?? `The language model returned HTTP ${response.status}.`);
    }
    const parsed = ResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error("The language model returned an unreadable response.");
    const message = parsed.data.choices[0]?.message;
    if (!message) throw new Error("The language model returned an empty response.");
    const calls: ToolCall[] = message.tool_calls ?? [];
    return {
      message: { role: "assistant", content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) },
      usage: parsed.data.usage,
    };
  }
}

function getApiError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const error = value.error;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return `Language model error: ${error.message}`;
  return null;
}
