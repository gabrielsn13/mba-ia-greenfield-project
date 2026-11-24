---
libs:
  "@nestjs/bullmq":
    version: "^12.0.2"
    context7_id: "unavailable"
    fetched_at: "2026-11-24T14:25:00-03:00"
  bullmq:
    version: "^6.7.10"
    context7_id: "unavailable"
    fetched_at: "2026-11-24T14:25:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1176.0"
    context7_id: "unavailable"
    fetched_at: "2026-11-24T14:25:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1176.0"
    context7_id: "unavailable"
    fetched_at: "2026-11-24T14:25:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-24T14:24:01-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this phase (TD-01, TD-04).

> **Context7 discrepancy flag:** the Context7 MCP was not available in this session (same as in the research stage). Versions come from `npm view` on 2026-11-24 and the excerpts from the official BullMQ docs (`docs.bullmq.io`), the NestJS queues docs and the AWS SDK v3 / S3 API docs. Re-confirm via Context7 (`context7_id` is `unavailable`) before implementing each SI, and against the version actually installed in `nestjs-project/package.json`.

## @nestjs/bullmq + bullmq

**Decided in:** `phase-03-videos/TD-01` (BullMQ + Redis). Peers accept `@nestjs/core ^11`.

```typescript
// app/worker module
BullModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (c: ConfigService) => ({
    connection: { host: c.get('REDIS_HOST'), port: c.get<number>('REDIS_PORT') }, // host = compose service "redis"
  }),
});
BullModule.registerQueue({ name: 'video-processing' });

// producer
constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
await this.queue.add('process', { videoId }, {
  jobId: videoId,                                   // idempotent enqueue (TD-08 revision)
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 1000,
});

// consumer
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>) { /* ffprobe + thumbnail */ }
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* when job.attemptsMade >= job.opts.attempts -> status error */ }
}
```

- `connection` for workers must not set `maxRetriesPerRequest` other than `null` when passing an own ioredis instance; passing a plain options object (as above) is handled by BullMQ.
- Reconciliation (TD-08 revision): `queue.upsertJobScheduler('reconcile-processing', { every: 5 * 60 * 1000 }, { name: 'reconcile', data: {} })`. Upsert is idempotent per scheduler id, so it is safe to call on every API/worker boot; a scheduler only produces a new job when the previous one starts processing.
- Re-adding a job with an existing `jobId` is ignored while the job still exists in the queue, which keeps enqueue idempotent; a failed/removed job id can be re-added.
- Standalone worker (TD-05): `NestFactory.createApplicationContext(WorkerModule)` keeps the process alive via the BullMQ worker connection; call `app.enableShutdownHooks()` for graceful close.
- Redis persistence (AOF) is configured in Compose (`redis-server --appendonly yes`).

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Decided in:** `phase-03-videos/TD-04` (AWS SDK v3, MinIO now / S3 later), used by TD-02, TD-03, TD-07.

```typescript
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,        // http://minio:9000 (internal)
  forcePathStyle: true,                     // required for MinIO
  credentials: { accessKeyId, secretAccessKey },
});
// Signed URLs must carry the host the browser reaches: use a second client with
// endpoint = S3_PUBLIC_ENDPOINT for getSignedUrl.

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));

const url = await getSignedUrl(
  publicS3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

const { Parts } = await s3.send(new ListPartsCommand({ Bucket, Key, UploadId })); // resume

await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: parts.map(({ ETag, PartNumber }) => ({ ETag, PartNumber })) }, // ascending PartNumber
}));
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
const head = await s3.send(new HeadObjectCommand({ Bucket, Key })); // ContentLength, ContentType

const download = await getSignedUrl(publicS3, new GetObjectCommand({
  Bucket, Key, ResponseContentDisposition: `attachment; filename="${name}"`,
}), { expiresIn: 300 });
```

- S3 limits (also enforced by MinIO): 10,000 parts, 5 MiB–5 GiB per part (last part may be smaller), single PUT ≤ 5 GiB. 100 MiB parts for 10GB ≈ 100 parts.
- Browser uploads need bucket CORS exposing the `ETag` header and allowing `PUT`; the client collects each part's ETag.
- Range/`206 Partial Content` is served by storage on the pre-signed `GetObject` URL.
- The worker reads the source with a pre-signed GET URL passed to `ffprobe`/`ffmpeg` (TD-05) and writes the thumbnail with `PutObjectCommand`.
- Bucket creation (`videos`) and CORS are infrastructure concerns defined in the plan (Compose init job / `mc`).

## ffmpeg / ffprobe (system tooling, not an npm dependency)

**Decided in:** `phase-03-videos/TD-05`. Installed in the worker image via the OS package manager; invoked with `child_process.spawn` (no `fluent-ffmpeg`, deprecated).

- Metadata: `ffprobe -v error -print_format json -show_format -show_streams <url>`.
- Thumbnail: `ffmpeg -ss <t> -i <url> -frames:v 1 -q:v 2 thumbnail.jpg` (seek before `-i` for fast input seeking; `t` ≈ 10% of the duration per TD-09).
