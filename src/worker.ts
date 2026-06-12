/**
 * Cloudflare Workers entrypoint — the production deployment target.
 *
 * Architecture: the stateless Worker routes every MCP request to a single
 * named Durable Object instance. The DO is the unit of consistency:
 *
 *  - Its storage is strongly consistent and transactional — it replaces the
 *    JSON file used locally (see DurableObjectStorageAdapter below).
 *  - It is single-threaded, so concurrent clients can never interleave
 *    writes, mirroring the in-process write queue semantics of local dev.
 *  - The in-memory BookmarkStore survives between requests while the DO is
 *    warm and is rebuilt from storage transparently after eviction.
 *
 * MCP-wise we run the SDK's *web-standard* Streamable HTTP transport in
 * stateless mode (no Mcp-Session-Id): each POST creates a throwaway
 * server+transport pair. That is the recommended pattern on serverless
 * runtimes, where requests may hit different isolates and sticky sessions
 * don't exist. (Cloudflare's `agents` framework — McpAgent — is the
 * batteries-included alternative; it allocates one DO *per session*, which
 * then needs external shared storage. One shared DO keeps this showcase
 * self-contained.)
 */
import { DurableObject } from "cloudflare:workers";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { StoreFile } from "./schemas.js";
import { createServer } from "./server.js";
import { BookmarkStore, type StorageAdapter } from "./store.js";

interface Env {
  BOOKMARK_STORE: DurableObjectNamespace<BookmarkStoreDO>;
}

const MCP_PATH = "/mcp";
const STORAGE_KEY = "store";

/** StorageAdapter backed by the DO's transactional key-value storage. */
class DurableObjectStorageAdapter implements StorageAdapter {
  constructor(private readonly storage: DurableObjectStorage) {}

  async read(): Promise<unknown | null> {
    return (await this.storage.get<StoreFile>(STORAGE_KEY)) ?? null;
  }

  async write(data: StoreFile): Promise<void> {
    await this.storage.put(STORAGE_KEY, data);
  }
}

export class BookmarkStoreDO extends DurableObject<Env> {
  private store: Promise<BookmarkStore> | undefined;

  /** Lazily load the store once per DO lifetime; reused across requests. */
  private getStore(): Promise<BookmarkStore> {
    this.store ??= BookmarkStore.open(new DurableObjectStorageAdapter(this.ctx.storage));
    return this.store;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const store = await this.getStore();

    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok", bookmarks: store.size });
    }

    // Stateless MCP: fresh server + transport per request, shared store.
    // `enableJsonResponse` returns plain JSON instead of opening an SSE
    // stream — the right fit for stateless request/response on serverless.
    // NOTE: do not close the transport here; the Response body is streamed
    // *after* this method returns, and closing early would truncate it.
    const server = createServer(store);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== MCP_PATH && url.pathname !== "/healthz") {
      return new Response("Not found", { status: 404 });
    }

    // All clients share one bookmark collection → one well-known DO instance.
    // A multi-tenant variant would derive the name from the authenticated
    // user (e.g. idFromName(userId)) for free per-user isolation.
    const id = env.BOOKMARK_STORE.idFromName("default");
    return env.BOOKMARK_STORE.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
