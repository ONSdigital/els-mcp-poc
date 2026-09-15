/**
 * Vercel Node.js Serverless Function entry point. Served at /api/mcp; vercel.json rewrites the
 * public /mcp path here. No ASGI-style path-rewrite compat shim needed this time (unlike the
 * old api/index.py) — this handler doesn't care what path Vercel invoked it at, it always
 * treats the request as an MCP call.
 *
 * Stateless transport, one server+transport per invocation — see src/server.ts's factory note.
 * Vercel serverless functions use the same (req, res) signature as Node's http module, so this
 * mirrors src/dev-server.ts almost exactly.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/server.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res
      .writeHead(405, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const mcpServer = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}
