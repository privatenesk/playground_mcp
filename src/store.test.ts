import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileStorage } from "./storage/file.js";
import { BookmarkNotFoundError, BookmarkStore, DuplicateUrlError } from "./store.js";

describe("BookmarkStore (with FileStorage)", () => {
  let dir: string;
  let file: string;
  let store: BookmarkStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bookmark-store-"));
    file = path.join(dir, "bookmarks.json");
    store = await BookmarkStore.open(new FileStorage(file));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("adds a bookmark with defaults", async () => {
    const bookmark = await store.add({ url: "https://example.com/post", tags: ["Dev", "dev"] });
    expect(bookmark.title).toBe("example.com");
    expect(bookmark.tags).toEqual(["dev"]); // lowercased + deduplicated
    expect(bookmark.read).toBe(false);
    expect(bookmark.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("rejects duplicate URLs", async () => {
    await store.add({ url: "https://example.com", tags: [] });
    await expect(store.add({ url: "https://example.com", tags: [] })).rejects.toBeInstanceOf(
      DuplicateUrlError,
    );
  });

  it("persists to disk and reloads", async () => {
    const created = await store.add({ url: "https://example.com", title: "Example", tags: ["a"] });

    const reloaded = await BookmarkStore.open(new FileStorage(file));
    expect(reloaded.size).toBe(1);
    expect(reloaded.get(created.id)?.title).toBe("Example");

    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.version).toBe(1);
  });

  it("refuses to open a corrupt data file", async () => {
    const corruptFile = path.join(dir, "corrupt.json");
    await import("node:fs/promises").then((fs) => fs.writeFile(corruptFile, "{not json"));
    await expect(BookmarkStore.open(new FileStorage(corruptFile))).rejects.toThrow(
      /Failed to read/,
    );
  });

  it("rejects schema-invalid persisted data", async () => {
    const badFile = path.join(dir, "bad.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(badFile, JSON.stringify({ version: 99, bookmarks: [] })),
    );
    await expect(BookmarkStore.open(new FileStorage(badFile))).rejects.toThrow(/Failed to load/);
  });

  it("searches by text, tag, and read state", async () => {
    await store.add({ url: "https://a.dev", title: "TypeScript tips", tags: ["typescript"] });
    const b = await store.add({ url: "https://b.dev", title: "Rust intro", tags: ["rust"] });
    await store.markRead(b.id);

    expect(store.search({ query: "typescript" })).toHaveLength(1);
    expect(store.search({ tag: "rust" })).toHaveLength(1);
    expect(store.search({ unreadOnly: true })).toHaveLength(1);
    expect(store.search({ query: "nothing-matches" })).toHaveLength(0);
    expect(store.search({})).toHaveLength(2);
  });

  it("marks read and deletes; unknown ids throw", async () => {
    const bookmark = await store.add({ url: "https://example.com", tags: [] });
    expect((await store.markRead(bookmark.id)).read).toBe(true);
    await store.delete(bookmark.id);
    expect(store.size).toBe(0);
    await expect(store.markRead("nope")).rejects.toBeInstanceOf(BookmarkNotFoundError);
    await expect(store.delete("nope")).rejects.toBeInstanceOf(BookmarkNotFoundError);
  });

  it("handles concurrent writes without corruption", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.add({ url: `https://site${i}.dev`, tags: [] })),
    );
    const reloaded = await BookmarkStore.open(new FileStorage(file));
    expect(reloaded.size).toBe(25);
  });
});
