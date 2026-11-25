import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidVideoStateException,
  UploadIncompleteException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './video-queue.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration, Postgres + MinIO + Redis)', () => {
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let queue: Queue;
  let ownerId: string;
  let otherId: string;
  let counter = 0;

  beforeAll(async () => {
    // Signed URLs embed the Host header; sign for the endpoint reachable from this container.
    process.env.S3_PUBLIC_ENDPOINT =
      process.env.S3_ENDPOINT || 'http://minio:9000';
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forFeature(storageConfig),
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
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
        {
          provide: getRepositoryToken(Channel),
          useValue: dataSource.getRepository(Channel),
        },
      ],
    }).compile();
    service = module.get(VideosService);
    storage = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    moduleRef = module;
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  const createUserWithChannel = async (): Promise<string> => {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save({
      email: `uploader_${n}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: `Uploader ${n}`,
      nickname: `uploader${n}`,
      user_id: user.id,
    });
    return user.id;
  };

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    ownerId = await createUserWithChannel();
    otherId = await createUserWithChannel();
  });

  const initiate = (sizeBytes = 10_000_000_000) =>
    service.initiateUpload(ownerId, {
      filename: 'movie.mp4',
      contentType: 'video/mp4',
      sizeBytes,
    });

  it('creates a draft with unique slug and upload id', async () => {
    const a = await initiate();
    const b = await initiate();

    const saved = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: a.videoId });
    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.upload_id).toBe(a.uploadId);
    expect(saved.title).toBe('movie.mp4');
    expect(a.totalParts).toBe(96);
    expect(a.slug).not.toBe(b.slug);
  });

  it('lists the parts uploaded through signed URLs', async () => {
    const { videoId } = await initiate();
    const [{ url }] = await service.signParts(ownerId, videoId, [1]);
    const res = await fetch(url, {
      method: 'PUT',
      body: new Blob([new Uint8Array(new ArrayBuffer(1024))]),
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    const parts = await service.listParts(ownerId, videoId);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ partNumber: 1, size: 1024 });
  }, 30000);

  it('hides videos from other users', async () => {
    const { videoId } = await initiate();

    await expect(service.listParts(otherId, videoId)).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  });

  it('rejects sign-parts outside draft', async () => {
    const { videoId } = await initiate();
    await dataSource
      .getRepository(Video)
      .update({ id: videoId }, { status: VideoStatus.PROCESSING });

    await expect(
      service.signParts(ownerId, videoId, [1]),
    ).rejects.toBeInstanceOf(InvalidVideoStateException);
  });

  const uploadSinglePart = async (
    videoId: string,
    bytes: number,
  ): Promise<string> => {
    const [{ url }] = await service.signParts(ownerId, videoId, [1]);
    const res = await fetch(url, {
      method: 'PUT',
      body: new Blob([new Uint8Array(new ArrayBuffer(bytes))]),
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    return res.headers.get('etag') as string;
  };

  describe('completeUpload', () => {
    it('moves the video to processing and enqueues one job per video', async () => {
      const { videoId } = await initiate(1024);
      const etag = await uploadSinglePart(videoId, 1024);

      const result = await service.completeUpload(ownerId, videoId, [
        { partNumber: 1, etag },
      ]);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const saved = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: videoId });
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.processing_started_at).toBeInstanceOf(Date);

      const job = await queue.getJob(videoId);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId });

      await expect(
        service.completeUpload(ownerId, videoId, [{ partNumber: 1, etag }]),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
      expect(await queue.getJobCountByTypes('waiting', 'delayed')).toBe(1);
    }, 30000);

    it('keeps the draft when the stored size differs from the declared one', async () => {
      const { videoId } = await initiate(2048);
      const etag = await uploadSinglePart(videoId, 1024);

      await expect(
        service.completeUpload(ownerId, videoId, [{ partNumber: 1, etag }]),
      ).rejects.toBeInstanceOf(UploadIncompleteException);

      const saved = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: videoId });
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(await queue.getJob(videoId)).toBeUndefined();
    }, 30000);
  });

  it('aborts the upload, deleting the row and the multipart', async () => {
    const { videoId, uploadId } = await initiate();
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });

    await service.abortUpload(ownerId, videoId);

    expect(
      await dataSource.getRepository(Video).findOneBy({ id: videoId }),
    ).toBeNull();
    await expect(
      storage.listParts(video.source_key, uploadId),
    ).rejects.toThrow();
  });
});
