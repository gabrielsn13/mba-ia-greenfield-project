import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { videoSourceKey, videoThumbnailKey } from '../src/storage/storage.keys';
import { StorageService } from '../src/storage/storage.service';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';

const SOURCE_BYTES = Buffer.alloc(4096, 7);

describe('Videos playback (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let channelId: string;
  const slugs: Record<VideoStatus, string> = {
    [VideoStatus.DRAFT]: 'draft000001',
    [VideoStatus.PROCESSING]: 'proc0000001',
    [VideoStatus.READY]: 'ready000001',
    [VideoStatus.ERROR]: 'error000001',
  };
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;

  beforeAll(async () => {
    // Signed URLs embed the host, so the test process must sign with the internal endpoint.
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
    if (originalPublicEndpoint === undefined) {
      delete process.env.S3_PUBLIC_ENDPOINT;
    } else {
      process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    ownerToken = await registerAndLogin('owner@example.com');
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email: 'owner@example.com' });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    channelId = channel.id;

    for (const status of Object.values(VideoStatus)) {
      await createVideo(slugs[status], status);
    }
  });

  async function registerAndLogin(email: string): Promise<string> {
    const mailService = app.get(AuthService)['mailService'];
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e, _n, t) => {
        token = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return (res.body as { access_token: string }).access_token;
  }

  async function createVideo(slug: string, status: VideoStatus) {
    const video = await dataSource.getRepository(Video).save({
      slug,
      channel_id: channelId,
      title: 'Sample',
      status,
      content_type: 'video/mp4',
      size_bytes: SOURCE_BYTES.length,
      source_key: 'pending',
      ...(status === VideoStatus.READY && {
        duration_seconds: 5,
        metadata: { format: { format_name: 'mp4' } },
      }),
    });
    const sourceKey = videoSourceKey(video.id);
    const update: { source_key: string; thumbnail_key?: string } = {
      source_key: sourceKey,
    };
    if (status !== VideoStatus.DRAFT) {
      await storage.putObject(sourceKey, SOURCE_BYTES, 'video/mp4');
    }
    if (status === VideoStatus.READY) {
      const thumbKey = videoThumbnailKey(video.id);
      await storage.putObject(thumbKey, Buffer.from('jpg'), 'image/jpeg');
      update.thumbnail_key = thumbKey;
    }
    await dataSource.getRepository(Video).update(video.id, update);
  }

  describe('GET /videos/:slug/stream', () => {
    it('redirects to a storage URL that serves Range with 206', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${slugs.ready}/stream`)
        .redirects(0)
        .expect(302);

      const range = await fetch(res.headers.location, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe(
        `bytes 0-1023/${SOURCE_BYTES.length}`,
      );
      expect((await range.arrayBuffer()).byteLength).toBe(1024);
    });
  });

  describe('GET /videos/:slug/download', () => {
    it('redirects to a storage URL served as an attachment', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${slugs.ready}/download`)
        .redirects(0)
        .expect(302);

      const file = await fetch(res.headers.location);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toMatch(/^attachment/);
    });
  });

  describe('visibility by status', () => {
    it.each(['draft', 'processing', 'error'] as const)(
      'returns 404 VIDEO_NOT_FOUND to anonymous viewers for a %s video',
      async (status) => {
        for (const suffix of ['', '/stream', '/download']) {
          const res = await request(app.getHttpServer())
            .get(`/videos/${slugs[status]}${suffix}`)
            .redirects(0)
            .expect(404);
          expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
        }
      },
    );

    it('lets the owner read a processing video', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${slugs.processing}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      expect((res.body as { status: string }).status).toBe('processing');
    });

    it('does not let another user read a processing video', async () => {
      const other = await registerAndLogin('other@example.com');

      await request(app.getHttpServer())
        .get(`/videos/${slugs.processing}`)
        .set('Authorization', `Bearer ${other}`)
        .expect(404);
    });

    it('treats an invalid token on a ready video as anonymous', async () => {
      await request(app.getHttpServer())
        .get(`/videos/${slugs.ready}`)
        .set('Authorization', 'Bearer invalid.token.value')
        .expect(200);
    });
  });

  describe('GET /videos/:slug', () => {
    it('returns public metadata for a ready video without a token', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${slugs.ready}`)
        .expect(200);

      expect(res.body).toMatchObject({
        slug: slugs.ready,
        status: 'ready',
        durationSeconds: 5,
        metadata: { format: { format_name: 'mp4' } },
      });
      expect((res.body as { thumbnailUrl: string }).thumbnailUrl).toEqual(
        expect.stringContaining('http'),
      );
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown slug', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/does-not-exist')
        .expect(404);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
