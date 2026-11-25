# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 10/14 completed

### SI-03.1 — Dependências, namespaces de config e variáveis de ambiente
- **Status:** completed
- **Tests:** 9 passing (src/config)
- **Observations:**
  - Libs instaladas: `@nestjs/bullmq` ^12.0.2, `bullmq` ^6.7.10, `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` ^3.1176.0.
  - `S3_PUBLIC_ENDPOINT` default `http://localhost:9000` (URL consumida pelo cliente fora do Docker, usada só para assinar).
  - Lint do spec de env segue o padrão `any` pré-existente (dívida de lint adiada pelo usuário).

### SI-03.2 — Infraestrutura Docker: MinIO, Redis, FFmpeg e video-worker
- **Status:** completed
- **Tests:** no tests (infra); verificado manualmente: stack sobe com healthchecks verdes, bucket `videos` criado, `ffprobe`/`ffmpeg` 5.1.9 no worker, Redis `appendonly yes`
- **Observations:**
  - As imagens `minio/minio` e `minio/mc` foram removidas do Docker Hub/quay.io (MinIO arquivou o projeto). Usada `insectai/minio` (fork pgsty/silo com `mc`), escolha do usuario; a API S3 e a mesma, nenhuma mudanca em TD-04 alem da imagem. Tag `latest` (versao 2026-09-16 no momento).
  - CORS: servidor MinIO configurado via `MINIO_API_CORS_ALLOW_ORIGIN=*` (nao ha `mc cors` por bucket); o MinIO ja expoe `ETag`.
  - Criado `src/worker.ts` minimo (`createApplicationContext`) e script `start:worker` para o container nao falhar; SI-03.10 o estende com o processador.
  - O servico `nestjs-api` continua com `tail -f` (padrao do projeto), por isso nao responde em `GET /` via curl no container.

### SI-03.3 — Entidade Video e migration
- **Status:** completed
- **Tests:** 7 videos (6 integração da entidade + 1 módulo), 2 migrations; suites src/videos, src/channels, src/auth, src/database: 105 passing; tsc exit 0
- **Observations:**
  - Colunas `size_bytes` (bigint) e `duration_seconds` (numeric) usam transformers para `number`.
  - `cleanAllTables` apaga `videos` apenas se a tabela existir (`to_regclass`).
  - `migrations.integration-spec.ts` não remove enums; se sobrar `videos_status_enum`, resetar o schema antes.
  - O erro de lint em `create-test-data-source.ts` (tipo `Function`) é pré-existente.

### SI-03.4 — Exceções de domínio e gerador de slug
- **Status:** completed
- **Tests:** 16 passing (src/common + slug.util: 6 exceções novas via it.each no filtro, 2 do slug); tsc exit 0
- **Observations:**
  - `generateSlug()` em `src/videos/slug.util.ts` (11 chars base64url).
  - Exceções adicionadas em `domain.exception.ts` conforme o Error Catalog.

### SI-03.5 — StorageService (S3/MinIO)
- **Status:** completed
- **Tests:** 8 passing (5 integração contra MinIO real, 2 chaves, 1 módulo); tsc exit 0; eslint limpo em src/storage
- **Observations:**
  - `StorageModule` importa `ConfigModule.forFeature(storageConfig)` para ser autocontido.
  - `headObject` retorna `null` quando o objeto não existe (404/NotFound).
  - O teste de integração assina contra `S3_ENDPOINT` (`S3_PUBLIC_ENDPOINT` sobrescrito no teste), pois o header Host entra na assinatura e `localhost:9000` não é alcançável de dentro do container.
  - Verificados: multipart de 2 partes (5 MiB + 1 KiB), `Content-Disposition: attachment`, `206` com Range, abort e delete.

### SI-03.6 — VideosService: ciclo de upload (initiate, sign-parts, list-parts, abort)
- **Status:** completed
- **Tests:** 24 passing em src/videos (12 unit do service, 4 integração com Postgres + MinIO reais, mais os testes anteriores); tsc exit 0; eslint limpo em src/videos
- **Observations:**
  - `initiateUpload` grava o rascunho (id gerado no app, `source_key` derivada) antes de criar o multipart; se o storage falhar, remove o rascunho.
  - Retry de slug (até 5) em violação de UNIQUE na coluna `slug`.
  - `title` default = `filename` truncado em 100 caracteres.
  - `partNumbers` fora de 1..totalParts lança `BadRequestException` (vira `VALIDATION_ERROR` 400 pelo filtro).
  - `VideosModule` importa `ConfigModule.forFeature(storageConfig)`, `StorageModule` e registra `Channel`.
  - `findOwnedVideo` faz join com o canal por `user_id`; não-dono recebe `VideoNotFoundException`.

### SI-03.7 — Endpoints de upload resumível
- **Status:** completed
- **Tests:** 6 passing (test/videos-upload.e2e-spec.ts, MinIO + Postgres reais)
- **Observations:** `VideosController` com 4 endpoints (initiate, sign, list parts, abort); DTOs `InitiateUploadDto`/`SignPartsDto`. `contentType` video/* validado no service (415), não no DTO. Lint do e2e segue o mesmo padrão dos e2e existentes (pendência já adiada).

### SI-03.8 — Conclusão do upload e enfileiramento (complete)
- **Status:** completed
- **Tests:** 31 passing em src/videos (5 unit novos de `completeUpload`, 3 integração com Postgres + MinIO + Redis reais); 9 e2e em test/videos-upload.e2e-spec.ts; tsc exit 0; eslint limpo em src/videos
- **Observations:**
  - `POST /videos/:id/uploads/complete` (202): completa o multipart, confere `contentLength` com `size_bytes` (senão 422 `UPLOAD_INCOMPLETE`), transiciona `draft → processing` numa transação com guard de status e só então enfileira (`jobId = videoId`, attempts 3, backoff exponencial 5s).
  - Repetir o complete retorna 409 `INVALID_VIDEO_STATE`; falha ao enfileirar após o commit é recuperada pela reconciliação (SI-03.11).
  - `bullmq` 6 exige `ioredis` (peer opcional): adicionado como dependência.
  - Jest: `@nestjs/bullmq` e `@nestjs/bull-shared` são ESM; `transformIgnorePatterns` e `tsconfig.jest.json` (allowJs) adicionados em package.json e test/jest-e2e.json.
  - Lint do e2e segue a pendência já adiada (`any` do supertest).

### SI-03.9 — Ferramentas de mídia do worker (ffprobe/ffmpeg)
- **Status:** completed
- **Tests:** 10 passing em src/video-worker (6 unit do parsing do ffprobe, 4 integração com ffmpeg/ffprobe reais sobre vídeo gerado via lavfi); tsc exit 0; eslint limpo
- **Observations:**
  - `MediaToolsService` usa `spawn` com timeout de 60s e limite de saída; falhas viram `MediaProcessingError` (erro tipado, não HTTP).
  - `extractThumbnail` usa diretório temporário sempre removido (`finally`) e retorna o JPEG em `Buffer`, pronto para upload pelo processor (SI-03.10).
  - ffmpeg/ffprobe já vêm instalados no `Dockerfile.dev`.

### SI-03.10 — Worker e processador da fila
- **Status:** completed
- **Tests:** 11 passing em src/video-worker novos (8 unit do `VideoProcessor`, 3 integração com Postgres + MinIO + Redis + ffmpeg reais: ready com duração/metadata/thumbnail, error após 3 tentativas, reprocesso de `ready` sem alteração); `StorageService` integração segue verde; tsc exit 0; eslint limpo
- **Observations:**
  - `VideoProcessor` (`@Processor('video-processing')`) só processa vídeos em `processing`; qualquer outro status é ignorado (idempotência). O update final tem guard `status = processing`.
  - `onFailed` marca `status='error'` e `failure_reason` (truncado em 1000) somente quando `attemptsMade >= attempts`.
  - Bootstrap mantido em `src/worker.ts` (script `start:worker` já existente), agora com `WorkerRootModule` = `AppModule` + `VideoWorkerModule`; a API não registra o processor, só o worker.
  - `StorageService` ganhou `putObject` e `presignInternalGetObject`: o ffmpeg do worker precisa de URL assinada para o endpoint interno (`minio:9000`), pois o endpoint público (`localhost:9000`) não é alcançável de dentro do container.
  - Mensagens de erro do ffprobe/ffmpeg têm URLs redigidas (`<url>`) para não vazar assinatura em `failure_reason`.
  - Divergência do plano: `src/main.worker.ts` não foi criado; reaproveitado `src/worker.ts`.

### SI-03.11 — Reconciliação de vídeos presos em `processing`
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.12 — Consulta, streaming e download
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.13 — Fluxo end-to-end com infraestrutura real
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.14 — Documentação: OpenAPI e CLAUDE.md
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
