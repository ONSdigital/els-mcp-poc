import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Wrap a tool's return value as MCP tool-call text content (JSON-serialised). Every tool in
 * this server returns structured data this way, matching the Python version's behaviour of
 * letting FastMCP serialise whatever a tool function returned. */
export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Wrap a tool-level error as an MCP error result (isError: true) rather than throwing, so the
 * calling model sees a normal tool response it can react to instead of a transport-level
 * failure. Use for expected "bad input" cases (e.g. an unknown relation type) — let genuine ELS
 * API failures (ElsApiError) propagate and surface as a transport error instead. */
export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
