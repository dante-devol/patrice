import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsStorageAdapter } from './local-fs.adapter';

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('LocalFsStorageAdapter', () => {
  let dir: string;
  let storage: LocalFsStorageAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patrice-storage-'));
    storage = new LocalFsStorageAdapter(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips an upload through a nested key', async () => {
    const body = Buffer.from('hello patrice');
    await storage.put('attachments/org-1/abc', body, 'text/plain');
    const got = await collect(await storage.getStream('attachments/org-1/abc'));
    expect(got.equals(body)).toBe(true);
  });

  it('returns null for getSignedUrl (streams instead)', async () => {
    expect(await storage.getSignedUrl('attachments/org-1/abc')).toBeNull();
  });

  it('deletes a stored object', async () => {
    await storage.put('k', Buffer.from('x'), 'text/plain');
    await storage.delete('k');
    await expect(collect(await storage.getStream('k'))).rejects.toThrow();
  });

  it('refuses a traversal key outside the base dir', async () => {
    await expect(
      storage.put('../escape', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow(/outside base dir/);
  });
});
