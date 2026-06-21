import { Readable } from 'node:stream';

/**
 * The object-storage seam (Slice 4.3). Two drivers implement it — S3-compatible
 * (production default) and local-fs (lightweight self-host) — so the attachment
 * service never knows which store backs it. Uploads stream in; downloads are served
 * either by a pre-signed URL (S3) or by streaming the blob back (local-fs).
 */
export const STORAGE_PORT = Symbol('STORAGE_PORT');

export interface StoragePort {
  /** Store `body` under `key` with the given content type (overwrites if present). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;

  /** Open a readable stream over the stored object (throws if missing). */
  getStream(key: string): Promise<Readable>;

  /**
   * A time-limited download URL for `key`, or `null` when the driver can't mint one
   * (local-fs) and the caller should stream instead. `downloadFilename` sets the
   * suggested filename on the response.
   */
  getSignedUrl(key: string, downloadFilename?: string): Promise<string | null>;

  /** Best-effort delete (used to clean up an orphaned blob after a failed write). */
  delete(key: string): Promise<void>;

  /**
   * List every stored object key under `prefix` (default: all). Used by the GC
   * orphaned-blob reconciliation pass (Slice 7.3) to compare the store against the
   * surviving `attachment` rows. Returns absolute storage keys.
   */
  list(prefix?: string): Promise<string[]>;
}
