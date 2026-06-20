import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { LifecycleState } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import { STORAGE_PORT, StoragePort } from '../storage/storage.port';
import { attachmentKindFor } from './attachment-kind';

export interface UploadFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface AttachmentMetaView {
  id: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  kind: string;
  checksum: string | null;
  uploaderUserId: string;
  createdAt: Date;
}

export interface DownloadTarget {
  storageKey: string;
  filename: string;
  contentType: string;
}

/**
 * Attachments (Slice 4.3). Upload streams the file into the configured StoragePort
 * and records metadata against an **existing** message (the exactly-one-owner CHECK
 * requires the owner at insert). Download is ungated in v1 — served by a pre-signed
 * URL (S3) or by streaming the blob (local-fs).
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  private toMeta(a: {
    id: string;
    messageId: string | null;
    filename: string;
    contentType: string;
    byteSize: bigint;
    kind: string;
    checksum: string | null;
    uploaderUserId: string;
    createdAt: Date;
  }): AttachmentMetaView {
    return {
      id: a.id,
      messageId: a.messageId,
      filename: a.filename,
      contentType: a.contentType,
      byteSize: Number(a.byteSize),
      kind: a.kind,
      checksum: a.checksum,
      uploaderUserId: a.uploaderUserId,
      createdAt: a.createdAt,
    };
  }

  async upload(
    messageId: string,
    uploaderUserId: string,
    file: UploadFile | undefined,
  ): Promise<AttachmentMetaView> {
    if (!file) {
      throw new UnprocessableError('NO_FILE', 'A file is required');
    }
    if (file.size > this.env.ATTACHMENT_MAX_BYTES) {
      throw new UnprocessableError(
        'FILE_TOO_LARGE',
        `File exceeds the ${this.env.ATTACHMENT_MAX_BYTES}-byte limit`,
      );
    }

    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        lifecycleState: true,
        task: { select: { organizationId: true } },
      },
    });
    if (!message) throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found');
    if (message.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('MESSAGE_RETIRED', 'Message is retired');
    }

    const organizationId = message.task.organizationId;
    const storageKey = `attachments/${organizationId}/${uuidv7()}`;
    const checksum = createHash('sha256').update(file.buffer).digest('hex');

    await this.storage.put(storageKey, file.buffer, file.mimetype);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const attachment = await tx.attachment.create({
          data: {
            organizationId,
            messageId,
            uploaderUserId,
            storageKey,
            filename: file.originalname,
            contentType: file.mimetype,
            byteSize: BigInt(file.size),
            kind: attachmentKindFor(file.mimetype),
            checksum,
          },
        });
        await this.activity.logActivity({
          tx,
          organizationId,
          actorUserId: uploaderUserId,
          subjectType: 'attachment',
          subjectId: attachment.id,
          verb: 'attachment.created',
          payload: { attachmentId: attachment.id, messageId },
        });
        return attachment;
      });
      return this.toMeta(created);
    } catch (err) {
      // The row didn't land — don't leak the orphaned blob.
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  /** Resolve where a download should come from (ungated read in v1). */
  async resolveDownload(id: string): Promise<DownloadTarget> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id },
      select: {
        storageKey: true,
        filename: true,
        contentType: true,
        lifecycleState: true,
      },
    });
    if (!attachment || attachment.lifecycleState === LifecycleState.retired) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }
    return {
      storageKey: attachment.storageKey,
      filename: attachment.filename,
      contentType: attachment.contentType,
    };
  }

  /** A pre-signed URL for the blob, or null if the driver streams instead. */
  signedUrl(target: DownloadTarget): Promise<string | null> {
    return this.storage.getSignedUrl(target.storageKey, target.filename);
  }

  /** A readable stream over the blob (local-fs path). */
  stream(target: DownloadTarget): Promise<Readable> {
    return this.storage.getStream(target.storageKey);
  }
}
