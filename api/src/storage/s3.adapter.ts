import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StoragePort } from './storage.port';

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  /** Pre-signed URL TTL in seconds. */
  signedUrlTtl?: number;
}

/**
 * S3-compatible storage driver (Slice 4.3) — AWS S3 or MinIO. The production default:
 * uploads stream to the bucket; downloads are served by a time-limited pre-signed URL
 * (so the API never proxies blob bytes), keeping multi-instance deployments correct.
 */
export class S3StorageAdapter implements StoragePort {
  private readonly logger = new Logger(S3StorageAdapter.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly ttl: number;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.ttl = cfg.signedUrlTtl ?? 900;
    this.client = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      forcePathStyle: cfg.forcePathStyle,
      ...(cfg.accessKeyId && cfg.secretAccessKey
        ? {
            credentials: {
              accessKeyId: cfg.accessKeyId,
              secretAccessKey: cfg.secretAccessKey,
            },
          }
        : {}),
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return out.Body as Readable;
  }

  async getSignedUrl(key: string, downloadFilename?: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(downloadFilename
          ? {
              ResponseContentDisposition: `attachment; filename="${downloadFilename.replace(/"/g, '')}"`,
            }
          : {}),
      }),
      { expiresIn: this.ttl },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /** Enumerate object keys under `prefix`, following continuation tokens. */
  async list(prefix?: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(prefix ? { Prefix: prefix } : {}),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const obj of out.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
}
