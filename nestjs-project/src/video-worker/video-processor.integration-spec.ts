import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import { StorageModule } from '../storage/storage.module';
import { videoSourceKey, videoThumbnailKey } from '../storage/storage.keys';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/video-queue.constants';
import { MediaToolsService } from './media-tools.service';
import { VideoProcessor } from './video-processor';
import { VideoReconciliationService } from './video-reconciliation.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FAST_RETRY = {
  ...PROCESS_VIDEO_JOB_OPTIONS,
  backoff: { type: 'fixed', delay: 100 },
};

describe('VideoProcessor (integration, Postgres + MinIO + Redis + ffmpeg)', () => {
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let storage: StorageService;
  let queue: Queue;
  let channelId: string;
  let fixtureDir: string;
  let videoBytes: Buffer;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'processor-fixture-'));
    const videoPath = join(fixtureDir, 'sample.mp4');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=5:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ]);
    videoBytes = readFileSync(videoPath);

    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forFeature(queueConfig),
        BullModule.forRootAsync({
          imports: [ConfigModule.forFeature(queueConfig)],
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.redisHost, port: cfg.redisPort },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        StorageModule,
      ],
      providers: [
        MediaToolsService,
        VideoProcessor,
        VideoReconciliationService,
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
      ],
    }).compile();
    await moduleRef.init();
    storage = moduleRef.get(StorageService);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
    await cleanAllTables(dataSource);
    await dataSource.destroy();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@example.com', password: 'hashed' });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Worker',
      nickname: 'workerchan',
      user_id: user.id,
    });
    channelId = channel.id;
  });

  const createProcessingVideo = async (slug: string, body: Buffer) => {
    const video = await dataSource.getRepository(Video).save({
      slug,
      channel_id: channelId,
      title: 'Sample',
      status: VideoStatus.PROCESSING,
      content_type: 'video/mp4',
      size_bytes: body.length,
      source_key: 'pending',
      processing_started_at: new Date(),
    });
    const key = videoSourceKey(video.id);
    await dataSource.getRepository(Video).update(video.id, { source_key: key });
    await storage.putObject(key, body, 'video/mp4');
    return video.id;
  };

  const waitForStatus = async (id: string, status: VideoStatus) => {
    for (let i = 0; i < 100; i++) {
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id });
      if (video.status === status) return video;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Video ${id} did not reach ${status}`);
  };

  it('processes a valid video to ready with duration, metadata and thumbnail', async () => {
    const id = await createProcessingVideo('okslug00001', videoBytes);

    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: id },
      { jobId: id, ...FAST_RETRY },
    );
    const video = await waitForStatus(id, VideoStatus.READY);

    expect(video.duration_seconds).toBeCloseTo(5, 0);
    expect(video.metadata).toHaveProperty('streams');
    expect(video.thumbnail_key).toBe(videoThumbnailKey(id));
    expect(video.size_bytes).toBe(videoBytes.length);
    const thumb = await storage.headObject(videoThumbnailKey(id));
    expect(thumb?.contentLength).toBeGreaterThan(0);
  });

  it('ends in error with failure_reason after exhausting retries on an invalid file', async () => {
    const id = await createProcessingVideo(
      'badslug0001',
      Buffer.from('definitely not a video'),
    );

    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: id },
      { jobId: id, ...FAST_RETRY },
    );
    const video = await waitForStatus(id, VideoStatus.ERROR);

    expect(video.failure_reason).toBeTruthy();
    expect(video.thumbnail_key).toBeNull();
    const job = await queue.getJob(id);
    expect(job?.attemptsMade).toBe(3);
  });

  it('does not touch a video that is already ready', async () => {
    const id = await createProcessingVideo('rdyslug0001', videoBytes);
    await dataSource.getRepository(Video).update(id, {
      status: VideoStatus.READY,
      thumbnail_key: 'existing/thumb.jpg',
    });

    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: id },
      { jobId: id, ...FAST_RETRY },
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const video = await dataSource.getRepository(Video).findOneByOrFail({ id });
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.thumbnail_key).toBe('existing/thumb.jpg');
    expect(await storage.headObject(videoThumbnailKey(id))).toBeNull();
  });
});
