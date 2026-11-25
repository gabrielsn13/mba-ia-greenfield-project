import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { StorageService } from '../storage/storage.service';
import { videoThumbnailKey } from '../storage/storage.keys';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/video-queue.constants';
import { MediaToolsService } from './media-tools.service';
import {
  RECONCILIATION_JOB,
  VideoReconciliationService,
} from './video-reconciliation.service';

const MAX_FAILURE_REASON_LENGTH = 1000;

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly media: MediaToolsService,
    private readonly reconciliation: VideoReconciliationService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    if (job.name === RECONCILIATION_JOB) {
      await this.reconciliation.reconcile();
      return;
    }
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.log(`Skipping video ${videoId}: nothing to process`);
      return;
    }

    const sourceUrl = await this.storage.presignInternalGetObject(
      video.source_key,
    );
    const { durationSeconds, metadata } = await this.media.probe(sourceUrl);
    const thumbnail = await this.media.extractThumbnail(
      sourceUrl,
      durationSeconds,
    );
    const thumbnailKey = videoThumbnailKey(video.id);
    await this.storage.putObject(
      thumbnailKey,
      thumbnail.data,
      thumbnail.contentType,
    );
    const head = await this.storage.headObject(video.source_key);

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: durationSeconds,
        metadata: metadata as QueryDeepPartialEntity<Video>['metadata'],
        thumbnail_key: thumbnailKey,
        size_bytes: head?.contentLength ?? video.size_bytes,
        failure_reason: null,
      },
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job || job.name !== PROCESS_VIDEO_JOB) return;
    const maxAttempts = job.opts.attempts ?? PROCESS_VIDEO_JOB_OPTIONS.attempts;
    if (job.attemptsMade < maxAttempts) return;

    await this.videoRepository.update(
      { id: job.data.videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.ERROR,
        failure_reason: error.message.slice(0, MAX_FAILURE_REASON_LENGTH),
      },
    );
    this.logger.error(
      `Video ${job.data.videoId} failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
  }
}
