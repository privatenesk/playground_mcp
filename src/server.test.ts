/**
 * End-to-end protocol tests: a real MCP Client talks to the real server over
 * the SDK's InMemoryTransport. This exercises the full JSON-RPC stack —
 * capability negotiation, schema validation, serialization — without spawning
 * a process. This is the standard way to test an MCP server.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "./server.js";
import { BookmarkStore } from "./store.js";

describe("bookmark-mcp end-to-end", () => {
  let dir: string;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bookmark-mcp-"));
    const store = await BookmarkStore.open(path.join(dir, "bookmarks.json"));
    const server = createServer(store);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    cleanup = async () => {
      await client.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    };
  });

  afterEach(() => cleanup());

  it("lists all four tools with annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add_bookmark", "delete_bookmark", "mark_read", "search_bookmarks"]);

    const search = tools.find((t) => t.name === "search_bookmarks");
    expect(search?.annotations?.readOnlyHint).toBe(true);
    const del = tools.find((t) => t.name === "delete_bookmark");
    expect(del?.annotations?.destructiveHint).toBe(true);
  });

  it("adds and searches bookmarks with structured output", async () => {
    const added = await client.callTool({
      name: "add_bookmark",
      arguments: {
        url: "https://modelcontextprotocol.io/docs",
        title: "MCP Docs",
        tags: ["MCP", "docs"],
      },
    });
    expect(added.isError).toBeFalsy();
    const { bookmark } = added.structuredContent as { bookmark: { id: string; tags: string[] } };
    expect(bookmark.tags).toEqual(["mcp", "docs"]);

    const found = await client.callTool({
      name: "search_bookmarks",
      arguments: { query: "mcp docs" },
    });
    const result = found.structuredContent as { total: number };
    expect(result.total).toBe(1);
  });

  it("returns an in-band error for duplicate URLs", async () => {
    const args = { url: "https://example.com", tags: [] };
    await client.callTool({ name: "add_bookmark", arguments: args });
    const second = await client.callTool({ name: "add_bookmark", arguments: args });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second.content)).toContain("already bookmarked");
  });

  it("rejects invalid input via schema validation", async () => {
    // The SDK validates against the Zod schema before our handler runs and
    // reports the failure as an in-band tool error the LLM can recover from.
    const result = await client.callTool({
      name: "add_bookmark",
      arguments: { url: "not-a-url" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/invalid url/i);
  });

  it("marks read and deletes through the full round trip", async () => {
    const added = await client.callTool({
      name: "add_bookmark",
      arguments: { url: "https://example.com/a", tags: [] },
    });
    const { bookmark } = added.structuredContent as { bookmark: { id: string } };

    const read = await client.callTool({ name: "mark_read", arguments: { id: bookmark.id } });
    expect((read.structuredContent as { bookmark: { read: boolean } }).bookmark.read).toBe(true);

    const deleted = await client.callTool({
      name: "delete_bookmark",
      arguments: { id: bookmark.id },
    });
    expect(deleted.isError).toBeFalsy();

    const missing = await client.callTool({ name: "mark_read", arguments: { id: bookmark.id } });
    expect(missing.isError).toBe(true);
  });

  it("exposes resources: static, stats, and per-bookmark template", async () => {
    await client.callTool({
      name: "add_bookmark",
      arguments: { url: "https://example.com", tags: ["dev"] },
    });

    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("bookmarks://all");
    expect(uris).toContain("bookmarks://stats");

    const all = await client.readResource({ uri: "bookmarks://all" });
    const list = JSON.parse((all.contents[0] as { text: string }).text);
    expect(list).toHaveLength(1);

    const stats = await client.readResource({ uri: "bookmarks://stats" });
    const parsed = JSON.parse((stats.contents[0] as { text: string }).text);
    expect(parsed).toMatchObject({ total: 1, unread: 1, tags: [{ tag: "dev", count: 1 }] });

    const single = await client.readResource({ uri: `bookmarks://bookmark/${list[0].id}` });
    const bookmark = JSON.parse((single.contents[0] as { text: string }).text);
    expect(bookmark.url).toBe("https://example.com");

    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("bookmarks://bookmark/{id}");
  });

  it("serves the reading_digest prompt with embedded bookmarks", async () => {
    await client.callTool({
      name: "add_bookmark",
      arguments: { url: "https://example.com/rust", title: "Rust Book", tags: ["rust"] },
    });

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("reading_digest");

    const digest = await client.getPrompt({ name: "reading_digest", arguments: { tag: "rust" } });
    const text = (digest.messages[0]?.content as { text: string }).text;
    expect(text).toContain("Rust Book");
    expect(text).toContain("tagged 'rust'");
  });
});
