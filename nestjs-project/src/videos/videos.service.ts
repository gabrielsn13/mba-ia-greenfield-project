import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  UnsupportedContentTypeException,
  UploadIncompleteException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService, UploadedPart } from '../storage/storage.service';
import { videoSourceKey } from '../storage/storage.keys';
import { Video, VideoStatus } from './entities/video.entity';
import { generateSlug } from './slug.util';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './video-queue.constants';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_MAX_RETRIES = 5;
const TITLE_MAX_LENGTH = 100;

export interface InitiateUploadInput {
  filename: string;
  contentType: string;
  sizeBytes: number;
  title?: string;
}

export interface InitiateUploadResult {
  videoId: string;
  slug: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
}

export interface CompleteUploadResult {
  id: string;
  slug: string;
  status: VideoStatus.PROCESSING;
}

export interface SignedPartUrl {
  partNumber: number;
  url: string;
}

export interface VideoDetails {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  metadata: Record<string, unknown> | null;
  thumbnailUrl: string | null;
  createdAt: Date;
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
};

function extensionFor(contentType: string): string {
  return (
    EXTENSION_BY_CONTENT_TYPE[contentType] ?? contentType.split('/')[1] ?? 'mp4'
  );
}

function isSlugConflict(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = err.driverError as { code?: string; detail?: string };
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes('slug')
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue<ProcessVideoJobData>,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<InitiateUploadResult> {
    if (!input.contentType.toLowerCase().startsWith('video/')) {
      throw new UnsupportedContentTypeException();
    }
    if (input.sizeBytes > this.storageCfg.maxVideoSizeBytes) {
      throw new VideoTooLargeException();
    }

    const channel = await this.channelRepository.findOne({
      where: { user_id: userId },
    });
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const video = await this.saveDraftWithUniqueSlug({
      id,
      channel_id: channel.id,
      title: (input.title ?? input.filename).slice(0, TITLE_MAX_LENGTH),
      status: VideoStatus.DRAFT,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      source_key: videoSourceKey(id),
    });

    let uploadId: string;
    try {
      uploadId = await this.storageService.createMultipartUpload(
        video.source_key,
        video.content_type,
      );
    } catch (error) {
      await this.videoRepository.delete({ id: video.id });
      throw error;
    }
    await this.videoRepository.update(
      { id: video.id },
      { upload_id: uploadId },
    );

    const partSize = this.storageCfg.uploadPartSizeBytes;
    return {
      videoId: video.id,
      slug: video.slug,
      uploadId,
      partSize,
      totalParts: Math.ceil(input.sizeBytes / partSize),
    };
  }

  async signParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<SignedPartUrl[]> {
    const video = await this.findOwnedDraft(userId, videoId);
    const totalParts = Math.ceil(
      video.size_bytes / this.storageCfg.uploadPartSizeBytes,
    );
    if (partNumbers.some((n) => n < 1 || n > totalParts)) {
      throw new BadRequestException(
        `partNumbers must be between 1 and ${totalParts}`,
      );
    }

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          video.source_key,
          video.upload_id as string,
          partNumber,
        ),
      })),
    );
  }

  async listParts(userId: string, videoId: string): Promise<UploadedPart[]> {
    const video = await this.findOwnedDraft(userId, videoId);
    return this.storageService.listParts(
      video.source_key,
      video.upload_id as string,
    );
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedDraft(userId, videoId);
    await this.storageService.abortMultipartUpload(
      video.source_key,
      video.upload_id as string,
    );
    await this.videoRepository.delete({ id: video.id });
  }

  async completeUpload(
    userId: string,
    videoId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedDraft(userId, videoId);

    try {
      await this.storageService.completeMultipartUpload(
        video.source_key,
        video.upload_id as string,
        [...parts].sort((a, b) => a.partNumber - b.partNumber),
      );
    } catch {
      throw new UploadIncompleteException();
    }

    const head = await this.storageService.headObject(video.source_key);
    if (!head || head.contentLength !== video.size_bytes) {
      throw new UploadIncompleteException();
    }

    await this.videoRepository.manager.transaction(async (manager) => {
      const result = await manager.update(
        Video,
        { id: video.id, status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, processing_started_at: new Date() },
      );
      if (!result.affected) {
        throw new InvalidVideoStateException();
      }
    });

    await this.videoQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id } satisfies ProcessVideoJobData,
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: video.id },
    );

    return {
      id: video.id,
      slug: video.slug,
      status: VideoStatus.PROCESSING,
    };
  }

  async getVideoDetails(slug: string, userId?: string): Promise<VideoDetails> {
    const video = await this.findBySlugForViewer(slug, userId);
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignGetObject(video.thumbnail_key)
      : null;
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      contentType: video.content_type,
      sizeBytes: Number(video.size_bytes),
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl,
      createdAt: video.created_at,
    };
  }

  async getStreamUrl(slug: string, userId?: string): Promise<string> {
    const video = await this.findPlayableForViewer(slug, userId);
    return this.storageService.presignGetObject(video.source_key);
  }

  async getDownloadUrl(slug: string, userId?: string): Promise<string> {
    const video = await this.findPlayableForViewer(slug, userId);
    return this.storageService.presignGetObject(video.source_key, {
      contentDisposition: `attachment; filename="${video.slug}.${extensionFor(video.content_type)}"`,
    });
  }

  // The owner sees any status; everyone else only sees ready videos.
  async findBySlugForViewer(slug: string, userId?: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: { channel: true },
    });
    const isOwner = !!userId && video?.channel.user_id === userId;
    if (!video || (!isOwner && video.status !== VideoStatus.READY)) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  // A draft has no stored object yet, so there is nothing to stream or download.
  private async findPlayableForViewer(
    slug: string,
    userId?: string,
  ): Promise<Video> {
    const video = await this.findBySlugForViewer(slug, userId);
    if (video.status === VideoStatus.DRAFT) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async findOwnedVideo(userId: string, videoId: string): Promise<Video> {
    const video = await this.videoRepository
      .createQueryBuilder('video')
      .innerJoin('video.channel', 'channel')
      .where('video.id = :videoId', { videoId })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async findOwnedDraft(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.findOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidVideoStateException();
    }
    return video;
  }

  private async saveDraftWithUniqueSlug(
    data: Omit<Partial<Video>, 'slug'>,
  ): Promise<Video> {
    for (let attempt = 0; attempt <= SLUG_MAX_RETRIES; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...data, slug: generateSlug() }),
        );
      } catch (error) {
        if (!isSlugConflict(error)) throw error;
      }
    }
    throw new Error('Slug conflict could not be resolved after max retries');
  }
}
