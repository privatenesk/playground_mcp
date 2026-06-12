/**
 * Minimal structured logger.
 *
 * CRITICAL MCP RULE: on the stdio transport, stdout belongs exclusively to
 * the JSON-RPC protocol. A single stray `console.log` corrupts the stream and
 * disconnects the client. All diagnostics therefore go to **stderr**.
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...context,
  });
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
