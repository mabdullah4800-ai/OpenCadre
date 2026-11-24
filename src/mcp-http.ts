import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** Bound bytes before JSON parsing; the SDK separately bounds tool-input elements. */
export function readMcpBody(req: IncomingMessage, res: ServerResponse, handle: (body: unknown) => Promise<void>): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    if (res.writableEnded) return;
    size += chunk.length;
    if (size > MAX_MCP_BODY_BYTES) {
      chunks.length = 0;
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "request body too large" }));
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    let body: unknown;
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    void handle(body).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "could not process MCP request" }));
      } else if (!res.writableEnded) res.end();
    });
  });
}
