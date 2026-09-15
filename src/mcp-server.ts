/**
 * Builds one MCP server instance with every tool registered.
 *
 * This is a FACTORY, not a shared singleton: the Streamable HTTP transport is used in
 * stateless mode (see dev-server.ts / api/mcp.ts), and each request gets its own server +
 * transport pair. A module-level singleton would only be correct for a long-lived, single
 * in-memory session — wrong on Vercel, where each invocation can land on a different instance
 * (see CLAUDE.md's "Caching" note, which applies to the same constraint).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGeographyTools } from "./tools/geography.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerDataTools } from "./tools/data.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "explore-local-statistics",
    version: "0.1.0",
  });

  registerGeographyTools(server);
  registerMetadataTools(server);
  registerDataTools(server);

  return server;
}
