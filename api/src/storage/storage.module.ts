import { Global, Module, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { STORAGE_PORT, StoragePort } from './storage.port';
import { LocalFsStorageAdapter } from './local-fs.adapter';
import { S3StorageAdapter } from './s3.adapter';

/**
 * Wires the configured StoragePort driver (Slice 4.3). `STORAGE_DRIVER=s3` requires
 * the S3_* settings; `local` (default) writes under STORAGE_LOCAL_DIR. Global so the
 * attachments module (and later submission answers) can inject the port directly.
 */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE_PORT,
      inject: [ENV],
      useFactory: (env: Env): StoragePort => {
        const logger = new Logger('StorageModule');
        if (env.STORAGE_DRIVER === 's3') {
          if (!env.S3_BUCKET) {
            throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET to be set');
          }
          logger.log(`Object storage: s3 (bucket=${env.S3_BUCKET})`);
          return new S3StorageAdapter({
            bucket: env.S3_BUCKET,
            region: env.S3_REGION,
            endpoint: env.S3_ENDPOINT,
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
          });
        }
        logger.log(`Object storage: local-fs (dir=${env.STORAGE_LOCAL_DIR})`);
        return new LocalFsStorageAdapter(env.STORAGE_LOCAL_DIR);
      },
    },
  ],
  exports: [STORAGE_PORT],
})
export class StorageModule {}
