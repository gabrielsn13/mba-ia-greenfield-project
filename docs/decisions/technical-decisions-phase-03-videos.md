---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-24
scope_description: "Backend foundation for video upload and processing: message queue, direct-to-storage upload of files up to 10GB, upload-completion signal, S3/MinIO usage, video worker (FFmpeg), unique video URL, streaming/download delivery, and video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend: videos module (API), S3/MinIO storage service, queue producer, video worker (new Compose service), migration for the `videos` table, and Compose infrastructure (MinIO, queue broker, worker).
- `next-frontend/` — no open decision: the video UI is out of scope for this phase (challenge statement: "a interface de vídeo não faz parte do escopo desta fase"). The OpenAPI contract produced by the backend is the only interface the frontend will consume later, already governed by `technical-decisions-next-frontend-openapi-typing`.

_Inherited constraints (not reopened):_

- Object storage is already decided by the architecture (`docs/diagrams/software-arch.mermaid`: "S3 or MinIO"); MinIO runs locally in Docker, S3 in production. This document decides **how** to use it, not **which** storage.
- Message Queue is marked `TBD` in the same diagram — TD-01 resolves it.
- Docker networking rule (`CLAUDE.md`): hosts are Compose service names, never `localhost`.
- Runtime: Node `25.6.0` (`nestjs-project/Dockerfile.dev`), NestJS 11, TypeORM 0.3.28, PostgreSQL 17.
- Libraries and versions cited below were checked on the npm registry on 2026-11-24. Context7 MCP was **not available** in the session that produced this document; official docs (BullMQ, AWS S3, MinIO) were consulted via web instead. `plan-resolve` must re-confirm the chosen libs via Context7 when `library-refs.md` is generated.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture needs a queue between the API (producer) and the video worker (consumer). The project plan leaves the technology `TBD`. The choice drives Compose infrastructure, retry semantics (TD-08), the worker bootstrap (TD-05) and the Events/Messages contract. Stack constraints: NestJS 11, PostgreSQL 17 already present, Docker Compose as the only runtime.

**Options:**

### Option A: BullMQ + Redis
- Redis-backed job queue with first-class NestJS integration (`@nestjs/bullmq` 12.x, `bullmq` 6.x; peers accept `@nestjs/core ^11`). Built-in `attempts`, `backoff` (fixed/exponential), delayed jobs, stalled-job recovery, concurrency control and failed-job retention.
- **Pros:** Official NestJS integration (`@Processor`, `BullModule.registerQueue`); retries and backoff are declarative job options; separate, visible `redis` container matches the "Message Queue" box in the architecture diagram; large community and docs.
- **Cons:** Adds Redis as new infrastructure; enqueue is not atomic with the PostgreSQL transaction (a crash between DB commit and `queue.add` can leave a video in `processing` with no job — needs mitigation in the plan); Redis persistence (AOF) must be configured to avoid losing jobs on restart.

### Option B: RabbitMQ
- AMQP broker with durable queues, acknowledgements and dead-letter exchanges. Consumed via `amqplib` or `@nestjs/microservices` (RMQ transport).
- **Pros:** Mature broker semantics (ack/nack, DLX, per-message TTL); strong delivery guarantees; management UI.
- **Cons:** Heaviest infra of the options; retry/backoff needs manual DLX + TTL topology (no built-in exponential backoff); NestJS RMQ transport is oriented to request/event patterns rather than job queues (no job state/inspection API).

### Option C: pg-boss (queue on PostgreSQL)
- Job queue stored in the existing PostgreSQL 17 (`pg-boss` 12.x, requires Node ≥ 22.12). Supports retries, backoff, scheduling and dead-letter queues.
- **Pros:** No new infrastructure; enqueue can share the same DB transaction as the video status update (transactional outbox without extra code); one fewer container.
- **Cons:** No dedicated broker container — the architecture diagram's "Message Queue" would be a schema inside the database; no official NestJS module (custom provider needed); queue polling load shares the primary database; less aligned with the challenge expectation of a distinct queue service in Compose.

**Recommendation:** **Option A (BullMQ + Redis)** — official NestJS module, declarative retry/backoff, and a dedicated broker that matches the target architecture; the lost-enqueue window is a known trade-off the plan can close (e.g., enqueue after commit + re-enqueue of stale `processing` videos). Option C is a legitimate alternative if avoiding new infra outweighs the architecture fit.

**Decision:** A
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Large-File Upload Strategy (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API must never carry the 10GB body. AWS S3 documentation lists a maximum of 10,000 parts per multipart upload, part size 5 MiB–5 GiB and a 5 GiB limit for a single PUT; MinIO implements the same API. The choice defines the upload endpoints, the response contract the client consumes, and what the API must verify. "Cross-layer" because the client protocol (parts, ETags) is part of the API contract.

**Options:**

### Option A: Direct S3 multipart upload with pre-signed part URLs
- API creates the multipart upload (`CreateMultipartUpload`) and returns an `uploadId` plus pre-signed `UploadPart` URLs (batched or on demand). The client PUTs each part directly to storage, collects the ETags and calls the API to complete (see TD-03). The API handles only small JSON.
- **Pros:** API never touches video bytes; parallel and resumable parts (retry only failed parts); works unchanged on MinIO and S3; supports 10GB with e.g. 100 MiB parts (≈100 parts, well under 10,000).
- **Cons:** Client must implement part slicing and ETag collection; storage must expose CORS `ETag` header; abandoned uploads leave orphaned parts (needs abort/lifecycle policy).

### Option B: Single pre-signed PUT URL
- API returns one pre-signed `PutObject` URL; the client uploads the whole file in one request.
- **Pros:** Simplest client and API.
- **Cons:** S3 caps a single PUT at 5 GiB, so it **cannot** satisfy 10GB; no resume; one failure restarts the whole upload.

### Option C: Resumable upload proxied by the API (tus protocol)
- API (or a tus server) receives chunks and forwards them to storage.
- **Pros:** Standard resumable protocol with existing client libs.
- **Cons:** Video bytes still traverse the API/worker process (bandwidth, CPU, disk or memory pressure) — contradicts "sem segurar a API durante o envio"; extra component or custom server code.

**Recommendation:** **Option A** — it is the only option that both keeps the API out of the data path and fits 10GB under S3/MinIO limits, with resumability for free; Option B fails the size requirement and Option C reintroduces the load the challenge forbids.

**Decision:** A

**Revisions:**
- 2026-11-24 — Resumable upload API surface, size cap and accepted types defined (validation AMB-2). Rationale: parameters fixed so the plan can specify API Contracts. Endpoint set: initiate (creates the `draft` video and the multipart upload), sign-parts (pre-signed `UploadPart` URLs for a batch of part numbers), list-parts (`ListParts`, used to resume), complete, abort. Part size 100 MiB (10GB ≈ 100 parts, far below the 10,000-part limit). The 10GB cap is validated at initiate against the declared size and re-checked with `HeadObject` at complete. Accepted content types: `video/*`.

---

## TD-03: Upload Completion Signal

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** After the last part is uploaded, something must finalize the multipart upload (`CompleteMultipartUpload`), move the video from draft to processing and publish the job (TD-01). Depends on TD-02 (multipart) and TD-01 (queue).

**Options:**

### Option A: Explicit "complete" endpoint called by the client
- Client sends `uploadId` + parts (`PartNumber`, `ETag`) to the API; the API calls `CompleteMultipartUpload`, verifies the object (`HeadObject`: existence, size), sets status `processing` and enqueues the job.
- **Pros:** Deterministic and synchronous with the client flow; the API controls ownership/authorization and validation (size, content-type) at the moment of completion; no extra storage configuration; trivially testable against real MinIO.
- **Cons:** Depends on the client calling it (abandoned uploads stay `draft`); the complete call itself is an API request.

### Option B: Storage event notification (MinIO/S3 → webhook or queue)
- Storage emits `s3:ObjectCreated:CompleteMultipartUpload`; a webhook endpoint or consumer marks the video `processing` and enqueues the job. MinIO supports webhook, Redis, PostgreSQL and AMQP targets.
- **Pros:** Server-driven; works even if the client disappears after the last part.
- **Cons:** The client still has to complete the multipart upload, so the event only fires after that call anyway; asynchronous notifications may be lost on target failure (MinIO documents this risk for async events); extra MinIO configuration and a public/trusted webhook endpoint to secure; harder to map event → video and to test.

**Recommendation:** **Option A** — the client must complete the multipart upload regardless, so the API call is the natural, verifiable and testable completion point; storage events add moving parts without removing that requirement. Abandoned drafts are handled by the lifecycle policy in TD-08.

**Decision:** A

---

## TD-04: Storage Client, Endpoints and Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Both the API (pre-signing, completion, streaming URLs) and the worker (read source, write thumbnail) talk to S3-compatible storage. Two concerns must be decided together: the client library and how presigned URLs are made reachable by an external client when services use Compose hostnames (`minio:9000` is not reachable from the user's browser), plus the bucket/key organization.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), path-style, two endpoints
- One S3 client for internal calls (`S3_ENDPOINT=http://minio:9000`) and a presigner configured with a public endpoint (`S3_PUBLIC_ENDPOINT`) so signed URLs carry a host the client can reach. `forcePathStyle: true` for MinIO. One bucket `videos`; keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** Same code targets MinIO locally and AWS S3 in production (no swap cost); the SDK is the reference implementation of multipart + presigning; keys by `videoId` avoid collisions and allow deleting a video's prefix at once.
- **Cons:** Larger dependency than the MinIO client; two endpoint settings to maintain; signatures bind to the host, so public/internal hosts must be configured carefully.

### Option B: `minio` JS client
- MinIO's own client (`presignedPutObject`, multipart helpers).
- **Pros:** Smaller API for simple cases; MinIO-native.
- **Cons:** Ties the code to MinIO semantics, weakening the "swap for S3 in production" requirement; less direct control over `CreateMultipartUpload`/`UploadPart` presigning; fewer NestJS references.

**Recommendation:** **Option A** — keeps the storage layer provider-neutral (MinIO now, S3 later) and exposes the exact multipart/presign primitives TD-02 needs. Key layout is keyed by `videoId` (UUID), independent from the public slug (TD-06), so the slug can change without moving objects.

**Decision:** A
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-05: Video Worker Deployment and Media Tooling

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The architecture shows a "Video Worker (FFmpeg)" as its own container. Decide how it is packaged, how it runs ffmpeg/ffprobe and how it reads a source that may be 10GB. Depends on TD-01 (consumer API) and TD-04 (storage access). The current dev image (`node:25.6.0-slim`) has no FFmpeg.

**Options:**

### Option A: Same codebase, separate Compose service, NestJS standalone entrypoint, `child_process` + FFmpeg binary
- A `video-worker` service built from the same image/codebase (with `ffmpeg` installed), starting a different entrypoint (`NestFactory.createApplicationContext`) that registers only the queue processor, storage and TypeORM modules. Runs `ffprobe` (JSON output) and `ffmpeg` directly through `child_process.spawn`, reading the source through a short-lived pre-signed GET URL (HTTP range input) and uploading the thumbnail back via the storage service.
- **Pros:** Reuses entities, repositories, config and storage service without a second package; scales independently (`docker compose up --scale`); no wrapper dependency to maintain; HTTP input avoids copying a 10GB file to the worker disk.
- **Cons:** Image/Dockerfile must be extended with FFmpeg; both processes share one codebase (module boundaries must stay clean); `spawn` argument handling and error parsing are written by hand.

### Option B: Same service, in-process consumer inside the API
- The API process also registers the queue processor and runs FFmpeg.
- **Pros:** No extra container.
- **Cons:** Violates the architecture (separate worker); CPU-heavy FFmpeg competes with request handling; cannot scale independently.

### Option C: Separate project/package for the worker (own `package.json`)
- A dedicated `video-worker/` folder with its own dependencies and image.
- **Pros:** Strong isolation; lean image.
- **Cons:** Duplicates the entity/migration/config knowledge or requires a shared package; more build/test plumbing in a monorepo that does not use workspaces.

**Recommendation:** **Option A** — keeps a separate process (as the diagram requires) while reusing the existing domain code; `fluent-ffmpeg` is deliberately not used because it is marked deprecated on npm ("Package no longer supported"), so a thin `spawn` wrapper is safer than a dead dependency.

**Decision:** A

---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public identifier that is unique, non-guessable enough to be shared as a link and independent of the internal primary key. It must be generated at draft pre-registration time (before upload ends).

**Options:**

### Option A: Random short id (11 chars, base64url from `crypto.randomBytes`) with UNIQUE constraint
- 8 random bytes → 11 URL-safe characters (`[A-Za-z0-9_-]`), stored in a `slug` column with a UNIQUE index; on the (astronomically rare) conflict, regenerate and retry.
- **Pros:** Short, YouTube-like links; no dependency; uniqueness guaranteed by the database constraint rather than probability; independent of the UUID primary key.
- **Cons:** Needs a bounded retry on unique-violation; not human-readable.

### Option B: UUID v4 (`crypto.randomUUID`) reused as the public identifier
- Expose the primary key itself in the URL.
- **Pros:** Zero extra column or generation logic; collision-proof in practice.
- **Cons:** 36-character URLs; leaks the internal key; couples public URL to storage key layout.

### Option C: `nanoid` package
- Same idea as A with a library (`nanoid` 6.x).
- **Pros:** Configurable alphabet/length; widely known.
- **Cons:** Current `nanoid` is ESM-only and declares `engines.node: ^22 || ^24 || >=26`, which excludes the project's Node 25.6; adds a dependency for something `crypto` already provides.

**Recommendation:** **Option A** — a DB-enforced UNIQUE `slug` satisfies "sem conflito" deterministically, avoids the nanoid engine/ESM mismatch with Node 25.6, and adds no dependency.

**Decision:** A

---

## TD-07: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The player must start without downloading the whole file (HTTP Range / `206 Partial Content`) and users must be able to download the file. The architecture diagram shows the frontend streaming from Object Storage. Authorization (who can stream which video) is an API concern and is settled in the plan's Authorization Matrix, not here. Depends on TD-04 (presigned URLs).

**Options:**

### Option A: API issues a redirect to a short-lived pre-signed GET URL
- `GET /videos/:slug/stream` (and `/download`) authorizes the request, then responds `302` to a pre-signed `GetObject` URL; storage serves Range requests itself. Download uses `ResponseContentDisposition: attachment; filename=...`.
- **Pros:** Video bytes never pass through the API (consistent with TD-02 and the diagram's frontend → storage arrow); Range/206 handled natively by MinIO/S3; authorization stays in the API per request; URL expiry bounds leakage.
- **Cons:** Signed URL host must be publicly reachable (TD-04 `S3_PUBLIC_ENDPOINT`); every playback starts with one extra redirect hop; the 206 behavior is storage's, so API tests assert redirect + storage Range via real MinIO.

### Option B: API proxies the stream (own Range handling)
- API parses `Range`, calls `GetObject` with the range and pipes the bytes with `206` headers.
- **Pros:** Single origin; full control over headers and auditing.
- **Cons:** Streams every byte through Node (bandwidth, memory, concurrency pressure) — the same load the challenge asks to avoid on upload; reimplements Range semantics that storage already provides.

### Option C: Public-read bucket with stable object URLs
- Objects readable without signing.
- **Pros:** Simplest; CDN-friendly.
- **Cons:** No per-request authorization or expiry; any URL leaks the file permanently — incompatible with future draft/unlisted rules from Phase 04.

**Recommendation:** **Option A** — storage already implements Range/206 and attachment disposition; redirecting keeps the API out of the data path while preserving per-request authorization.

**Decision:** A

**Revisions:**
- 2026-11-24 — Stream/download authorization before Phase 04 visibility exists (validation AMB-1). Rationale: rule fixed so the plan can build the Authorization Matrix. Anonymous users may stream and download videos in `ready` status only; videos in any other status are not served (not found for non-owners). Draft/unlisted visibility rules remain Phase 04.

---

## TD-08: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video moves through `rascunho → processando → pronto/erro`. Decisions: the state set, who performs each transition (API vs worker), what happens when processing fails (and on duplicate delivery), and what happens to uploads that are started but never completed. Depends on TD-01 (retry primitives) and TD-03 (completion). The draft → publish flow belongs to Phase 04 (`Fluxo de rascunho → publicação`), so this status describes processing state only.

**Options:**

### Option A: Single `status` enum + failure reason, queue-level retries
- Statuses: `draft` (pre-registered, upload in progress), `processing` (upload completed, job enqueued), `ready`, `error`. API sets `draft` and `processing`; the worker sets `ready`/`error`. The job is enqueued with `attempts` + exponential backoff; the worker is idempotent (re-running overwrites the same thumbnail key and metadata). After the last attempt the worker stores `error` plus a `failure_reason`. Abandoned `draft` uploads are aborted by a storage lifecycle rule or periodic cleanup.
- **Pros:** Smallest model matching the plan wording; retry policy lives in the queue (TD-01); idempotent processing makes duplicate delivery harmless; failure reason is visible to the owner.
- **Cons:** No per-attempt history in the database; the transition to `error` depends on the worker's final-failure hook running (stuck `processing` rows need a reconciliation path).

### Option B: Status enum plus a `video_processing_jobs` table
- Same statuses plus a table recording each attempt (timestamps, error, duration).
- **Pros:** Full audit trail and easy manual re-queue; enables reconciliation by DB query.
- **Cons:** More schema and code than the phase requires; duplicates information the queue already stores.

### Option C: No automatic retry — any failure goes straight to `error`
- **Pros:** Simplest worker.
- **Cons:** Transient failures (storage timeout, FFmpeg killed) permanently fail videos; no recovery without manual action.

**Recommendation:** **Option A** — satisfies the required lifecycle with the least schema, relies on proven queue retry semantics, and idempotent processing handles duplicate or retried jobs safely; reconciliation of stuck `processing` rows is a plan-level mitigation tied to the TD-01 enqueue trade-off.

**Decision:** A

**Revisions:**
- 2026-11-24 — Recovery of lost enqueue and stuck `processing` videos defined (validation AMB-3). Rationale: closes the TD-01 enqueue-after-commit window. Job id equals the videoId (idempotent enqueue), 3 attempts with exponential backoff, and a repeatable BullMQ reconciliation job that re-enqueues videos in `processing` for more than 15 minutes.

---

## TD-09: Metadata Persistence Shape and Thumbnail Frame

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker extracts duration and technical metadata with `ffprobe` and generates a thumbnail from one frame. The data model must store these; the frame choice defines the thumbnail's content. The plan states "pelo menos ... duração e metadados" without fixing the shape.

**Options:**

### Option A: Typed `duration_seconds` column + `metadata` JSONB for the remaining probe data; thumbnail at a fixed fraction of duration
- Columns for the values the API will filter/sort/return (duration, `size_bytes`); a JSONB `metadata` column for the rest (container, codecs, resolution, bitrate, frame rate). Thumbnail: one JPEG frame at ~10% of duration (clamped to the video), written to `videos/{videoId}/thumbnail.jpg`.
- **Pros:** Stable queryable fields plus flexibility for variable probe output; no migration needed when extra fields are exposed later; a mid-early frame avoids black intro frames more often than frame 0.
- **Cons:** JSONB content is not enforced by the schema; the fixed fraction is a heuristic.

### Option B: Fully typed columns for every metadata field
- One column each for width, height, codec, bitrate, frame rate, etc.
- **Pros:** Strong typing and validation in the database.
- **Cons:** Schema churn whenever a field is added; ffprobe output varies by container (nullable columns everywhere).

### Option C: Store the raw ffprobe JSON only (no typed duration column)
- **Pros:** Simplest worker.
- **Cons:** Duration — needed by Phase 04/05 listings — would require JSON querying everywhere.

**Recommendation:** **Option A** — duration is the one value later phases need to query and display, so it is typed; remaining probe output is kept as JSONB to avoid schema churn.

**Decision:** A

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | A (BullMQ + Redis) | A |
| TD-02 | Cross-layer | Large-File Upload Strategy (up to 10GB) | A (S3 multipart with pre-signed part URLs) | A |
| TD-03 | Backend | Upload Completion Signal | A (explicit complete endpoint) | A |
| TD-04 | Backend | Storage Client, Endpoints and Key Layout | A (AWS SDK v3, two endpoints, keys by `videoId`) | A |
| TD-05 | Backend | Video Worker Deployment and Media Tooling | A (same codebase, separate Compose service, `spawn` FFmpeg) | A |
| TD-06 | Backend | Unique Video URL Identifier | A (random base64url slug, UNIQUE) | A |
| TD-07 | Cross-layer | Streaming and Download Delivery | A (302 to pre-signed GET, storage serves Range) | A |
| TD-08 | Backend | Video Status Lifecycle and Failure Handling | A (status enum + failure reason, queue retries) | A |
| TD-09 | Backend | Metadata Persistence Shape and Thumbnail Frame | A (typed duration + JSONB, frame at ~10%) | A |
