/**
 * MemoryStorage — throwaway adapter for tests (and a reference for how small
 * a StorageAdapter can be).
 */
import type { StoreFile } from "../schemas.js";
import type { StorageAdapter } from "../store.js";

export class MemoryStorage implements StorageAdapter {
  private data: StoreFile | null = null;

  async read(): Promise<unknown | null> {
    return this.data;
  }

  async write(data: StoreFile): Promise<void> {
    this.data = structuredClone(data);
  }
}
