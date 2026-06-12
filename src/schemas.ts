/**
 * Domain model and validation schemas.
 *
 * Zod schemas are the single source of truth: they validate tool input at
 * runtime AND derive the TypeScript types used across the codebase. The MCP
 * SDK also converts them to JSON Schema automatically, so connected clients
 * (and the LLM) see precise parameter descriptions.
 */
import { z } from "zod";

export const BookmarkSchema = z.object({
  id: z.string().describe("Unique bookmark id (8-char hex)"),
  url: z.url().describe("The bookmarked URL"),
  title: z.string().min(1).describe("Human-readable title"),
  tags: z.array(z.string().min(1)).describe("Lowercase tags for filtering"),
  notes: z.string().optional().describe("Free-form notes"),
  read: z.boolean().describe("Whether the bookmark has been read"),
  createdAt: z.iso.datetime().describe("ISO 8601 creation timestamp"),
});

export type Bookmark = z.infer<typeof BookmarkSchema>;

/** Shape of the JSON persistence file — versioned for future migrations. */
export const StoreFileSchema = z.object({
  version: z.literal(1),
  bookmarks: z.array(BookmarkSchema),
});

export type StoreFile = z.infer<typeof StoreFileSchema>;

// ---------------------------------------------------------------------------
// Tool input schemas (raw shapes — the SDK wraps them into z.object()).
// Every field carries a .describe() so the LLM knows exactly what to pass.
// ---------------------------------------------------------------------------

export const addBookmarkInput = {
  url: z.url().describe("URL to bookmark, e.g. https://example.com/article"),
  title: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Title for the bookmark. Defaults to the URL's hostname."),
  tags: z
    .array(z.string().min(1).max(40))
    .max(10)
    .default([])
    .describe("Up to 10 tags, e.g. ['typescript', 'testing']"),
  notes: z.string().max(2000).optional().describe("Optional free-form notes"),
};

export const searchBookmarksInput = {
  query: z
    .string()
    .optional()
    .describe("Case-insensitive text matched against title, URL, and notes. Omit to list all."),
  tag: z.string().optional().describe("Only return bookmarks carrying this tag"),
  unreadOnly: z.boolean().default(false).describe("Only return unread bookmarks"),
  limit: z.number().int().min(1).max(100).default(20).describe("Maximum results to return"),
};

export const markReadInput = {
  id: z.string().min(1).describe("Id of the bookmark to mark as read"),
};

export const deleteBookmarkInput = {
  id: z.string().min(1).describe("Id of the bookmark to delete"),
};
