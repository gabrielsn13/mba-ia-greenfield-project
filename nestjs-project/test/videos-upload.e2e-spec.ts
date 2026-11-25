import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/video-queue.constants';
import { Video } from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
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
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
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
  });

  async function registerAndLogin(email: string): Promise<string> {
    const mailService = (app.get(AuthService) as any).mailService;
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
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
    return res.body.access_token as string;
  }

  async function initiate(
    accessToken: string,
    sizeBytes = 250_000_000,
  ): Promise<{ videoId: string; uploadId: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes })
      .expect(201);
    return res.body;
  }

  describe('POST /videos/uploads', () => {
    it('creates a draft video and multipart upload', async () => {
      const token = await registerAndLogin('owner@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'a.mp4',
          contentType: 'video/mp4',
          sizeBytes: 250_000_000,
        })
        .expect(201);

      expect(res.body.partSize).toBe(104857600);
      expect(res.body.totalParts).toBe(3);
      expect(res.body.slug).toEqual(expect.any(String));
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: res.body.videoId });
      expect(video.status).toBe('draft');
      expect(video.upload_id).toBe(res.body.uploadId);
    });

    it('rejects anonymous, oversized and non-video requests', async () => {
      const token = await registerAndLogin('owner@example.com');

      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 })
        .expect(401);

      const tooLarge = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'a.mp4',
          contentType: 'video/mp4',
          sizeBytes: 10_000_000_001,
        })
        .expect(413);
      expect(tooLarge.body.error).toBe('VIDEO_TOO_LARGE');

      const unsupported = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'a.pdf',
          contentType: 'application/pdf',
          sizeBytes: 10,
        })
        .expect(415);
      expect(unsupported.body.error).toBe('UNSUPPORTED_CONTENT_TYPE');
      expect(await dataSource.getRepository(Video).count()).toBe(0);
    });

    it('returns 400 VALIDATION_ERROR for invalid body', async () => {
      const token = await registerAndLogin('owner@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ filename: '', contentType: 'video/mp4', sizeBytes: 0, foo: 1 })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.message.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('part signing and listing', () => {
    it('returns URLs usable to upload a part, then lists it', async () => {
      const token = await registerAndLogin('owner@example.com');
      const { videoId } = await initiate(token);

      const sign = await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/parts/sign`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(200);
      expect(sign.body.urls[0].partNumber).toBe(1);

      const put = await fetch(sign.body.urls[0].url as string, {
        method: 'PUT',
        body: new Blob([new Uint8Array(new ArrayBuffer(1024))]),
      });
      expect(put.status).toBe(200);
      expect(put.headers.get('etag')).toBeTruthy();

      const list = await request(app.getHttpServer())
        .get(`/videos/${videoId}/uploads/parts`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body.parts).toEqual([
        expect.objectContaining({
          partNumber: 1,
          size: 1024,
          etag: expect.any(String),
        }),
      ]);
    });
  });

  describe('ownership', () => {
    it('returns 404 VIDEO_NOT_FOUND for a non-owner', async () => {
      const owner = await registerAndLogin('owner@example.com');
      const other = await registerAndLogin('other@example.com');
      const { videoId } = await initiate(owner);
      const auth = { Authorization: `Bearer ${other}` };

      const responses = await Promise.all([
        request(app.getHttpServer())
          .post(`/videos/${videoId}/uploads/parts/sign`)
          .set(auth)
          .send({ partNumbers: [1] }),
        request(app.getHttpServer())
          .get(`/videos/${videoId}/uploads/parts`)
          .set(auth),
        request(app.getHttpServer())
          .delete(`/videos/${videoId}/uploads`)
          .set(auth),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      }
    });
  });

  describe('POST /videos/:id/uploads/complete', () => {
    async function uploadPart(
      token: string,
      videoId: string,
      bytes: number,
    ): Promise<string> {
      const sign = await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/parts/sign`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(200);
      const put = await fetch(sign.body.urls[0].url as string, {
        method: 'PUT',
        body: new Blob([new Uint8Array(new ArrayBuffer(bytes))]),
      });
      expect(put.status).toBe(200);
      await put.arrayBuffer();
      return put.headers.get('etag') as string;
    }

    it('returns 202, marks the video processing and enqueues one job', async () => {
      const token = await registerAndLogin('owner@example.com');
      const { videoId } = await initiate(token, 1024);
      const etag = await uploadPart(token, videoId, 1024);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(202);

      expect(res.body).toEqual({
        id: videoId,
        slug: expect.any(String),
        status: 'processing',
      });
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: videoId });
      expect(video.status).toBe('processing');
      expect((await queue.getJob(videoId))?.data).toEqual({ videoId });

      const again = await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(409);
      expect(again.body.error).toBe('INVALID_VIDEO_STATE');
    });

    it('returns 422 UPLOAD_INCOMPLETE and keeps the draft on size mismatch', async () => {
      const token = await registerAndLogin('owner@example.com');
      const { videoId } = await initiate(token, 2048);
      const etag = await uploadPart(token, videoId, 1024);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(422);

      expect(res.body.error).toBe('UPLOAD_INCOMPLETE');
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: videoId });
      expect(video.status).toBe('draft');
    });

    it('rejects anonymous, invalid body and non-owner', async () => {
      const owner = await registerAndLogin('owner@example.com');
      const other = await registerAndLogin('other@example.com');
      const { videoId } = await initiate(owner, 1024);
      const path = `/videos/${videoId}/uploads/complete`;

      await request(app.getHttpServer())
        .post(path)
        .send({ parts: [] })
        .expect(401);

      const invalid = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${owner}`)
        .send({ parts: [] })
        .expect(400);
      expect(invalid.body.error).toBe('VALIDATION_ERROR');

      const notOwner = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${other}`)
        .send({ parts: [{ partNumber: 1, etag: 'x' }] })
        .expect(404);
      expect(notOwner.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('DELETE /videos/:id/uploads', () => {
    it('removes the draft and aborts the multipart upload', async () => {
      const token = await registerAndLogin('owner@example.com');
      const { videoId } = await initiate(token);
      const abortSpy = jest.spyOn(storage, 'abortMultipartUpload');

      const res = await request(app.getHttpServer())
        .delete(`/videos/${videoId}/uploads`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      expect(res.text).toBe('');
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(
        await dataSource.getRepository(Video).findOneBy({ id: videoId }),
      ).toBeNull();
    });
  });
});
