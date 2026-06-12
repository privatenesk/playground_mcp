/**
 * Configuration via environment variables — the standard way to configure an
 * MCP server, since clients (Claude Desktop, Claude Code, …) pass env vars in
 * their server config block.
 */
import path from "node:path";

export const config = {
  /** Where bookmarks are persisted. */
  dataFile: process.env.BOOKMARKS_FILE ?? path.join(process.cwd(), "data", "bookmarks.json"),
  /** Port for the Streamable HTTP transport. */
  httpPort: Number(process.env.PORT ?? 3000),
  /** Bind address — localhost by default; only expose deliberately. */
  httpHost: process.env.HOST ?? "127.0.0.1",
} as const;
