/**
 * Local development entry point: plain Node http server serving the MCP Streamable HTTP
 * transport at /mcp, for use with a locally-configured MCP client (see README.md and
 * .vscode/mcp.json's "els-mcp-test" entry, which points at this port).
 *
 * Stateless mode (sessionIdGenerator: undefined) on purpose, matching api/mcp.ts — see
 * mcp-server.ts's factory-not-singleton note. A fresh server + transport per request means local
 * dev behaves the same way Vercel's serverless functions do, rather than diverging from it.
 */

import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./mcp-server.js";

const PORT = Number(process.env.PORT ?? 8001);

const httpServer = createHttpServer((req, res) => {
  if (req.url !== "/mcp") {
    res
      .writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "Not found" }));
    return;
  }
  if (req.method !== "POST") {
    // Stateless mode has no session to resume via GET (SSE) or end via DELETE.
    res
      .writeHead(405, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  void (async () => {
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
  })();
});

httpServer.listen(PORT, () => {
  console.log(`ELS MCP server (dev) listening at http://localhost:${PORT}/mcp`);
});
