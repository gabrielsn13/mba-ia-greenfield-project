---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-24T14:25:27-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-24T14:25:22-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-24T14:24:01-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o ciclo completo de upload e processamento de vídeos no backend: upload resumível de até 10GB direto ao object storage (S3/MinIO) sem passar pela API, pré-cadastro do vídeo como rascunho, processamento assíncrono por um worker FFmpeg consumindo uma fila BullMQ (duração, metadados e thumbnail), URL única (`slug`) por vídeo, streaming e download autorizados via redirect para URLs pré-assinadas. Toda a infraestrutura nova (MinIO, Redis, worker) sobe via Docker Compose.

---

## Step Implementations

### SI-03.1 — Dependências, namespaces de config e variáveis de ambiente

**Description:** Instala as bibliotecas da fase e cria os namespaces `storage` e `queue` seguindo o padrão `registerAs` das fases anteriores, estendendo o schema Joi.

**Technical actions:**

1. Instalar em `nestjs-project`: `@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`; versões conforme `library-refs.md`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (default `videos`), `UPLOAD_PART_SIZE_BYTES` (default `104857600`), `MAX_VIDEO_SIZE_BYTES` (default `10000000000`), `PRESIGNED_URL_EXPIRATION_SECONDS` (per `TD-02`, `TD-04`, `TD-07`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `RECONCILIATION_INTERVAL_MS`, `PROCESSING_STALE_AFTER_MINUTES` (default `15`) (per `TD-01`, `TD-08`)
4. Atualizar `src/config/env.validation.ts` com todas as novas variáveis (credenciais S3 obrigatórias, demais com default) e `.env.example` com defaults compatíveis com Compose (hosts `minio`/`redis`, nunca `localhost`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Schema Joi (novas variáveis) | Integration: falha sem credenciais S3, defaults aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A aplicação sobe com todas as novas variáveis definidas e `GET /` continua retornando 200
- Subir sem `S3_ACCESS_KEY` ou `S3_SECRET_KEY` causa erro de validação Joi no bootstrap
- `REDIS_HOST` e `S3_ENDPOINT` têm defaults/valores de exemplo usando nomes de serviço do Compose (`redis`, `http://minio:9000`)

---

### SI-03.2 — Infraestrutura Docker: MinIO, Redis, FFmpeg e video-worker

**Description:** Adiciona ao `compose.yaml` o object storage, a fila e o container do worker, com FFmpeg disponível na imagem.

**Technical actions:**

1. Atualizar `Dockerfile.dev` instalando `ffmpeg` (inclui `ffprobe`) (per `phase-03-videos/TD-05`)
2. Adicionar serviço `minio` (imagem `minio/minio`, API `9000`, console `9001`, volume persistente, healthcheck) e serviço de init `minio-init` (`minio/mc`) que cria o bucket `videos` e aplica CORS permitindo `PUT`/`GET` e expondo o header `ETag` (per `TD-02`, `TD-04`)
3. Adicionar serviço `redis` (imagem `redis`, `--appendonly yes`, volume persistente, healthcheck) (per `TD-01`)
4. Adicionar serviço `video-worker` — mesma imagem/código de `nestjs-api`, comando de start do worker, `depends_on` de `db`, `redis`, `minio-init` (per `TD-05`); `nestjs-api` passa a depender de `redis` e `minio`
5. Expor as variáveis `S3_*` e `REDIS_*` aos serviços via `.env`/`environment` usando nomes de serviço do Compose

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose up -d` sobe `db`, `mailpit`, `minio`, `redis`, `nestjs-api` e `video-worker` com healthchecks verdes
- O bucket `videos` existe após o `minio-init` concluir
- `ffprobe -version` e `ffmpeg -version` executam dentro do container `video-worker`
- O Redis persiste dados entre reinícios (AOF ativo)

---

### SI-03.3 — Entidade Video e migration

**Description:** Cria a entidade `Video` ligada ao canal e a migration versionada da tabela `videos`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com as colunas do Data Model (per `phase-03-videos/TD-06`, `TD-08`, `TD-09`), enum `VideoStatus` (`draft`, `processing`, `ready`, `error`) e `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })`
2. Criar `src/videos/videos.module.ts` inicial com `TypeOrmModule.forFeature([Video])`
3. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` e revisar o SQL (UNIQUE em `slug`, índices em `channel_id` e `(status, processing_started_at)`) com `down()` reversível

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: UNIQUE `slug`, defaults, enum de status, FK para canal, `metadata` JSONB | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `src/videos/videos.module.spec.ts` |
| Migration `CreateVideos` | Integration: up/down | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas, constraints e índices do Data Model
- Inserir dois vídeos com o mesmo `slug` falha por violação de unicidade
- Um vídeo novo tem `status = 'draft'` por padrão
- `npm run migration:revert` remove a tabela sem erro

---

### SI-03.4 — Exceções de domínio e gerador de slug

**Description:** Define as exceções de domínio do módulo de vídeos (Error Catalog) e o gerador do identificador único de URL.

**Technical actions:**

1. Adicionar em `src/common/exceptions/domain.exception.ts` as exceções do Error Catalog (`VideoNotFoundException`, `VideoTooLargeException`, `UnsupportedContentTypeException`, `InvalidVideoStateException`, `UploadIncompleteException`, `ChannelNotFoundException`), estendendo `DomainException`
2. Criar `src/videos/slug.util.ts` — `generateSlug()` com `crypto.randomBytes(8).toString('base64url')` (11 caracteres) (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateSlug` | Unit: tamanho 11, alfabeto base64url, unicidade em amostra | `src/videos/slug.util.spec.ts` |
| Exceções novas | Unit: mapeamento errorCode/HTTP no filtro | `src/common/filters/domain-exception.filter.spec.ts` |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `generateSlug()` retorna sempre 11 caracteres `[A-Za-z0-9_-]`
- Cada exceção do Error Catalog produz `{ statusCode, error, message }` com o `errorCode` e HTTP status especificados

---

### SI-03.5 — StorageService (S3/MinIO)

**Description:** Encapsula o cliente S3 (multipart, presign, head, delete), mantendo a camada provider-neutral (MinIO hoje, S3 depois).

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` com dois `S3Client` (`forcePathStyle: true`): um com `S3_ENDPOINT` (operações internas) e um com `S3_PUBLIC_ENDPOINT` (assinaturas) (per `phase-03-videos/TD-04`)
2. Implementar `createMultipartUpload`, `presignUploadPart`, `listParts`, `completeMultipartUpload`, `abortMultipartUpload` (per `TD-02`)
3. Implementar `headObject`, `deleteObject`, `presignGetObject` (com `ResponseContentDisposition` opcional para download) (per `TD-07`)
4. Criar `src/storage/storage.keys.ts` com `videoSourceKey(id)` = `videos/{videoId}/source` e `videoThumbnailKey(id)` = `videos/{videoId}/thumbnail.jpg` (per `TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: multipart completo, presign de parte e de GET, head, delete contra MinIO real do Compose | `src/storage/storage.service.integration-spec.ts` |
| `storage.keys` | Unit: formato das chaves | `src/storage/storage.keys.spec.ts` |
| `StorageModule` | Unit: compilação | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- Um upload multipart de duas partes via URLs pré-assinadas (`PUT`) seguido de `completeMultipartUpload` resulta em objeto legível por `headObject`
- `presignGetObject` com disposition `attachment` gera URL cuja resposta traz `Content-Disposition: attachment`
- Uma requisição `Range` à URL pré-assinada de GET retorna `206 Partial Content`
- `deleteObject` remove o objeto e `headObject` subsequente indica inexistência

---

### SI-03.6 — VideosService: ciclo de upload (initiate, sign-parts, list-parts, abort)

**Description:** Lógica de negócio do pré-cadastro do rascunho e do upload resumível, com autorização por dono (canal).

**Technical actions:**

1. Em `src/videos/videos.service.ts`, implementar `initiateUpload(userId, dto)`: resolve o canal do usuário, valida `contentType` (`video/*`) e `sizeBytes` ≤ 10GB, gera `slug` com retry em conflito de UNIQUE, cria o `Video` em `draft` e chama `createMultipartUpload`, persistindo `upload_id` e `source_key` (per `phase-03-videos/TD-02`, `TD-06`, `TD-08`)
2. Implementar `signParts(userId, videoId, partNumbers)` — valida dono e estado `draft`, retorna URLs pré-assinadas (per `TD-02`)
3. Implementar `listParts(userId, videoId)` — suporta retomada do upload (per `TD-02`)
4. Implementar `abortUpload(userId, videoId)` — aborta o multipart e remove o rascunho (per `TD-08`)
5. Criar helper de autorização `findOwnedVideo(userId, videoId)` retornando `VideoNotFoundException` para não-donos

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (ramificações: tipo inválido, tamanho excedido, estado inválido, não-dono) | Unit (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService` (contrato com DB e MinIO reais) | Integration | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `initiateUpload` com dados válidos cria um vídeo `draft` com `slug` único e `upload_id` preenchido
- `initiateUpload` com `sizeBytes` > 10GB lança `VideoTooLargeException`; com `contentType` fora de `video/*` lança `UnsupportedContentTypeException`
- `signParts`/`listParts`/`abortUpload` de um vídeo de outro canal lançam `VideoNotFoundException`
- `abortUpload` remove a linha `draft` e o multipart em andamento

---

### SI-03.7 — Endpoints de upload resumível

**Description:** Expõe os endpoints de iniciar, assinar partes, listar partes e abortar upload, com DTOs validados e documentação OpenAPI.

**Technical actions:**

1. Criar DTOs `src/videos/dto/initiate-upload.dto.ts` e `sign-parts.dto.ts` com class-validator (per API Contracts → Validation Rules)
2. Criar `src/videos/videos.controller.ts` com `POST /videos/uploads`, `POST /videos/:id/uploads/parts/sign`, `GET /videos/:id/uploads/parts`, `DELETE /videos/:id/uploads`, usando `@CurrentUser()` e delegando ao `VideosService` (per `phase-03-videos/TD-02`)
3. Anotar os endpoints com `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation`, `@ApiResponse` e o `ApiErrorEnvelope`
4. Registrar `VideosController` e importar `StorageModule`/`UsersModule`/`ChannelsModule` em `VideosModule`; importar `VideosModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Endpoints de upload (autenticação, validação, autorização por dono, fluxo feliz) | E2E (supertest, MinIO real) | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `POST /videos/uploads` autenticado com payload válido retorna `201` com `videoId`, `slug`, `uploadId`, `partSize`, `totalParts`
- `POST /videos/uploads` sem token retorna `401`; com `sizeBytes` > 10GB retorna `413` `VIDEO_TOO_LARGE`; com tipo não `video/*` retorna `415` `UNSUPPORTED_CONTENT_TYPE`
- `POST /videos/uploads` com campos inválidos ou desconhecidos retorna `400` `VALIDATION_ERROR`
- `POST /videos/:id/uploads/parts/sign` retorna URLs `PUT` utilizáveis diretamente contra o MinIO
- Usuário diferente do dono recebe `404` `VIDEO_NOT_FOUND` em sign/list/abort

---

### SI-03.8 — Conclusão do upload e enfileiramento (complete)

**Description:** Finaliza o multipart, verifica o objeto, move o vídeo para `processing` e publica o job na fila.

**Technical actions:**

1. Criar `src/videos/video-queue.constants.ts` e registrar a fila `video-processing` em `VideosModule` com `BullModule.forRootAsync` (conexão `queue.config`) e `BullModule.registerQueue` (per `phase-03-videos/TD-01`)
2. Implementar `VideosService.completeUpload(userId, videoId, parts)`: valida dono e estado `draft`, chama `completeMultipartUpload`, confere `HeadObject` (existência e `ContentLength` igual a `size_bytes`, senão `UploadIncompleteException`), em transação define `status='processing'` e `processing_started_at`, e **após o commit** enfileira o job com `jobId = videoId`, `attempts: 3` e backoff exponencial (per `TD-03`, `TD-08`)
3. Criar `src/videos/dto/complete-upload.dto.ts` e o endpoint `POST /videos/:id/uploads/complete` retornando `202`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` (estado inválido, tamanho divergente, enqueue após commit) | Unit (mock repo/storage/queue) | `src/videos/videos.service.spec.ts` |
| `completeUpload` com Redis, MinIO e DB reais (job criado com `jobId = videoId`) | Integration | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:id/uploads/complete` | E2E | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `POST /videos/:id/uploads/complete` com partes válidas retorna `202` com `status: "processing"` e o vídeo fica `processing` no banco
- Existe exatamente um job `process-video` na fila com `jobId` igual ao `videoId`; repetir o complete não duplica o job
- Completar um vídeo que não está em `draft` retorna `409` `INVALID_VIDEO_STATE`
- Objeto com tamanho divergente do declarado retorna `422` `UPLOAD_INCOMPLETE` e o vídeo permanece `draft`

---

### SI-03.9 — Ferramentas de mídia do worker (ffprobe/ffmpeg)

**Description:** Wrapper fino sobre `child_process.spawn` para extrair metadados e gerar o thumbnail a partir de uma URL pré-assinada.

**Technical actions:**

1. Criar `src/video-worker/media-tools.service.ts` com `probe(url)` executando `ffprobe -v error -print_format json -show_format -show_streams <url>` e retornando `{ durationSeconds, metadata }` (per `phase-03-videos/TD-05`, `TD-09`)
2. Implementar `extractThumbnail(url, durationSeconds)` executando `ffmpeg -ss <10% da duração> -i <url> -frames:v 1 -q:v 2 <arquivo>` e retornando o JPEG gerado em arquivo temporário (per `TD-09`)
3. Tratar falhas (exit code ≠ 0, saída inválida, timeout) lançando erro tipado e limpando arquivos temporários

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaToolsService` (ffmpeg/ffprobe reais sobre vídeo de fixture gerado com `ffmpeg -f lavfi`) | Integration | `src/video-worker/media-tools.service.integration-spec.ts` |
| `MediaToolsService` (arquivo corrompido/saída inválida) | Unit (parsing do JSON do ffprobe) | `src/video-worker/media-tools.service.spec.ts` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- `probe` de um vídeo de 5 s retorna `durationSeconds` ≈ 5 e `metadata` com streams e formato
- `extractThumbnail` produz um JPEG não vazio a partir de ~10% da duração
- `probe` de um arquivo não-vídeo rejeita com erro tipado e não deixa arquivos temporários

---

### SI-03.10 — Worker e processador da fila

**Description:** Processo separado (`video-worker`) que consome a fila, processa o vídeo de forma idempotente e atualiza status e metadados.

**Technical actions:**

1. Criar `src/video-worker/video-worker.module.ts` e `src/main.worker.ts` bootstrapando `NestFactory.createApplicationContext` (sem HTTP) (per `phase-03-videos/TD-05`)
2. Criar `src/video-worker/video-processor.ts` com `@Processor('video-processing')`: busca o vídeo, ignora se já `ready`, gera URL GET pré-assinada, executa `probe` e `extractThumbnail`, envia o thumbnail para `videos/{videoId}/thumbnail.jpg` e atualiza `duration_seconds`, `metadata`, `size_bytes`, `thumbnail_key` e `status='ready'` (per `TD-08`, `TD-09`)
3. Em falha definitiva (tentativas esgotadas), marcar `status='error'` e `failure_reason` via listener `onFailed` (per `TD-08`)
4. Adicionar script `start:worker` ao `package.json` e usá-lo como `command` do serviço `video-worker`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` (idempotência, transições, falha definitiva) | Unit (mock repo/storage/media) | `src/video-worker/video-processor.spec.ts` |
| Processamento real: vídeo no MinIO + job no Redis + DB → `ready` com duração e thumbnail | Integration | `src/video-worker/video-processor.integration-spec.ts` |

**Dependencies:** SI-03.8, SI-03.9

**Acceptance criteria:**

- Um vídeo válido enfileirado passa de `processing` para `ready` com `duration_seconds`, `metadata` e `thumbnail_key` preenchidos e o objeto do thumbnail existe no bucket
- Um arquivo inválido esgota as 3 tentativas e termina em `status='error'` com `failure_reason` preenchido
- Reprocessar um vídeo já `ready` não altera o registro nem recria o thumbnail
- O container `video-worker` inicia sem servidor HTTP e consome a fila `video-processing`

---

### SI-03.11 — Reconciliação de vídeos presos em `processing`

**Description:** Job repetível BullMQ que re-enfileira vídeos em `processing` há mais de 15 minutos, fechando a janela de enqueue perdido.

**Technical actions:**

1. Criar `src/video-worker/video-reconciliation.service.ts` — em `onApplicationBootstrap`, registrar `queue.upsertJobScheduler('video-reconciliation', { every: RECONCILIATION_INTERVAL_MS })` (per `phase-03-videos/TD-08`)
2. Implementar o handler que consulta vídeos `processing` com `processing_started_at` anterior a `PROCESSING_STALE_AFTER_MINUTES` e adiciona o job `process-video` com `jobId = videoId`
3. Registrar o serviço no `VideoWorkerModule` (apenas o worker executa a reconciliação)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoReconciliationService` (seleção de vídeos elegíveis com DB real; enqueue idempotente com Redis real) | Integration | `src/video-worker/video-reconciliation.service.integration-spec.ts` |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- Um vídeo `processing` há mais de 15 minutos sem job na fila é re-enfileirado e chega a `ready`
- Vídeos `processing` há menos de 15 minutos, `draft`, `ready` ou `error` não são re-enfileirados
- Executar a reconciliação duas vezes seguidas não cria jobs duplicados

---

### SI-03.12 — Consulta, streaming e download

**Description:** Endpoints de metadados, streaming e download por `slug`, com autorização (anônimo só vê `ready`; dono vê qualquer status) e redirect para URL pré-assinada.

**Technical actions:**

1. Criar `OptionalAuthGuard`/estender `JwtAuthGuard` para rotas `@Public()` que populam `request.user` quando há `Authorization: Bearer` válido, sem falhar se ausente (per `phase-03-videos/TD-07`)
2. Implementar `VideosService.findBySlugForViewer(slug, userId?)` — dono vê qualquer status; os demais só `ready`; caso contrário `VideoNotFoundException` (per `TD-07` Revision)
3. Implementar `getStreamUrl(slug, userId?)` e `getDownloadUrl(slug, userId?)` com `presignGetObject` (download com `ResponseContentDisposition: attachment; filename=...`) (per `TD-07`)
4. Adicionar a `VideosController` `GET /videos/:slug`, `GET /videos/:slug/stream` e `GET /videos/:slug/download` (`@Public()`, stream/download respondem `302` com `Location`), com OpenAPI

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` viewer rules (dono × anônimo × status) | Unit (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| Guard opcional (token válido, inválido, ausente) | E2E | `test/videos-playback.e2e-spec.ts` |
| Stream/download/metadados com MinIO real (Range → 206, `Content-Disposition`) | E2E | `test/videos-playback.e2e-spec.ts` |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- `GET /videos/:slug/stream` de um vídeo `ready` retorna `302` e a URL em `Location` atende `Range` com `206 Partial Content`
- `GET /videos/:slug/download` retorna `302` para URL cuja resposta traz `Content-Disposition: attachment`
- Anônimo acessando vídeo `draft`/`processing`/`error` recebe `404` `VIDEO_NOT_FOUND`; o dono recebe os metadados desse vídeo
- `GET /videos/:slug` de vídeo `ready` retorna `status`, `duration_seconds`, `metadata` e URL do thumbnail ou chave, sem exigir token

---

### SI-03.13 — Fluxo end-to-end com infraestrutura real

**Description:** Valida o ciclo completo sobre a stack real do Compose: iniciar → enviar partes → complete → worker → ready → stream/download.

**Technical actions:**

1. Criar `test/videos-flow.e2e-spec.ts` que gera um vídeo de fixture com `ffmpeg`, envia as partes via URLs pré-assinadas e conclui o upload
2. Aguardar (polling com timeout) o `video-worker` marcar `ready` e validar duração, thumbnail, `slug` único, stream (`Range`/206) e download
3. Cobrir o cenário de retomada (`list-parts` após envio parcial) e o de abort

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Ciclo completo upload → processamento → streaming/download | E2E (API + worker + MinIO + Redis reais) | `test/videos-flow.e2e-spec.ts` |

**Dependencies:** SI-03.11, SI-03.12

**Acceptance criteria:**

- O vídeo de fixture percorre `draft → processing → ready` observado no banco
- Duas execuções do fluxo geram `slug`s distintos
- Um upload interrompido pode ser retomado: `list-parts` lista as partes já enviadas e o complete conclui com sucesso
- Após `abort`, o vídeo `draft` deixa de existir e o multipart é cancelado

---

### SI-03.14 — Documentação: OpenAPI e CLAUDE.md

**Description:** Atualiza a documentação de IA e o contrato OpenAPI para refletir o estado real do código da fase.

**Technical actions:**

1. Regenerar o documento OpenAPI (`npm run openapi:export`) e garantir que os endpoints de vídeo estão presentes
2. Atualizar `nestjs-project/CLAUDE.md` e o `CLAUDE.md` raiz com a seção de vídeos: módulo, endpoints, fila `video-processing`, worker, storage, variáveis de ambiente e serviços do Compose
3. Preencher `docs/phases/phase-03-videos/progress.md` com status e testes por SI

**Tests:** _(empty — documentation; OpenAPI covered by existing `src/openapi-export.integration-spec.ts`)_

**Dependencies:** SI-03.13

**Acceptance criteria:**

- O OpenAPI exportado lista todos os endpoints do Data/API Contracts
- Toda referência a arquivos, endpoints e serviços nos `CLAUDE.md` existe no código
- `progress.md` registra status `done` e a suíte de testes de cada SI

---

## Technical Specifications

### Data Model

#### Video (`videos`)

| Column | Type | Constraints | Origin |
|--------|------|-------------|--------|
| `id` | uuid | PK, generated | TD-04 |
| `slug` | varchar(11) | UNIQUE, NOT NULL | TD-06 |
| `channel_id` | uuid | FK → `channels.id`, NOT NULL, indexed | context (vídeos pertencem a um canal) |
| `title` | varchar(100) | NOT NULL (default: nome do arquivo/`Untitled`) | project-plan |
| `status` | enum `draft`/`processing`/`ready`/`error` | NOT NULL, default `draft` | TD-08 |
| `content_type` | varchar(100) | NOT NULL | TD-02 |
| `size_bytes` | bigint | NOT NULL | TD-09 |
| `upload_id` | varchar | nullable (multipart upload id) | TD-02 |
| `source_key` | varchar | NOT NULL (`videos/{videoId}/source`) | TD-04 |
| `thumbnail_key` | varchar | nullable (`videos/{videoId}/thumbnail.jpg`) | TD-04 |
| `duration_seconds` | numeric(10,3) | nullable | TD-09 |
| `metadata` | jsonb | nullable (saída do ffprobe) | TD-09 |
| `failure_reason` | text | nullable | TD-08 |
| `processing_started_at` | timestamp | nullable (base da reconciliação) | TD-08 |
| `created_at` | timestamp | CreateDateColumn | convention |
| `updated_at` | timestamp | UpdateDateColumn | convention |

Índices: UNIQUE `slug`; `channel_id`; `(status, processing_started_at)` para a reconciliação. Relação: `Video` N:1 `Channel`.

### API Contracts

Todos os erros usam o envelope `{ statusCode, error, message }`. Autenticação: `Authorization: Bearer <accessToken>` salvo indicação.

#### POST /videos/uploads (SI-03.7)

- **Request body:** `{ "filename": string, "contentType": string, "sizeBytes": number, "title"?: string }`
- **Response 201:** `{ "videoId": uuid, "slug": string, "uploadId": string, "partSize": 104857600, "totalParts": number }`
- **Errors:** 400 `VALIDATION_ERROR`, 401, 404 `CHANNEL_NOT_FOUND`, 413 `VIDEO_TOO_LARGE`, 415 `UNSUPPORTED_CONTENT_TYPE`

#### POST /videos/:id/uploads/parts/sign (SI-03.7)

- **Request body:** `{ "partNumbers": number[] }`
- **Response 200:** `{ "urls": [{ "partNumber": number, "url": string }] }`
- **Errors:** 400, 401, 404 `VIDEO_NOT_FOUND`, 409 `INVALID_VIDEO_STATE`

#### GET /videos/:id/uploads/parts (SI-03.7)

- **Response 200:** `{ "parts": [{ "partNumber": number, "size": number, "etag": string }] }`
- **Errors:** 401, 404 `VIDEO_NOT_FOUND`, 409 `INVALID_VIDEO_STATE`

#### POST /videos/:id/uploads/complete (SI-03.8)

- **Request body:** `{ "parts": [{ "partNumber": number, "etag": string }] }`
- **Response 202:** `{ "id": uuid, "slug": string, "status": "processing" }`
- **Errors:** 400, 401, 404 `VIDEO_NOT_FOUND`, 409 `INVALID_VIDEO_STATE`, 422 `UPLOAD_INCOMPLETE`

#### DELETE /videos/:id/uploads (SI-03.7)

- **Response 204:** sem corpo
- **Errors:** 401, 404 `VIDEO_NOT_FOUND`, 409 `INVALID_VIDEO_STATE`

#### GET /videos/:slug (SI-03.12) — público

- **Response 200:** `{ "id", "slug", "title", "status", "contentType", "sizeBytes", "durationSeconds", "metadata", "thumbnailUrl", "createdAt" }`
- **Errors:** 404 `VIDEO_NOT_FOUND`

#### GET /videos/:slug/stream (SI-03.12) — público

- **Response 302:** header `Location` = URL pré-assinada de GET (suporta `Range`/206 no storage)
- **Errors:** 404 `VIDEO_NOT_FOUND`

#### GET /videos/:slug/download (SI-03.12) — público

- **Response 302:** header `Location` = URL pré-assinada com `ResponseContentDisposition: attachment`
- **Errors:** 404 `VIDEO_NOT_FOUND`

#### Validation Rules

- `filename`: string não vazia, máx. 255; `contentType`: string iniciando com `video/`; `sizeBytes`: inteiro > 0 e ≤ `MAX_VIDEO_SIZE_BYTES` (10GB); `title`: opcional, máx. 100
- `partNumbers`: array de 1 a 100 inteiros distintos entre 1 e `totalParts`
- `parts`: array não vazio; `partNumber` inteiro ≥ 1; `etag` string não vazia
- `:id` deve ser UUID; propriedades desconhecidas rejeitadas (`forbidNonWhitelisted`)

### Authorization Matrix

| Endpoint | Anônimo | Autenticado (dono) | Autenticado (não-dono) |
|----------|---------|--------------------|------------------------|
| POST /videos/uploads | 401 | permitido (usa o próprio canal) | permitido (próprio canal) |
| POST /videos/:id/uploads/parts/sign | 401 | permitido | 404 |
| GET /videos/:id/uploads/parts | 401 | permitido | 404 |
| POST /videos/:id/uploads/complete | 401 | permitido | 404 |
| DELETE /videos/:id/uploads | 401 | permitido | 404 |
| GET /videos/:slug | só `ready` | qualquer status | só `ready` |
| GET /videos/:slug/stream | só `ready` | qualquer status | só `ready` |
| GET /videos/:slug/download | só `ready` | qualquer status | só `ready` |

Vídeos em status não servido retornam `404 VIDEO_NOT_FOUND` a quem não é dono (TD-07 Revision). Regras de visibilidade rascunho/não listado ficam para a Fase 04.

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| `VALIDATION_ERROR` | 400 | Payload/param inválido (herdado) |
| `VIDEO_NOT_FOUND` | 404 | Vídeo inexistente, de outro canal (operações de dono) ou não servido ao solicitante |
| `CHANNEL_NOT_FOUND` | 404 | Usuário autenticado sem canal ao iniciar upload |
| `VIDEO_TOO_LARGE` | 413 | `sizeBytes` > 10GB (initiate) |
| `UNSUPPORTED_CONTENT_TYPE` | 415 | `contentType` fora de `video/*` |
| `INVALID_VIDEO_STATE` | 409 | Operação incompatível com o status atual (ex.: complete fora de `draft`) |
| `UPLOAD_INCOMPLETE` | 422 | Partes ausentes/inválidas ou `ContentLength` divergente de `size_bytes` no complete |

### Events/Messages

#### Queue `video-processing` — job `process-video`

- **Payload:** `{ "videoId": uuid }`
- **Producer:** `VideosService.completeUpload` (após commit) e `VideoReconciliationService`
- **Consumer:** `VideoProcessor` (container `video-worker`)
- **Trigger:** upload concluído (`status='processing'`) ou reconciliação de vídeo preso
- **Delivery semantics:** at-least-once; `jobId = videoId` (enqueue idempotente); `attempts: 3` com backoff exponencial; consumidor idempotente (ignora vídeo já `ready`); falha definitiva → `status='error'` + `failure_reason` (TD-01, TD-08)

#### Repeatable job `video-reconciliation`

- **Payload:** nenhum (scheduler via `upsertJobScheduler`)
- **Producer/Consumer:** `VideoReconciliationService` (worker)
- **Trigger:** a cada `RECONCILIATION_INTERVAL_MS`; seleciona vídeos `processing` há mais de `PROCESSING_STALE_AFTER_MINUTES` (15) e re-enfileira `process-video`
- **Delivery semantics:** idempotente por `jobId = videoId`

<!-- phase-a-complete -->

---

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (variáveis S3/Redis para os serviços do Compose)
│   ├── SI-03.5 — depends on SI-03.1, SI-03.2 (MinIO real para o StorageService)
│   └── SI-03.9 — depends on SI-03.2 (ffmpeg na imagem)
└── SI-03.3 — depends on SI-03.1 (entidade e migration)
    └── SI-03.4 — depends on SI-03.3 (exceções e slug)
SI-03.6 — depends on SI-03.3, SI-03.4, SI-03.5
└── SI-03.7 — depends on SI-03.6 (controller sobre o service)
    └── SI-03.8 — depends on SI-03.7 (complete + fila)
        └── SI-03.10 — depends on SI-03.8, SI-03.9 (worker consome a fila)
            ├── SI-03.11 — depends on SI-03.10 (reconciliação)
            └── SI-03.12 — depends on SI-03.10 (vídeo `ready` para stream/download)
SI-03.13 — depends on SI-03.11, SI-03.12 (fluxo completo)
└── SI-03.14 — depends on SI-03.13 (documentação final)
```

---

## Deliverables

- [ ] SI-03.1 — Dependências, namespaces de config e variáveis de ambiente
- [ ] SI-03.2 — Infraestrutura Docker: MinIO, Redis, FFmpeg e video-worker
- [ ] SI-03.3 — Entidade Video e migration
- [ ] SI-03.4 — Exceções de domínio e gerador de slug
- [ ] SI-03.5 — StorageService (S3/MinIO)
- [ ] SI-03.6 — VideosService: ciclo de upload
- [ ] SI-03.7 — Endpoints de upload resumível
- [ ] SI-03.8 — Conclusão do upload e enfileiramento
- [ ] SI-03.9 — Ferramentas de mídia do worker (ffprobe/ffmpeg)
- [ ] SI-03.10 — Worker e processador da fila
- [ ] SI-03.11 — Reconciliação de vídeos presos em `processing`
- [ ] SI-03.12 — Consulta, streaming e download
- [ ] SI-03.13 — Fluxo end-to-end com infraestrutura real
- [ ] SI-03.14 — Documentação: OpenAPI e CLAUDE.md

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && npm test`)
- [ ] E2E tests pass (`cd nestjs-project && npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && npm run lint`)
