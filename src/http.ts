#!/usr/bin/env node
/**
 * Streamable HTTP entrypoint — the standard transport for *remote* MCP servers.
 *
 * Implements the stateful session pattern from the MCP spec:
 *
 *  1. Client POSTs `initialize` (no session header) → we create a transport +
 *     server instance and return an `Mcp-Session-Id` header.
 *  2. Every subsequent POST/GET/DELETE carries that header and is routed to
 *     the matching transport. GET opens an SSE stream for server→client
 *     notifications; DELETE terminates the session.
 *
 * Production notes baked in below: Origin validation (DNS-rebinding defense),
 * localhost binding by default, per-session cleanup, graceful shutdown.
 * Authentication (OAuth 2.1 per the MCP auth spec) is intentionally out of
 * scope for this showcase — see README "Production checklist".
 */
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { createServer } from "./server.js";
import { BookmarkStore } from "./store.js";

const MCP_PATH = "/mcp";

/** Browsers always send Origin; non-browser MCP clients usually don't. */
function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const store = await BookmarkStore.open(config.dataFile);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessions: transports.size, bookmarks: store.size }));
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }

    if (!isOriginAllowed(req)) {
      logger.warn("rejected request with disallowed origin", { origin: req.headers.origin });
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: origin not allowed" }));
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Existing session → route to its transport.
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown or expired session" }));
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      // No session header → must be a new `initialize` POST.
      if (req.method !== "POST") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Mcp-Session-Id header required" }));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          logger.info("session started", { sessionId: id, active: transports.size });
        },
        onsessionclosed: (id) => {
          transports.delete(id);
          logger.info("session closed", { sessionId: id, active: transports.size });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      // One McpServer per session; they all share the same store.
      const server = createServer(store);
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error("request handling failed", { error: String(error) });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  httpServer.listen(config.httpPort, config.httpHost, () => {
    logger.info("server ready on streamable http", {
      url: `http://${config.httpHost}:${config.httpPort}${MCP_PATH}`,
      dataFile: config.dataFile,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal, activeSessions: transports.size });
    for (const transport of transports.values()) {
      await transport.close().catch(() => {});
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("fatal error during startup", { error: String(error) });
  process.exit(1);
});
