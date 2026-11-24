import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import { videoSourceKey } from './storage.keys';

const PART_SIZE = 5 * 1024 * 1024;

async function putPart(url: string, body: BlobPart): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Blob([body]) });
  expect(res.status).toBe(200);
  return res.headers.get('etag') as string;
}

describe('StorageService (integration, MinIO)', () => {
  let service: StorageService;
  const videoId = randomUUID();
  const key = videoSourceKey(videoId);

  beforeAll(async () => {
    // Signed URLs embed the Host header, so sign against the endpoint reachable from this container.
    process.env.S3_PUBLIC_ENDPOINT =
      process.env.S3_ENDPOINT || 'http://minio:9000';
    const module = await Test.createTestingModule({
      imports: [StorageModule],
    }).compile();
    service = module.get(StorageService);
  });

  afterAll(async () => {
    await service.deleteObject(key);
  });

  it('completes a two-part multipart upload and heads the object', async () => {
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const part1 = new Uint8Array(new ArrayBuffer(PART_SIZE)).fill(1);
    const part2 = new Uint8Array(new ArrayBuffer(1024)).fill(2);

    const etag1 = await putPart(
      await service.presignUploadPart(key, uploadId, 1),
      part1,
    );
    const midParts = await service.listParts(key, uploadId);
    expect(midParts.map((p) => p.partNumber)).toEqual([1]);
    expect(midParts[0].size).toBe(PART_SIZE);

    const etag2 = await putPart(
      await service.presignUploadPart(key, uploadId, 2),
      part2,
    );
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);

    const head = await service.headObject(key);
    expect(head?.contentLength).toBe(PART_SIZE + 1024);
    expect(head?.contentType).toBe('video/mp4');
  }, 60000);

  it('presigns GET with attachment disposition', async () => {
    const url = await service.presignGetObject(key, {
      contentDisposition: 'attachment; filename="video.mp4"',
    });

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    await res.arrayBuffer();
  }, 30000);

  it('serves 206 Partial Content for Range requests', async () => {
    const url = await service.presignGetObject(key);

    const res = await fetch(url, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(10);
  }, 30000);

  it('aborts a multipart upload', async () => {
    const abortKey = videoSourceKey(randomUUID());
    const uploadId = await service.createMultipartUpload(abortKey, 'video/mp4');

    await service.abortMultipartUpload(abortKey, uploadId);

    await expect(service.listParts(abortKey, uploadId)).rejects.toThrow();
  });

  it('deletes the object and head reports absence', async () => {
    await service.deleteObject(key);

    expect(await service.headObject(key)).toBeNull();
  });
});
