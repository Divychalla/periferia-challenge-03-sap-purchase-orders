export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};
export type OpenAiTool = { type: "function"; function: { name: string; description: string; parameters: unknown } };
export type LlmReply = { message: ChatMessage; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  send(messages: ChatMessage[], tools: OpenAiTool[]): Promise<LlmReply>;
}
