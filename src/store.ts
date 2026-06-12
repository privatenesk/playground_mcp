/**
 * BookmarkStore — the persistence layer.
 *
 * Deliberately boring: an in-memory Map backed by a JSON file. The patterns
 * are what matter for production:
 *
 *  - **Atomic writes**: write to a temp file, then rename(2). A crash mid-write
 *    never leaves a half-written data file behind.
 *  - **Validated reads**: the file is parsed through a Zod schema on load, so
 *    corrupt or foreign data fails loudly at startup instead of mysteriously
 *    at request time.
 *  - **Serialized writes**: mutations queue behind a single promise chain, so
 *    concurrent tool calls can't interleave file writes.
 *
 * Swapping this for SQLite/Postgres later only touches this file — the MCP
 * layer (server.ts) depends on the class, not the storage mechanism.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { logger } from "./logger.js";
import { StoreFileSchema, type Bookmark } from "./schemas.js";

export class BookmarkNotFoundError extends Error {
  constructor(id: string) {
    super(`No bookmark with id '${id}'`);
    this.name = "BookmarkNotFoundError";
  }
}

export class DuplicateUrlError extends Error {
  constructor(url: string, public readonly existingId: string) {
    super(`URL already bookmarked (id '${existingId}'): ${url}`);
    this.name = "DuplicateUrlError";
  }
}

export interface SearchFilters {
  query?: string;
  tag?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export class BookmarkStore {
  private bookmarks = new Map<string, Bookmark>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  /** Load (or initialize) the store from `filePath`. */
  static async open(filePath: string): Promise<BookmarkStore> {
    const store = new BookmarkStore(filePath);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = StoreFileSchema.parse(JSON.parse(raw));
      for (const bookmark of parsed.bookmarks) {
        store.bookmarks.set(bookmark.id, bookmark);
      }
      logger.info("store loaded", { filePath, count: store.bookmarks.size });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.info("no data file yet, starting empty", { filePath });
      } else {
        // Corrupt data is a hard error — refuse to start and silently lose data.
        throw new Error(`Failed to load bookmark store at ${filePath}: ${String(error)}`);
      }
    }
    return store;
  }

  add(input: { url: string; title?: string; tags: string[]; notes?: string }): Promise<Bookmark> {
    for (const existing of this.bookmarks.values()) {
      if (existing.url === input.url) {
        return Promise.reject(new DuplicateUrlError(input.url, existing.id));
      }
    }
    const bookmark: Bookmark = {
      id: randomBytes(4).toString("hex"),
      url: input.url,
      title: input.title ?? new URL(input.url).hostname,
      tags: [...new Set(input.tags.map((t) => t.toLowerCase()))],
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      read: false,
      createdAt: new Date().toISOString(),
    };
    this.bookmarks.set(bookmark.id, bookmark);
    return this.persist().then(() => bookmark);
  }

  get(id: string): Bookmark | undefined {
    return this.bookmarks.get(id);
  }

  search(filters: SearchFilters = {}): Bookmark[] {
    const query = filters.query?.toLowerCase();
    const tag = filters.tag?.toLowerCase();
    const results = [...this.bookmarks.values()]
      .filter((b) => {
        if (tag && !b.tags.includes(tag)) return false;
        if (filters.unreadOnly && b.read) return false;
        if (query) {
          const haystack = `${b.title} ${b.url} ${b.notes ?? ""}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results.slice(0, filters.limit ?? 20);
  }

  all(): Bookmark[] {
    return [...this.bookmarks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Tag -> bookmark count, sorted by count descending. */
  tagStats(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();
    for (const bookmark of this.bookmarks.values()) {
      for (const tag of bookmark.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  async markRead(id: string): Promise<Bookmark> {
    const bookmark = this.bookmarks.get(id);
    if (!bookmark) throw new BookmarkNotFoundError(id);
    const updated = { ...bookmark, read: true };
    this.bookmarks.set(id, updated);
    await this.persist();
    return updated;
  }

  async delete(id: string): Promise<Bookmark> {
    const bookmark = this.bookmarks.get(id);
    if (!bookmark) throw new BookmarkNotFoundError(id);
    this.bookmarks.delete(id);
    await this.persist();
    return bookmark;
  }

  get size(): number {
    return this.bookmarks.size;
  }

  /** Serialize writes: each persist waits for the previous one. */
  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.writeToDisk());
    return this.writeQueue;
  }

  private async writeToDisk(): Promise<void> {
    const payload = JSON.stringify(
      { version: 1 as const, bookmarks: this.all() },
      null,
      2,
    );
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, payload, "utf8");
    await rename(tmpPath, this.filePath); // atomic on POSIX filesystems
  }
}
