import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import {
  CompleteUploadResult,
  InitiateUploadResult,
  SignedPartUrl,
  VideoDetails,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@ApiBearerAuth()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @ApiOperation({
    summary: 'Start a resumable video upload',
    description:
      'Creates the video as a draft and a multipart upload. The file itself goes directly to object storage through pre-signed part URLs.',
  })
  @ApiResponse({ status: 201, description: 'Upload initiated' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'CHANNEL_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'VIDEO_TOO_LARGE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'UNSUPPORTED_CONTENT_TYPE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/uploads/parts/sign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pre-sign upload part URLs' })
  @ApiResponse({ status: 200, description: 'Signed part URLs' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignPartsDto,
  ): Promise<{ urls: SignedPartUrl[] }> {
    const urls = await this.videosService.signParts(
      user.sub,
      id,
      dto.partNumbers,
    );
    return { urls };
  }

  @Get(':id/uploads/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description: 'Used to resume an interrupted upload.',
  })
  @ApiResponse({ status: 200, description: 'Uploaded parts' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{
    parts: { partNumber: number; size: number; etag: string }[];
  }> {
    const parts = await this.videosService.listParts(user.sub, id);
    return { parts };
  }

  @Post(':id/uploads/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete the upload and enqueue processing',
    description:
      'Finishes the multipart upload, verifies the stored object size and enqueues the video for processing.',
  })
  @ApiResponse({ status: 202, description: 'Video is now processing' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'UPLOAD_INCOMPLETE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
  }

  @Delete(':id/uploads')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Abort the upload and discard the draft' })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, id);
  }

  @Get(':slug')
  @OptionalAuth()
  @ApiOperation({
    summary: 'Get video details',
    description:
      'Anonymous viewers only see ready videos; the owner sees any status.',
  })
  @ApiResponse({ status: 200, description: 'Video details' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  getVideo(
    @Param('slug') slug: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<VideoDetails> {
    return this.videosService.getVideoDetails(slug, user?.sub);
  }

  @Get(':slug/stream')
  @OptionalAuth()
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a pre-signed storage URL that supports Range requests (206 Partial Content).',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the storage URL' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @Param('slug') slug: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<{ url: string }> {
    return { url: await this.videosService.getStreamUrl(slug, user?.sub) };
  }

  @Get(':slug/download')
  @OptionalAuth()
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects (302) to a pre-signed storage URL served with Content-Disposition: attachment.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the storage URL' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @Param('slug') slug: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<{ url: string }> {
    return { url: await this.videosService.getDownloadUrl(slug, user?.sub) };
  }
}
