/**
 * MCP server definition — the heart of the showcase.
 *
 * This file wires the domain layer (BookmarkStore) to the three MCP
 * primitives, each with a distinct purpose:
 *
 *  - **Tools**     → model-controlled actions ("the LLM can DO this")
 *  - **Resources** → application-controlled data ("the client can READ this")
 *  - **Prompts**   → user-controlled templates ("the user can INVOKE this")
 *
 * Transport is deliberately absent here: the same `createServer()` is served
 * over stdio (index.ts), Streamable HTTP (http.ts), and in-memory (tests).
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logger } from "./logger.js";
import {
  BookmarkSchema,
  addBookmarkInput,
  deleteBookmarkInput,
  markReadInput,
  searchBookmarksInput,
} from "./schemas.js";
import { BookmarkNotFoundError, BookmarkStore, DuplicateUrlError } from "./store.js";

export const SERVER_INFO = {
  name: "bookmark-mcp",
  version: "1.0.0",
  title: "Bookmark Manager",
} as const;

/** Uniform shape for expected business errors (not protocol errors). */
function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export function createServer(store: BookmarkStore): McpServer {
  const server = new McpServer(SERVER_INFO, {
    // Declared capabilities are negotiated with the client during `initialize`.
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    },
    instructions:
      "Manages the user's reading-list bookmarks. Use add_bookmark to save URLs, " +
      "search_bookmarks to find them, mark_read after the user has read one, and " +
      "delete_bookmark to remove one. The bookmarks://all resource exposes the " +
      "full list, bookmarks://stats the tag statistics.",
  });

  // -------------------------------------------------------------------------
  // TOOLS — each one demonstrates a different annotation/result pattern.
  // -------------------------------------------------------------------------

  server.registerTool(
    "add_bookmark",
    {
      title: "Add bookmark",
      description:
        "Save a URL to the user's reading list. Rejects duplicate URLs. " +
        "Returns the created bookmark including its generated id.",
      inputSchema: addBookmarkInput,
      // outputSchema gives clients machine-readable results via structuredContent.
      outputSchema: { bookmark: BookmarkSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ url, title, tags, notes }) => {
      try {
        const bookmark = await store.add({
          url,
          tags,
          ...(title !== undefined ? { title } : {}),
          ...(notes !== undefined ? { notes } : {}),
        });
        logger.info("bookmark added", { id: bookmark.id, url: bookmark.url });
        return {
          content: [
            {
              type: "text",
              text: `Saved "${bookmark.title}" (id: ${bookmark.id})`,
            },
          ],
          structuredContent: { bookmark },
        };
      } catch (error) {
        // Expected business errors are reported in-band (isError) so the LLM
        // can read them and react; only unexpected bugs become protocol errors.
        if (error instanceof DuplicateUrlError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "search_bookmarks",
    {
      title: "Search bookmarks",
      description:
        "Search the reading list by free text, tag, and/or read status. " +
        "Call without arguments to list the most recent bookmarks.",
      inputSchema: searchBookmarksInput,
      outputSchema: {
        total: z.number().int().describe("Number of bookmarks returned"),
        bookmarks: z.array(BookmarkSchema),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, tag, unreadOnly, limit }) => {
      const bookmarks = store.search({
        ...(query !== undefined ? { query } : {}),
        ...(tag !== undefined ? { tag } : {}),
        unreadOnly,
        limit,
      });
      const summary =
        bookmarks.length === 0
          ? "No bookmarks matched."
          : bookmarks
              .map((b) => `- [${b.read ? "read" : "unread"}] ${b.title} (${b.url}) id=${b.id}`)
              .join("\n");
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { total: bookmarks.length, bookmarks },
      };
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark bookmark as read",
      description: "Mark a bookmark as read. Safe to call repeatedly.",
      inputSchema: markReadInput,
      outputSchema: { bookmark: BookmarkSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const bookmark = await store.markRead(id);
        return {
          content: [{ type: "text", text: `Marked "${bookmark.title}" as read.` }],
          structuredContent: { bookmark },
        };
      } catch (error) {
        if (error instanceof BookmarkNotFoundError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "delete_bookmark",
    {
      title: "Delete bookmark",
      description: "Permanently delete a bookmark from the reading list.",
      inputSchema: deleteBookmarkInput,
      outputSchema: { deleted: BookmarkSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true, // clients may ask the user for confirmation
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const deleted = await store.delete(id);
        logger.info("bookmark deleted", { id });
        return {
          content: [{ type: "text", text: `Deleted "${deleted.title}".` }],
          structuredContent: { deleted },
        };
      } catch (error) {
        if (error instanceof BookmarkNotFoundError) return toolError(error.message);
        throw error;
      }
    },
  );

  // -------------------------------------------------------------------------
  // RESOURCES — read-only context a client can attach to a conversation.
  // -------------------------------------------------------------------------

  server.registerResource(
    "all-bookmarks",
    "bookmarks://all",
    {
      title: "All bookmarks",
      description: "The complete reading list as JSON, newest first.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(store.all(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "bookmark-stats",
    "bookmarks://stats",
    {
      title: "Bookmark statistics",
      description: "Totals and per-tag counts for the reading list.",
      mimeType: "application/json",
    },
    async (uri) => {
      const all = store.all();
      const stats = {
        total: all.length,
        unread: all.filter((b) => !b.read).length,
        tags: store.tagStats(),
      };
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(stats, null, 2) },
        ],
      };
    },
  );

  // A resource *template*: clients can list concrete bookmark URIs and read
  // any single bookmark by id.
  server.registerResource(
    "bookmark",
    new ResourceTemplate("bookmarks://bookmark/{id}", {
      list: async () => ({
        resources: store.all().map((b) => ({
          uri: `bookmarks://bookmark/${b.id}`,
          name: b.title,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Single bookmark",
      description: "One bookmark by id, as JSON.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const bookmark = store.get(String(id));
      if (!bookmark) {
        throw new Error(`No bookmark with id '${String(id)}'`);
      }
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(bookmark, null, 2) },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // PROMPTS — reusable, user-invokable message templates (slash-command-like).
  // -------------------------------------------------------------------------

  server.registerPrompt(
    "reading_digest",
    {
      title: "Reading digest",
      description:
        "Build a prioritized digest of unread bookmarks, optionally scoped to one tag.",
      argsSchema: {
        tag: z.string().optional().describe("Limit the digest to this tag"),
      },
    },
    ({ tag }) => {
      const unread = store.search({
        unreadOnly: true,
        limit: 50,
        ...(tag !== undefined ? { tag } : {}),
      });
      const list =
        unread.length === 0
          ? "(no unread bookmarks)"
          : unread.map((b) => `- ${b.title} — ${b.url}${b.notes ? ` (notes: ${b.notes})` : ""}`).join("\n");
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Here are my unread bookmarks${tag ? ` tagged '${tag}'` : ""}:\n\n${list}\n\n` +
                "Group them by theme, suggest a reading order, and flag anything " +
                "that looks outdated or redundant. Keep it short.",
            },
          },
        ],
      };
    },
  );

  return server;
}
