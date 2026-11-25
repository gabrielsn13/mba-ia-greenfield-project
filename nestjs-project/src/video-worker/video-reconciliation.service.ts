import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/video-queue.constants';

export const RECONCILIATION_JOB = 'video-reconciliation';

@Injectable()
export class VideoReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoReconciliationService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue<ProcessVideoJobData>,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.videoQueue.upsertJobScheduler(RECONCILIATION_JOB, {
      every: this.config.reconciliationIntervalMs,
    });
  }

  async reconcile(): Promise<number> {
    const threshold = new Date(
      Date.now() - this.config.processingStaleAfterMinutes * 60_000,
    );
    const stale = await this.videoRepository.find({
      select: { id: true },
      where: {
        status: VideoStatus.PROCESSING,
        processing_started_at: LessThan(threshold),
      },
    });

    for (const { id } of stale) {
      await this.reenqueue(id);
    }
    if (stale.length > 0) {
      this.logger.warn(`Re-enqueued ${stale.length} stale video(s)`);
    }
    return stale.length;
  }

  private async reenqueue(videoId: string): Promise<void> {
    const existing = await this.videoQueue.getJob(videoId);
    // A retained failed job would make add() a silent no-op for the same jobId.
    if (existing && (await existing.isFailed())) {
      await existing.remove();
    }
    await this.videoQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { jobId: videoId, ...PROCESS_VIDEO_JOB_OPTIONS },
    );
  }
}
