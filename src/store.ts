/**
 * BookmarkStore — the persistence layer.
 *
 * Runtime-agnostic by design: this file uses only Web-standard APIs (no
 * `node:*` imports), so the same class runs under Node (stdio/HTTP
 * entrypoints), Cloudflare Workers (worker.ts), and tests. Where the data
 * actually lives is delegated to a tiny {@link StorageAdapter}:
 *
 *  - `FileStorage` (storage/file.ts)    → JSON file with atomic writes (Node)
 *  - `DurableObjectStorage` (worker.ts) → Cloudflare DO storage (production)
 *  - `MemoryStorage` (storage/memory.ts)→ throwaway storage for tests
 *
 * Production patterns that live here regardless of adapter:
 *  - **Validated reads**: persisted data is parsed through a Zod schema on
 *    load, so corrupt or foreign data fails loudly at startup instead of
 *    mysteriously at request time.
 *  - **Serialized writes**: mutations queue behind a single promise chain, so
 *    concurrent tool calls can't interleave writes.
 */
import { StoreFileSchema, type Bookmark, type StoreFile } from "./schemas.js";

/** Minimal persistence port — implement this to add a new backend. */
export interface StorageAdapter {
  /** Return the persisted document, or null if nothing was saved yet. */
  read(): Promise<unknown | null>;
  /** Durably persist the document. */
  write(data: StoreFile): Promise<void>;
}

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

/** 8-char hex id via Web Crypto (available in Node 20+ and Workers). */
function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class BookmarkStore {
  private bookmarks = new Map<string, Bookmark>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly storage: StorageAdapter) {}

  /** Load (or initialize) the store from the given storage adapter. */
  static async open(storage: StorageAdapter): Promise<BookmarkStore> {
    const store = new BookmarkStore(storage);
    const raw = await storage.read();
    if (raw !== null) {
      let parsed: StoreFile;
      try {
        parsed = StoreFileSchema.parse(raw);
      } catch (error) {
        // Corrupt data is a hard error — refuse to start and silently lose data.
        throw new Error(`Failed to load bookmark store: ${String(error)}`);
      }
      for (const bookmark of parsed.bookmarks) {
        store.bookmarks.set(bookmark.id, bookmark);
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
      id: generateId(),
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
    this.writeQueue = this.writeQueue.then(() =>
      this.storage.write({ version: 1, bookmarks: this.all() }),
    );
    return this.writeQueue;
  }
}
