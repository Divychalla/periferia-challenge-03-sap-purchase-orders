import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSession, handleChat, providerInfo } from "./agent/agent.js";

const root = process.cwd();
const port = Number(process.env.PORT || 3000);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, ...providerInfo() });
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
      const session = getSession(id);
      return session ? json(response, 200, session) : json(response, 404, { error: "Session not found." });
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readBody(request);
      const input = parseChatInput(body);
      const result = await handleChat(input.sessionId, input.message, root);
      return json(response, 200, result);
    }
    if (request.method === "GET" && ["/", "/index.html"].includes(url.pathname)) return staticFile(response, "web/index.html", "text/html; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/app.css") return staticFile(response, "web/app.css", "text/css; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/app.js") return staticFile(response, "web/app.js", "text/javascript; charset=utf-8");
    return json(response, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request could not be completed.";
    return json(response, 400, { error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  const info = providerInfo();
  console.log(`Purchase order assistant listening on port ${port} (${info.provider}: ${info.model}).`);
});

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function staticFile(response: ServerResponse, relativePath: string, contentType: string): Promise<void> {
  const content = await readFile(path.join(root, relativePath));
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
  response.end(content);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65536) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function parseChatInput(value: unknown): { sessionId?: string; message: string } {
  if (typeof value !== "object" || value === null || !("message" in value) || typeof value.message !== "string") {
    throw new Error("Expected a JSON body with a message string.");
  }
  const sessionId = "sessionId" in value && typeof value.sessionId === "string" ? value.sessionId : undefined;
  return { sessionId, message: value.message };
}
