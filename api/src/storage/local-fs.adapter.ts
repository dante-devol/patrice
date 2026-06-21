import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { StoragePort } from './storage.port';

/**
 * Local-filesystem storage driver (Slice 4.3). Blobs land under a base directory,
 * keyed by their storage key. **Single-instance only** — an upload on one instance's
 * disk is invisible to a download on another (see the slice doc's multi-instance
 * caveat); multi-instance deployments must use the S3 driver. Downloads stream
 * (no pre-signed URL), so `getSignedUrl` returns null.
 */
export class LocalFsStorageAdapter implements StoragePort {
  private readonly logger = new Logger(LocalFsStorageAdapter.name);
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  /** Resolve a key to an absolute path, refusing any traversal outside baseDir. */
  private pathFor(key: string): string {
    const full = normalize(join(this.baseDir, key));
    if (full !== this.baseDir && !full.startsWith(this.baseDir + sep)) {
      throw new Error(`Refusing storage key outside base dir: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.pathFor(key));
  }

  async getSignedUrl(_key: string, _downloadFilename?: string): Promise<string | null> {
    return null; // local-fs streams the bytes instead of redirecting.
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  /** Recursively enumerate stored keys (forward-slash, relative to baseDir). */
  async list(prefix = ''): Promise<string[]> {
    const root = this.pathFor(prefix || '.');
    let entries;
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      return []; // missing dir = empty store
    }
    return entries
      .filter((e) => e.isFile())
      .map((e) => relative(this.baseDir, join(e.parentPath ?? e.path, e.name)))
      .map((p) => p.split(sep).join('/'));
  }
}
