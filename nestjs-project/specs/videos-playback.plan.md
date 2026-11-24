---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-playback.e2e-spec.ts
---

# Videos Playback Test Plan

## Application Overview

Consulta, streaming e download por `slug`. Rotas públicas com JWT opcional: o dono acessa qualquer status; os demais só vídeos `ready`. Stream e download respondem 302 para URL pré-assinada do MinIO.

## Test Scenarios

### 1. GET /videos/:slug/stream

**Setup:** truncar tabelas; MinIO real; vídeo `ready` com objeto de fonte real (fixture gerado com ffmpeg) e vídeos em `draft`, `processing` e `error`.

#### 1.1. stream-redirect-supports-range

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. GET /videos/:slug/stream sem Authorization, sem seguir redirect
    - expect: status 302 com header `Location` apontando para o MinIO
  2. GET na `Location` com `Range: bytes=0-1023`
    - expect: status 206 com `Content-Range` e 1024 bytes

### 2. GET /videos/:slug/download

**Setup:** mesmo vídeo `ready`.

#### 2.1. download-attachment

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. GET /videos/:slug/download sem seguir redirect
    - expect: status 302 com `Location`
  2. GET na `Location`
    - expect: status 200 com `Content-Disposition` iniciando em `attachment`

### 3. Visibilidade por status

**Setup:** vídeos do usuário A em cada status; usuário A autenticado e requisição anônima.

#### 3.1. anonymous-only-ready

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. Anônimo chama GET /videos/:slug, /stream e /download de vídeos `draft`, `processing` e `error`
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"` em todas
  2. Dono chama GET /videos/:slug do vídeo `processing`
    - expect: status 200 com `status: "processing"`
  3. Chamada com token inválido a vídeo `ready`
    - expect: tratada como anônima (302/200), sem 401

### 4. GET /videos/:slug

**Setup:** vídeo `ready` com `duration_seconds`, `metadata` e `thumbnail_key`.

#### 4.1. get-metadata-public

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-24T17:41:00Z

**Steps:**
  1. GET /videos/:slug sem Authorization
    - expect: status 200 com `status: "ready"`, `durationSeconds`, `metadata` e `thumbnailUrl`
  2. GET /videos/slug-inexistente
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
