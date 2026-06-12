/**
 * FileStorage — Node-only JSON file adapter for local development.
 *
 * Atomic writes: write to a temp file, then rename(2). A crash mid-write
 * never leaves a half-written data file behind. This module is the only
 * storage adapter that touches `node:*` APIs, so it must never be imported
 * from the Workers bundle (worker.ts uses DurableObjectStorage instead).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StoreFile } from "../schemas.js";
import type { StorageAdapter } from "../store.js";

export class FileStorage implements StorageAdapter {
  constructor(private readonly filePath: string) {}

  async read(): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`Failed to read ${this.filePath}: ${String(error)}`);
    }
  }

  async write(data: StoreFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tmpPath, this.filePath); // atomic on POSIX filesystems
  }
}
