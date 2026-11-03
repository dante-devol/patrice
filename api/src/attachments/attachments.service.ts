import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
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
import type { SpooledFile } from './hashing-temp-storage';

/** Where an upload goes: onto an existing message, or pending on a task. */
export type UploadTarget = { kind: 'message'; messageId: string } | { kind: 'pending'; taskId: string };

export interface AttachmentMetaView {
  id: string;
  taskId: string;
  messageId: string | null;
  answerId: string | null;
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
 * Attachments. An upload streams (already spooled and hashed by the multipart layer)
 * into the StoragePort and lands either on an existing message or **pending** on a
 * task: owned by its uploader and attached to nothing until their own submit claims
 * it for an answer. Unclaimed pending uploads are collected by the GC. Downloads are
 * a pre-signed URL (S3) or a streamed blob (local-fs).
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
    taskId: string;
    messageId: string | null;
    answerId: string | null;
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
      taskId: a.taskId,
      messageId: a.messageId,
      answerId: a.answerId,
      filename: a.filename,
      contentType: a.contentType,
      byteSize: Number(a.byteSize),
      kind: a.kind,
      checksum: a.checksum,
      uploaderUserId: a.uploaderUserId,
      createdAt: a.createdAt,
    };
  }

  async upload(target: UploadTarget, uploaderUserId: string, file: SpooledFile | undefined): Promise<AttachmentMetaView> {
    if (!file) {
      throw new UnprocessableError('NO_FILE', 'A file is required');
    }
    try {
      if (file.size > this.env.ATTACHMENT_MAX_BYTES) {
        throw new UnprocessableError(
          'FILE_TOO_LARGE',
          `File exceeds the ${this.env.ATTACHMENT_MAX_BYTES}-byte limit`,
        );
      }
      const taskId = await this.targetTask(target);
      const storageKey = `attachments/${uuidv7()}`;
      await this.storage.put(storageKey, createReadStream(file.path), file.mimetype, file.size);
      try {
        const created = await this.prisma.$transaction(async (tx) => {
          const messageId = target.kind === 'message' ? target.messageId : null;
          const attachment = await tx.attachment.create({
            data: {
              taskId,
              messageId,
              uploaderUserId,
              storageKey,
              filename: file.originalname,
              contentType: file.mimetype,
              byteSize: BigInt(file.size),
              kind: attachmentKindFor(file.mimetype),
              checksum: file.checksum,
            },
          });
          await this.activity.logActivity({
            tx,
            actorUserId: uploaderUserId,
            subjectType: 'attachment',
            subjectId: attachment.id,
            verb: 'attachment.created',
            payload: { attachmentId: attachment.id, taskId, messageId },
          });
          return attachment;
        });
        return this.toMeta(created);
      } catch (err) {
        // The row didn't land — don't leak the orphaned blob.
        await this.storage.delete(storageKey).catch(() => undefined);
        throw err;
      }
    } finally {
      await rm(file.path, { force: true });
    }
  }

  /** The task an upload lands on, refusing retired tasks and deleted messages. */
  private async targetTask(target: UploadTarget): Promise<string> {
    if (target.kind === 'message') {
      const message = await this.prisma.message.findUnique({
        where: { id: target.messageId },
        select: { deletedAt: true, task: { select: { id: true, lifecycleState: true } } },
      });
      if (!message || message.deletedAt) throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found');
      if (message.task.lifecycleState === LifecycleState.retired) {
        throw new ConflictError('TASK_RETIRED', 'Task is retired');
      }
      return message.task.id;
    }
    const task = await this.prisma.task.findUnique({
      where: { id: target.taskId },
      select: { lifecycleState: true, completedAt: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    if (task.lifecycleState === LifecycleState.retired) throw new ConflictError('TASK_RETIRED', 'Task is retired');
    if (task.completedAt) throw new ConflictError('TASK_COMPLETED', 'The task is complete');
    return target.taskId;
  }

  /**
   * Delete an attachment permanently (`attachment:delete`), with an audit row. The
   * blob goes after commit; one left behind is collected by the GC's blob reconcile.
   */
  async delete(id: string, actorUserId: string): Promise<void> {
    const att = await this.prisma.attachment.findUnique({
      where: { id },
      select: { id: true, storageKey: true, taskId: true },
    });
    if (!att) throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    const taskId = att.taskId;
    await this.prisma.$transaction(async (tx) => {
      await tx.attachment.delete({ where: { id } });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'attachment',
        subjectId: id,
        verb: 'attachment.deleted',
        payload: { attachmentId: id, taskId },
      });
    });
    await this.storage.delete(att.storageKey).catch((e) =>
      this.logger.warn(`Blob delete failed for ${att.storageKey}: ${(e as Error).message}`),
    );
  }

  /** Resolve where a download should come from (ungated read in v1). */
  async resolveDownload(id: string): Promise<DownloadTarget> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id },
      select: { storageKey: true, filename: true, contentType: true },
    });
    if (!attachment) {
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
