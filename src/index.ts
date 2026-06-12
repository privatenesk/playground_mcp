#!/usr/bin/env node
/**
 * stdio entrypoint — the default transport for locally-run MCP servers.
 *
 * The client (Claude Desktop, Claude Code, MCP Inspector, …) spawns this
 * process and exchanges newline-delimited JSON-RPC over stdin/stdout.
 * Remember: stdout is the wire — all logging goes to stderr (see logger.ts).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { SERVER_INFO, createServer } from "./server.js";
import { BookmarkStore } from "./store.js";

async function main(): Promise<void> {
  const store = await BookmarkStore.open(config.dataFile);
  const server = createServer(store);
  const transport = new StdioServerTransport();

  // Graceful shutdown: finish the in-flight write queue, close the transport.
  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  logger.info("server ready on stdio", {
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    dataFile: config.dataFile,
  });
}

main().catch((error) => {
  logger.error("fatal error during startup", { error: String(error) });
  process.exit(1);
});
