import { Readable } from 'node:stream';
import type { StoragePort } from '../../src/storage/storage.port';

/** Demo object storage: blobs held in memory (the demo has no file host). */
export class MemoryStorageAdapter implements StoragePort {
  private readonly blobs = new Map<string, Buffer>();

  async put(key: string, body: Buffer | Readable): Promise<void> {
    if (Buffer.isBuffer(body)) {
      this.blobs.set(key, body);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c as Uint8Array));
    this.blobs.set(key, Buffer.concat(chunks));
  }

  async getStream(key: string): Promise<Readable> {
    const b = this.blobs.get(key);
    if (!b) throw new Error(`no such object: ${key}`);
    return Readable.from([b]);
  }

  async getSignedUrl(): Promise<string | null> {
    return null;
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async list(prefix = ''): Promise<string[]> {
    return [...this.blobs.keys()].filter((k) => k.startsWith(prefix));
  }
}
