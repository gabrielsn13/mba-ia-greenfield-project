---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload.e2e-spec.ts
---

# Videos Upload Test Plan

## Application Overview

Endpoints autenticados de upload resumível: iniciar (cria o vídeo `draft` e o multipart), assinar partes, listar partes e abortar. O arquivo vai direto ao MinIO por URLs pré-assinadas; a API nunca recebe o corpo do vídeo.

## Test Scenarios

### 1. POST /videos/uploads

**Setup:** truncar tabelas de teste (videos, channels, users); bootstrap do `AppModule` com Postgres e MinIO reais; usuário confirmado com canal e access token.

#### 1.1. initiate-happy-path

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. POST /videos/uploads com Bearer do dono e body `{ filename: "a.mp4", contentType: "video/mp4", sizeBytes: 250000000 }`
    - expect: status 201 com `videoId`, `slug`, `uploadId`, `partSize` = 104857600, `totalParts` = 3
    - expect: linha em `videos` com `status = 'draft'`, `channel_id` do canal do usuário e `upload_id` preenchido

#### 1.2. initiate-rejections

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. POST /videos/uploads sem Authorization
    - expect: status 401
  2. POST /videos/uploads com `sizeBytes` = 10000000001
    - expect: status 413 com `error: "VIDEO_TOO_LARGE"`
  3. POST /videos/uploads com `contentType: "application/pdf"`
    - expect: status 415 com `error: "UNSUPPORTED_CONTENT_TYPE"`
    - expect: nenhuma linha criada em `videos`

#### 1.3. initiate-validation

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. POST /videos/uploads com `sizeBytes: 0`, `filename` vazio e propriedade desconhecida `foo`
    - expect: status 400 com `error: "VALIDATION_ERROR"` e mensagens por campo

### 2. POST /videos/:id/uploads/parts/sign

**Setup:** vídeo `draft` criado via initiate pelo dono.

#### 2.1. sign-parts-usable-urls

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. POST /videos/:id/uploads/parts/sign com `{ partNumbers: [1] }`
    - expect: status 200 com `urls[0].partNumber = 1` e `url` não vazia
  2. PUT do conteúdo da parte diretamente na `url` retornada
    - expect: resposta do MinIO 200 com header `ETag`
  3. GET /videos/:id/uploads/parts
    - expect: status 200 com a parte 1 listada com `etag` e `size`

### 3. Autorização por dono

**Setup:** vídeo `draft` do usuário A; segundo usuário B autenticado.

#### 3.1. non-owner-gets-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. Usuário B chama POST /videos/:id/uploads/parts/sign, GET /videos/:id/uploads/parts e DELETE /videos/:id/uploads
    - expect: cada chamada retorna 404 com `error: "VIDEO_NOT_FOUND"`

### 4. DELETE /videos/:id/uploads

**Setup:** vídeo `draft` do dono.

#### 4.1. abort-removes-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. DELETE /videos/:id/uploads com Bearer do dono
    - expect: status 204 sem corpo
    - expect: linha removida de `videos` e multipart cancelado no MinIO
