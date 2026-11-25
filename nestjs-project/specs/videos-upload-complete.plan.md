---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-complete.e2e-spec.ts
---

# Videos Upload Complete Test Plan

## Application Overview

Conclusão do upload: a API finaliza o multipart, confere o objeto no storage, move o vídeo para `processing` e enfileira o job `process-video` na fila `video-processing` (Redis real).

## Test Scenarios

### 1. POST /videos/:id/uploads/complete

**Setup:** truncar tabelas; Postgres, MinIO e Redis reais; esvaziar a fila `video-processing`; dono autenticado com vídeo `draft` e partes enviadas via URLs pré-assinadas.

#### 1.1. complete-happy-path

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. POST /videos/:id/uploads/complete com `{ parts: [{ partNumber, etag }] }` das partes enviadas
    - expect: status 202 com `status: "processing"` e `slug`
    - expect: vídeo `processing` no banco com `processing_started_at` preenchido
    - expect: exatamente um job `process-video` na fila com `jobId` = `videoId`
  2. Repetir a chamada de complete
    - expect: status 409 com `error: "INVALID_VIDEO_STATE"`
    - expect: ainda um único job para o `videoId`

#### 1.2. complete-invalid-state

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. Colocar o vídeo em `ready` no banco e chamar POST /videos/:id/uploads/complete
    - expect: status 409 com `error: "INVALID_VIDEO_STATE"`

#### 1.3. complete-size-mismatch

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. Iniciar upload declarando `sizeBytes` maior que o enviado, enviar a parte e chamar complete
    - expect: status 422 com `error: "UPLOAD_INCOMPLETE"`
    - expect: vídeo permanece `draft` e nenhum job enfileirado

#### 1.4. complete-validation-and-auth

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. POST sem Authorization
    - expect: status 401
  2. POST com `parts: []`
    - expect: status 400 com `error: "VALIDATION_ERROR"`
  3. POST por usuário que não é dono
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
