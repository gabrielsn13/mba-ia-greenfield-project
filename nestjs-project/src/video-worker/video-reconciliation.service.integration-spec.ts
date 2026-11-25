import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue, Worker } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/video-queue.constants';
import {
  RECONCILIATION_JOB,
  VideoReconciliationService,
} from './video-reconciliation.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MINUTE = 60_000;

describe('VideoReconciliationService (integration, Postgres + Redis)', () => {
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let service: VideoReconciliationService;
  let queue: Queue;
  let channelId: string;

  beforeAll(async () => {
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
      ],
      providers: [
        VideoReconciliationService,
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
      ],
    }).compile();
    await moduleRef.init();
    service = moduleRef.get(VideoReconciliationService);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'recon@example.com', password: 'hashed' });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Recon',
      nickname: 'reconchan',
      user_id: user.id,
    });
    channelId = channel.id;
  });

  const createVideo = async (
    slug: string,
    status: VideoStatus,
    startedMinutesAgo: number | null,
  ) => {
    const video = await dataSource.getRepository(Video).save({
      slug,
      channel_id: channelId,
      title: slug,
      status,
      content_type: 'video/mp4',
      size_bytes: 10,
      source_key: `videos/${slug}/source`,
      processing_started_at:
        startedMinutesAgo === null
          ? null
          : new Date(Date.now() - startedMinutesAgo * MINUTE),
    });
    return video.id;
  };

  it('registers the repeatable reconciliation scheduler on bootstrap', async () => {
    await service.onApplicationBootstrap();

    const scheduler = await queue.getJobScheduler(RECONCILIATION_JOB);
    expect(scheduler).toBeDefined();
    expect(scheduler?.every).toBe(300000);
  });

  it('re-enqueues only videos stuck in processing beyond the threshold', async () => {
    const stale = await createVideo('stale000001', VideoStatus.PROCESSING, 30);
    await createVideo('fresh000001', VideoStatus.PROCESSING, 5);
    await createVideo('draft000001', VideoStatus.DRAFT, null);
    await createVideo('ready000001', VideoStatus.READY, 60);
    await createVideo('error000001', VideoStatus.ERROR, 60);

    const count = await service.reconcile();

    expect(count).toBe(1);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.map((j) => j.id)).toEqual([stale]);
    expect(jobs[0].data).toEqual({ videoId: stale });
  });

  it('does not create duplicate jobs when run twice', async () => {
    const stale = await createVideo('stale000002', VideoStatus.PROCESSING, 30);

    await service.reconcile();
    await service.reconcile();

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(stale);
  });

  it('replaces a retained failed job so the video can be retried', async () => {
    const stale = await createVideo('stale000003', VideoStatus.PROCESSING, 30);
    await queue.add('process-video', { videoId: stale }, { jobId: stale });
    const failing = new Worker(
      VIDEO_PROCESSING_QUEUE,
      () => Promise.reject(new Error('boom')),
      {
        connection: { host: process.env.REDIS_HOST || 'redis', port: 6379 },
      },
    );
    await new Promise((resolve) => failing.once('failed', resolve));
    await failing.close();
    expect(await (await queue.getJob(stale))?.isFailed()).toBe(true);

    await service.reconcile();

    const refreshed = await queue.getJob(stale);
    expect(await refreshed?.isFailed()).toBe(false);
  });
});
