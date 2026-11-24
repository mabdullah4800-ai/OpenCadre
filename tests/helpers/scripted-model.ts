// An OpenAI-compatible chat endpoint that plays a fixed script, for LIVE harness tests: a vendor's real CLI, pointed at
// it through the CLI's own "bring your own model" setting, runs its real hooks and MCP servers with no account.
//
// The script is a list of steps, one per assistant turn (counted from the request's messages):
//   { tool: RegExp, args: object }   call the first offered tool whose name matches
//   "done"                           answer with text and stop
// A request whose last message carries OpenCadre's mail notice is answered "done", so a Stop-hook continuation ends.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** `name` is called when no offered tool matches `tool`: a harness that defers tools (Droid's MCP tools) lets the model
 * call one by its exact name before it is offered. */
export type Step = { tool: RegExp; args: object; name?: string } | "done";
export type Seen = { tools: string[]; body: string };

export async function scriptedModel(steps: Step[]): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }));
      }
      let body: { tools?: Array<{ function?: { name?: string }; name?: string }>; messages?: Array<{ role: string }>; stream?: boolean; model?: string } = {};
      try { body = JSON.parse(raw); } catch { /* empty */ }
      const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name ?? "");
      const messages = body.messages ?? [];
      seen.push({ tools, body: raw });
      const turn = messages.filter((m) => m.role === "assistant").length;
      const step = tools.length && !/unread OpenCadre message/.test(JSON.stringify(messages.at(-1) ?? {})) ? steps[turn] ?? "done" : "done";
      const call = step !== "done" ? { name: tools.find((n) => step.tool.test(n)) ?? step.name ?? `missing:${step.tool}`, arguments: JSON.stringify(step.args) } : null;
      const id = `c${seen.length}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body.model ?? "test-model";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (d: object) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, ...d })}\n\n`);
        if (call) {
          ev({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${seen.length}`, type: "function", function: call }] }, finish_reason: null }] });
          ev({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        } else {
          ev({ choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] });
          ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        }
        ev({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        return res.end("data: [DONE]\n\n");
      }
      const message = call ? { role: "assistant", content: null, tool_calls: [{ id: `call_${seen.length}`, type: "function", function: call }] } : { role: "assistant", content: "Done." };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The same script, spoken as the Gemini API (`GOOGLE_GEMINI_BASE_URL`): `:generateContent` and
 * `:streamGenerateContent?alt=sse`, tools in `tools[].functionDeclarations`, a turn per `model` content. */
export async function scriptedGemini(steps: Step[]): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (String(req.url).includes(":countTokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ totalTokens: 1 }));
      }
      let body: { contents?: Array<{ role?: string; parts?: unknown[] }>; tools?: Array<{ functionDeclarations?: Array<{ name: string }> }> } = {};
      try { body = JSON.parse(raw); } catch { /* empty */ }
      const tools = (body.tools ?? []).flatMap((t) => t.functionDeclarations ?? []).map((f) => f.name);
      const contents = body.contents ?? [];
      seen.push({ tools, body: raw });
      // A turn is a model content that SAYS something (a call or text): agy also sends its function responses under the
      // `model` role, which Gemini CLI sends under `user`.
      const turn = contents.filter((c) => c.role === "model" && (c.parts ?? []).some((p) => typeof p === "object" && p !== null && ("functionCall" in p || "text" in p))).length;
      const step = tools.length && !/unread OpenCadre message/.test(JSON.stringify(contents.at(-1) ?? {})) ? steps[turn] ?? "done" : "done";
      const part = step !== "done" ? { functionCall: { name: tools.find((n) => step.tool.test(n)) ?? `missing:${step.tool}`, args: step.args } } : { text: "Done." };
      const out = { candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
      if (String(req.url).includes("alt=sse")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`data: ${JSON.stringify(out)}\n\n`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
