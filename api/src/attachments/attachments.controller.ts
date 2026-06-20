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
import { Authorize, attachmentCreateResource } from '../access/authorize.decorator';
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
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${target.filename.replace(/"/g, '')}"`,
    );
    stream.pipe(res);
  }
}

/** The subset of Express.Multer.File the service consumes. */
interface UploadFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}
