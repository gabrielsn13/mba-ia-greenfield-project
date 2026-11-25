# phase-03-videos â€” Progress

**Status:** in_progress
**SIs:** 14/14 completed

### SI-03.1 â€” DependÃªncias, namespaces de config e variÃ¡veis de ambiente
- **Status:** completed
- **Tests:** 9 passing (src/config)
- **Observations:**
  - Libs instaladas: `@nestjs/bullmq` ^12.0.2, `bullmq` ^6.7.10, `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` ^3.1176.0.
  - `S3_PUBLIC_ENDPOINT` default `http://localhost:9000` (URL consumida pelo cliente fora do Docker, usada sÃ³ para assinar).
  - Lint do spec de env segue o padrÃ£o `any` prÃ©-existente (dÃ­vida de lint adiada pelo usuÃ¡rio).

### SI-03.2 â€” Infraestrutura Docker: MinIO, Redis, FFmpeg e video-worker
- **Status:** completed
- **Tests:** no tests (infra); verificado manualmente: stack sobe com healthchecks verdes, bucket `videos` criado, `ffprobe`/`ffmpeg` 5.1.9 no worker, Redis `appendonly yes`
- **Observations:**
  - As imagens `minio/minio` e `minio/mc` foram removidas do Docker Hub/quay.io (MinIO arquivou o projeto). Usada `insectai/minio` (fork pgsty/silo com `mc`), escolha do usuario; a API S3 e a mesma, nenhuma mudanca em TD-04 alem da imagem. Tag `latest` (versao 2026-09-16 no momento).
  - CORS: servidor MinIO configurado via `MINIO_API_CORS_ALLOW_ORIGIN=*` (nao ha `mc cors` por bucket); o MinIO ja expoe `ETag`.
  - Criado `src/worker.ts` minimo (`createApplicationContext`) e script `start:worker` para o container nao falhar; SI-03.10 o estende com o processador.
  - O servico `nestjs-api` continua com `tail -f` (padrao do projeto), por isso nao responde em `GET /` via curl no container.

### SI-03.3 â€” Entidade Video e migration
- **Status:** completed
- **Tests:** 7 videos (6 integraÃ§Ã£o da entidade + 1 mÃ³dulo), 2 migrations; suites src/videos, src/channels, src/auth, src/database: 105 passing; tsc exit 0
- **Observations:**
  - Colunas `size_bytes` (bigint) e `duration_seconds` (numeric) usam transformers para `number`.
  - `cleanAllTables` apaga `videos` apenas se a tabela existir (`to_regclass`).
  - `migrations.integration-spec.ts` nÃ£o remove enums; se sobrar `videos_status_enum`, resetar o schema antes.
  - O erro de lint em `create-test-data-source.ts` (tipo `Function`) Ã© prÃ©-existente.

### SI-03.4 â€” ExceÃ§Ãµes de domÃ­nio e gerador de slug
- **Status:** completed
- **Tests:** 16 passing (src/common + slug.util: 6 exceÃ§Ãµes novas via it.each no filtro, 2 do slug); tsc exit 0
- **Observations:**
  - `generateSlug()` em `src/videos/slug.util.ts` (11 chars base64url).
  - ExceÃ§Ãµes adicionadas em `domain.exception.ts` conforme o Error Catalog.

### SI-03.5 â€” StorageService (S3/MinIO)
- **Status:** completed
- **Tests:** 8 passing (5 integraÃ§Ã£o contra MinIO real, 2 chaves, 1 mÃ³dulo); tsc exit 0; eslint limpo em src/storage
- **Observations:**
  - `StorageModule` importa `ConfigModule.forFeature(storageConfig)` para ser autocontido.
  - `headObject` retorna `null` quando o objeto nÃ£o existe (404/NotFound).
  - O teste de integraÃ§Ã£o assina contra `S3_ENDPOINT` (`S3_PUBLIC_ENDPOINT` sobrescrito no teste), pois o header Host entra na assinatura e `localhost:9000` nÃ£o Ã© alcanÃ§Ã¡vel de dentro do container.
  - Verificados: multipart de 2 partes (5 MiB + 1 KiB), `Content-Disposition: attachment`, `206` com Range, abort e delete.

### SI-03.6 â€” VideosService: ciclo de upload (initiate, sign-parts, list-parts, abort)
- **Status:** completed
- **Tests:** 24 passing em src/videos (12 unit do service, 4 integraÃ§Ã£o com Postgres + MinIO reais, mais os testes anteriores); tsc exit 0; eslint limpo em src/videos
- **Observations:**
  - `initiateUpload` grava o rascunho (id gerado no app, `source_key` derivada) antes de criar o multipart; se o storage falhar, remove o rascunho.
  - Retry de slug (atÃ© 5) em violaÃ§Ã£o de UNIQUE na coluna `slug`.
  - `title` default = `filename` truncado em 100 caracteres.
  - `partNumbers` fora de 1..totalParts lanÃ§a `BadRequestException` (vira `VALIDATION_ERROR` 400 pelo filtro).
  - `VideosModule` importa `ConfigModule.forFeature(storageConfig)`, `StorageModule` e registra `Channel`.
  - `findOwnedVideo` faz join com o canal por `user_id`; nÃ£o-dono recebe `VideoNotFoundException`.

### SI-03.7 â€” Endpoints de upload resumÃ­vel
- **Status:** completed
- **Tests:** 6 passing (test/videos-upload.e2e-spec.ts, MinIO + Postgres reais)
- **Observations:** `VideosController` com 4 endpoints (initiate, sign, list parts, abort); DTOs `InitiateUploadDto`/`SignPartsDto`. `contentType` video/* validado no service (415), nÃ£o no DTO. Lint do e2e segue o mesmo padrÃ£o dos e2e existentes (pendÃªncia jÃ¡ adiada).

### SI-03.8 â€” ConclusÃ£o do upload e enfileiramento (complete)
- **Status:** completed
- **Tests:** 31 passing em src/videos (5 unit novos de `completeUpload`, 3 integraÃ§Ã£o com Postgres + MinIO + Redis reais); 9 e2e em test/videos-upload.e2e-spec.ts; tsc exit 0; eslint limpo em src/videos
- **Observations:**
  - `POST /videos/:id/uploads/complete` (202): completa o multipart, confere `contentLength` com `size_bytes` (senÃ£o 422 `UPLOAD_INCOMPLETE`), transiciona `draft â†’ processing` numa transaÃ§Ã£o com guard de status e sÃ³ entÃ£o enfileira (`jobId = videoId`, attempts 3, backoff exponencial 5s).
  - Repetir o complete retorna 409 `INVALID_VIDEO_STATE`; falha ao enfileirar apÃ³s o commit Ã© recuperada pela reconciliaÃ§Ã£o (SI-03.11).
  - `bullmq` 6 exige `ioredis` (peer opcional): adicionado como dependÃªncia.
  - Jest: `@nestjs/bullmq` e `@nestjs/bull-shared` sÃ£o ESM; `transformIgnorePatterns` e `tsconfig.jest.json` (allowJs) adicionados em package.json e test/jest-e2e.json.
  - Lint do e2e segue a pendÃªncia jÃ¡ adiada (`any` do supertest).

### SI-03.9 â€” Ferramentas de mÃ­dia do worker (ffprobe/ffmpeg)
- **Status:** completed
- **Tests:** 10 passing em src/video-worker (6 unit do parsing do ffprobe, 4 integraÃ§Ã£o com ffmpeg/ffprobe reais sobre vÃ­deo gerado via lavfi); tsc exit 0; eslint limpo
- **Observations:**
  - `MediaToolsService` usa `spawn` com timeout de 60s e limite de saÃ­da; falhas viram `MediaProcessingError` (erro tipado, nÃ£o HTTP).
  - `extractThumbnail` usa diretÃ³rio temporÃ¡rio sempre removido (`finally`) e retorna o JPEG em `Buffer`, pronto para upload pelo processor (SI-03.10).
  - ffmpeg/ffprobe jÃ¡ vÃªm instalados no `Dockerfile.dev`.

### SI-03.10 â€” Worker e processador da fila
- **Status:** completed
- **Tests:** 11 passing em src/video-worker novos (8 unit do `VideoProcessor`, 3 integraÃ§Ã£o com Postgres + MinIO + Redis + ffmpeg reais: ready com duraÃ§Ã£o/metadata/thumbnail, error apÃ³s 3 tentativas, reprocesso de `ready` sem alteraÃ§Ã£o); `StorageService` integraÃ§Ã£o segue verde; tsc exit 0; eslint limpo
- **Observations:**
  - `VideoProcessor` (`@Processor('video-processing')`) sÃ³ processa vÃ­deos em `processing`; qualquer outro status Ã© ignorado (idempotÃªncia). O update final tem guard `status = processing`.
  - `onFailed` marca `status='error'` e `failure_reason` (truncado em 1000) somente quando `attemptsMade >= attempts`.
  - Bootstrap mantido em `src/worker.ts` (script `start:worker` jÃ¡ existente), agora com `WorkerRootModule` = `AppModule` + `VideoWorkerModule`; a API nÃ£o registra o processor, sÃ³ o worker.
  - `StorageService` ganhou `putObject` e `presignInternalGetObject`: o ffmpeg do worker precisa de URL assinada para o endpoint interno (`minio:9000`), pois o endpoint pÃºblico (`localhost:9000`) nÃ£o Ã© alcanÃ§Ã¡vel de dentro do container.
  - Mensagens de erro do ffprobe/ffmpeg tÃªm URLs redigidas (`<url>`) para nÃ£o vazar assinatura em `failure_reason`.
  - DivergÃªncia do plano: `src/main.worker.ts` nÃ£o foi criado; reaproveitado `src/worker.ts`.

### SI-03.11 — Reconciliação de vídeos presos em `processing`
- **Status:** completed
- **Tests:** 4 integração passing com Postgres + Redis reais (scheduler registrado; só processing > 15 min é re-enfileirado; duas execuções não duplicam jobs; job ailed retido é substituído) + 1 unit novo no processor; tsc exit 0; eslint limpo
- **Observations:**
  - `VideoReconciliationService` registra o job scheduler `video-reconciliation` em `onApplicationBootstrap` e só existe no worker (`VideoWorkerModule`).
  - O scheduler publica jobs na mesma fila; `VideoProcessor.process` roteia por `job.name` e delega ao serviço; `onFailed` ignora jobs que não são `process-video`.
  - Idempotência via `jobId = videoId`; um job `failed` retido (removeOnFail) é removido antes do `add`, pois senão o `add` seria no-op.

### SI-03.12 â€” Consulta, streaming e download
- **Status:** completed
- **Tests:** 30 unit passing (videos.service.spec com regras de visualizacao + jwt-auth.guard.spec) + 10 e2e passing com MinIO/Postgres reais (stream 302 + Range 206, download attachment, 404 anonimo para draft/processing/error, dono ve qualquer status, outro usuario, token invalido tratado como anonimo, metadados publicos, slug inexistente); tsc exit 0; eslint limpo
- **Observations:**
  - Novo decorator `@OptionalAuth()` e suporte no `JwtAuthGuard`: token ausente/invalido segue como anonimo; token valido popula `request.user`.
  - `GET /videos/:slug` expoe so `ready` a nao-donos; o dono ve qualquer status. Stream/download tambem escondem `draft` (ainda nao ha objeto).
  - Stream e download respondem 302 para URL pre-assinada do MinIO (Range/206 servido pelo storage); o nome do arquivo no download e derivado de slug + content-type.

### SI-03.13 — Fluxo end-to-end com infraestrutura real
- **Status:** completed
- **Tests:** 4 e2e passing com API + video-worker + MinIO + Redis + Postgres reais (draft -> processing -> ready com duracao/thumbnail, stream Range 206 e download; slugs distintos em duas execucoes; retomada via list-parts; abort remove draft e cancela multipart); tsc exit 0; eslint limpo
- **Observations:**
  - Fixture gerado com ffmpeg (lavfi testsrc, 2 s) em tempo de teste; exige o container video-worker rodando.
  - Retomada coberta com upload de parte unica (partSize fixo de 100 MB inviabiliza multiplas partes com fixture pequeno).

### SI-03.14 — Documentação: OpenAPI e CLAUDE.md
- **Status:** completed
- **Tests:** no tests (cobertura do OpenAPI pelo `src/openapi-export.integration-spec.ts` existente)
- **Observations:**
  - `openapi.json` regenerado com `npm run openapi:export`; os 8 endpoints de `/videos` estao presentes.
  - Secoes "Videos (Phase 03)" adicionadas em `nestjs-project/CLAUDE.md` e `CLAUDE.md` raiz, citando apenas modulos, endpoints, servicos e variaveis existentes.
  - Suite completa: `npm test --runInBand` 225 passando (`migrations.integration-spec` so passa a partir de schema limpo, pois nao remove os enums; pre-existente), `npm run test:e2e -- --runInBand` 75/75, tsc exit 0.
  - Lint: a divida pre-existente (`any` em specs/e2e e outros) foi tratada em PR separado (#20): codigo de `src` corrigido e, para arquivos de teste (`*.spec.ts`, `*.integration-spec.ts`, `*.e2e-spec.ts`), um override em `nestjs-project/eslint.config.mjs` desliga `no-unsafe-member-access`, `no-unsafe-assignment`, `no-unsafe-return`, `no-unsafe-call`, `unbound-method` e `require-await` (ruido do supertest/jest). Resultado: `npm run lint` com 0 erros e 40 warnings pre-existentes (majoritariamente `no-unsafe-argument`).
  - Verificacao final na `dev`: `npm test --runInBand` 227/227 (schema limpo), `npm run test:e2e --runInBand` 75/75, `npx tsc --noEmit` exit 0.
