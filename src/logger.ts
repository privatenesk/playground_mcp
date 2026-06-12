/**
 * Minimal structured logger — runtime-agnostic (Node + Cloudflare Workers).
 *
 * CRITICAL MCP RULE: on the stdio transport, stdout belongs exclusively to
 * the JSON-RPC protocol. A single stray `console.log` corrupts the stream and
 * disconnects the client. We therefore log via `console.error`, which writes
 * to **stderr** under Node and to the observability log stream on Workers
 * (`wrangler tail` / dashboard).
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// `process` only exists under Node; on Workers the default level applies.
const envLevel = (globalThis as { process?: { env?: Record<string, string> } }).process?.env
  ?.LOG_LEVEL as Level | undefined;
const threshold = LEVELS[envLevel ?? "info"] ?? LEVELS.info;

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  console.error(
    JSON.stringify({ time: new Date().toISOString(), level, message, ...context }),
  );
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
