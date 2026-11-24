# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/14 completed

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
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.4 — Exceções de domínio e gerador de slug
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.5 — StorageService (S3/MinIO)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.6 — VideosService: ciclo de upload (initiate, sign-parts, list-parts, abort)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.7 — Endpoints de upload resumível
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.8 — Conclusão do upload e enfileiramento (complete)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.9 — Ferramentas de mídia do worker (ffprobe/ffmpeg)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.10 — Worker e processador da fila
- **Status:** pending
- **Tests:** pending
- **Observations:** none

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
