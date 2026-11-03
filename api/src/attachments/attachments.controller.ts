import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import {
  Authorize,
  attachmentTaskResource,
  messageResource,
  attachmentResource,
  taskResource,
} from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { AttachmentsService } from './attachments.service';
import { hashingTempStorage, type SpooledFile } from './hashing-temp-storage';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

// A coarse multipart safety cap; the precise, configurable limit (ATTACHMENT_MAX_BYTES)
// is enforced in the service so it can return the friendly 422. Uploads stream to a
// temp file, hashed on the way in, and never sit in memory.
const MULTIPART_HARD_LIMIT = 256 * 1024 * 1024;
const fileUpload = () =>
  FileInterceptor('file', { storage: hashingTempStorage(), limits: { fileSize: MULTIPART_HARD_LIMIT } });

/**
 * Attachment endpoints. A file goes onto a message (`attachment:create` on the
 * message), or pending onto a task for an attachment answer (`task:submit`): the
 * submitter's own submit then claims it. Resources resolve from the path before the
 * multipart body is read. Download is a pre-signed redirect (S3) or a stream.
 */
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Contract(ROUTES.uploadAttachment)
  @Post('messages/:id/attachments')
  @HttpCode(201)
  @Authorize(ACTIONS.attachmentCreate.action, messageResource)
  @UseInterceptors(fileUpload())
  async upload(
    @Param('id') messageId: string,
    @UploadedFile() file: SpooledFile | undefined,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.attachments.upload({ kind: 'message', messageId }, user.id, file);
  }

  @Contract(ROUTES.uploadAnswerFile)
  @Post('tasks/:id/uploads')
  @HttpCode(201)
  @Authorize(ACTIONS.taskSubmit.action, taskResource)
  @UseInterceptors(fileUpload())
  async uploadForAnswer(
    @Param('id') taskId: string,
    @UploadedFile() file: SpooledFile | undefined,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.attachments.upload({ kind: 'pending', taskId }, user.id, file);
  }

  @Contract(ROUTES.deleteAttachment)
  @Delete('attachments/:id')
  @HttpCode(204)
  @Authorize(ACTIONS.attachmentDelete.action, attachmentResource)
  async delete(@Param('id') id: string, @CurrentUser() user: CurrentUserRef): Promise<void> {
    await this.attachments.delete(id, user.id);
  }

  @Contract(ROUTES.downloadAttachment)
  @Get('attachments/:id')
  @Authorize(ACTIONS.attachmentRead.action, attachmentTaskResource)
  async download(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.attachments.resolveDownload(id);

    const url = await this.attachments.signedUrl(target);
    if (url) {
      res.redirect(302, url);
      return;
    }
    const stream = await this.attachments.stream(target);
    res.setHeader('Content-Type', target.contentType);
    // Never let the browser sniff a stored (client-supplied) content type into
    // something executable, and always force a download rather than inline render.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDisposition(target.filename));
    stream.pipe(res);
  }
}

/**
 * Build a safe `Content-Disposition: attachment` value for a user-supplied filename.
 * Emits an ASCII-only `filename=` fallback (control chars + quotes/backslashes stripped)
 * plus an RFC 5987 `filename*=UTF-8''…` for full-fidelity Unicode, so a crafted filename
 * can neither inject header syntax nor break older clients.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
