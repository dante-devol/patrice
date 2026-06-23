import {
  Controller,
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
import { UnauthenticatedError } from '../common/errors';
import {
  Authorize,
  attachmentCreateResource,
  attachmentResource,
  attachmentReviveResource,
} from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { AttachmentsService } from './attachments.service';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

// A coarse multipart safety cap; the precise, configurable limit (ATTACHMENT_MAX_BYTES)
// is enforced in the service so it can return the friendly 422.
const MULTIPART_HARD_LIMIT = 256 * 1024 * 1024;

/**
 * Attachment endpoints (Slice 4.3). Upload is scoped to a message
 * (`POST /messages/:id/attachments`) so the `attachment:create` resource resolves from
 * the path param before multipart parsing. Download (`GET /attachments/:id`) is an
 * ungated read: a pre-signed URL redirect (S3) or a streamed blob (local-fs).
 */
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post('messages/:id/attachments')
  @HttpCode(201)
  @Authorize(ACTIONS.attachmentCreate.action, attachmentCreateResource)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MULTIPART_HARD_LIMIT } }),
  )
  async upload(
    @Param('id') messageId: string,
    @UploadedFile() file: UploadFileLike | undefined,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.attachments.upload(messageId, req.user.id, file);
  }

  @Post('attachments/:id/retire')
  @HttpCode(200)
  @Authorize(ACTIONS.attachmentRetire.action, attachmentResource)
  async retire(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.attachments.retire(id, req.user.id);
  }

  @Post('attachments/:id/revive')
  @HttpCode(200)
  @Authorize(ACTIONS.attachmentRevive.action, attachmentReviveResource)
  async revive(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.attachments.revive(id, req.user.id);
  }

  @Get('attachments/:id')
  async download(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    if (!req.user) throw new UnauthenticatedError();
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

/** The subset of Express.Multer.File the service consumes. */
interface UploadFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}
