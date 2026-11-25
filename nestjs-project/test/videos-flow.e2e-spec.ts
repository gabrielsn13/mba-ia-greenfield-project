import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

// Requires the real video-worker container from Compose to be running.
describe('Videos full flow (e2e, real worker)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let tmpDir: string;
  let fixture: Buffer;
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
    tmpDir = mkdtempSync(join(tmpdir(), 'video-flow-'));
    const file = join(tmpDir, 'fixture.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=320x240:rate=15',
        '-pix_fmt',
        'yuv420p',
        file,
      ],
      { stdio: 'ignore' },
    );
    fixture = readFileSync(file);

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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
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
    const mailService = app.get(AuthService)['mailService'];
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
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

  async function initiate(token: string) {
    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'fixture.mp4',
        contentType: 'video/mp4',
        sizeBytes: fixture.length,
      })
      .expect(201);
    return res.body as { videoId: string; slug: string };
  }

  async function uploadSinglePart(
    token: string,
    videoId: string,
  ): Promise<string> {
    const sign = await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/parts/sign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1] })
      .expect(200);
    const put = await fetch(
      (sign.body as { urls: { url: string }[] }).urls[0].url,
      {
        method: 'PUT',
        body: new Blob([new Uint8Array(fixture)]),
      },
    );
    expect(put.status).toBe(200);
    await put.arrayBuffer();
    return put.headers.get('etag') as string;
  }

  async function waitForStatus(
    videoId: string,
    status: VideoStatus,
  ): Promise<Video> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: videoId });
      if (video.status === status || Date.now() > deadline) return video;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async function runFlow(token: string): Promise<{ id: string; slug: string }> {
    const { videoId, slug } = await initiate(token);
    const etag = await uploadSinglePart(token, videoId);
    await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(202);
    return { id: videoId, slug };
  }

  it('goes draft -> processing -> ready and serves stream/download', async () => {
    const token = await registerAndLogin('owner@example.com');
    const { id, slug } = await runFlow(token);

    const processed = await waitForStatus(id, VideoStatus.READY);
    expect(processed.status).toBe(VideoStatus.READY);
    expect(Number(processed.duration_seconds)).toBeGreaterThan(1);
    expect(processed.thumbnail_key).toBeTruthy();

    const details = await request(app.getHttpServer())
      .get(`/videos/${slug}`)
      .expect(200);
    expect((details.body as { status: string }).status).toBe('ready');
    const thumb = await fetch(
      (details.body as { thumbnailUrl: string }).thumbnailUrl,
    );
    expect(thumb.status).toBe(200);
    await thumb.arrayBuffer();

    const stream = await request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .expect(302);
    const ranged = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const download = await request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .expect(302);
    const file = await fetch(download.headers.location);
    expect(file.headers.get('content-disposition')).toContain('attachment');
    expect((await file.arrayBuffer()).byteLength).toBe(fixture.length);
  }, 90_000);

  it('generates distinct slugs across runs', async () => {
    const token = await registerAndLogin('owner@example.com');
    const first = await runFlow(token);
    const second = await runFlow(token);

    expect(first.slug).not.toBe(second.slug);
    expect((await waitForStatus(first.id, VideoStatus.READY)).status).toBe(
      'ready',
    );
    expect((await waitForStatus(second.id, VideoStatus.READY)).status).toBe(
      'ready',
    );
  }, 120_000);

  it('resumes an interrupted upload via list-parts', async () => {
    const token = await registerAndLogin('owner@example.com');
    const { videoId } = await initiate(token);
    const etag = await uploadSinglePart(token, videoId);

    const list = await request(app.getHttpServer())
      .get(`/videos/${videoId}/uploads/parts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const parts = (
      list.body as { parts: { partNumber: number; etag: string }[] }
    ).parts;
    expect(parts).toEqual([
      expect.objectContaining({ partNumber: 1, size: fixture.length, etag }),
    ]);

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      })
      .expect(202);
    expect((await waitForStatus(videoId, VideoStatus.READY)).status).toBe(
      'ready',
    );
  }, 90_000);

  it('abort removes the draft and cancels the multipart upload', async () => {
    const token = await registerAndLogin('owner@example.com');
    const { videoId } = await initiate(token);
    await uploadSinglePart(token, videoId);

    await request(app.getHttpServer())
      .delete(`/videos/${videoId}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect(
      await dataSource.getRepository(Video).findOneBy({ id: videoId }),
    ).toBeNull();
    await request(app.getHttpServer())
      .get(`/videos/${videoId}/uploads/parts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
