import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import { uuidv7 } from 'uuidv7';

/** An upload as the attachment service receives it: on disk, already hashed. */
export interface SpooledFile {
  originalname: string;
  mimetype: string;
  size: number;
  /** Temp file holding the bytes; the service removes it when done. */
  path: string;
  /** Hex SHA-256, computed while the bytes streamed in. */
  checksum: string;
}

/**
 * A multer storage engine that streams each upload to a temp file while hashing it,
 * so a file is never held in memory and its checksum costs no second read. The
 * attachment service then streams the temp file to the StoragePort.
 */
export function hashingTempStorage(): StorageEngine {
  return {
    _handleFile(_req: Request, file, cb) {
      const path = join(tmpdir(), `patrice-upload-${uuidv7()}`);
      const hash = createHash('sha256');
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, next) {
          size += chunk.length;
          hash.update(chunk);
          next(null, chunk);
        },
      });
      pipeline(file.stream, meter, createWriteStream(path))
        .then(() => cb(null, { path, size, checksum: hash.digest('hex') } as Partial<Express.Multer.File>))
        .catch(async (err: Error) => {
          await rm(path, { force: true });
          cb(err);
        });
    },
    _removeFile(_req: Request, file, cb) {
      rm(file.path, { force: true }).then(() => cb(null), cb);
    },
  };
}
