---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-24T09:44:49-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-24T14:02:29-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-24T09:44:49-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-24T09:44:49-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-11-24T09:44:49-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-24T09:44:48-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ Challenge statement: frontend video UI is out of scope (backend-only delivery).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (API, video worker, Compose infra)

**Deferred subprojects:** `next-frontend/` — no video UI in this phase.

**Sequencing notes:** Depende de: Fase 01, Fase 02. Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A | — |
| phase-03-videos/TD-02 | phase | Cross-layer | Large-File Upload Strategy (up to 10GB) | decided | A | — |
| phase-03-videos/TD-03 | phase | Backend | Upload Completion Signal | decided | A | — |
| phase-03-videos/TD-04 | phase | Backend | Storage Client, Endpoints and Key Layout | decided | A | — |
| phase-03-videos/TD-05 | phase | Backend | Video Worker Deployment and Media Tooling | decided | A | — |
| phase-03-videos/TD-06 | phase | Backend | Unique Video URL Identifier | decided | A | — |
| phase-03-videos/TD-07 | phase | Cross-layer | Streaming and Download Delivery | decided | A | — |
| phase-03-videos/TD-08 | phase | Backend | Video Status Lifecycle and Processing Failure Handling | decided | A | — |
| phase-03-videos/TD-09 | phase | Backend | Metadata Persistence Shape and Thumbnail Frame | decided | A | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-04 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-08, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-09 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** official NestJS module, declarative retry/backoff, and a dedicated broker that matches the target architecture; the lost-enqueue window is a known trade-off the plan can close (e.g., enqueue after commit + re-enqueue of stale `processing` videos). Option C is a legitimate alternative if avoiding new infra outweighs the architecture fit.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** it is the only option that both keeps the API out of the data path and fits 10GB under S3/MinIO limits, with resumability for free; Option B fails the size requirement and Option C reintroduces the load the challenge forbids.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** the client must complete the multipart upload regardless, so the API call is the natural, verifiable and testable completion point; storage events add moving parts without removing that requirement. Abandoned drafts are handled by the lifecycle policy in TD-08.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** keeps the storage layer provider-neutral (MinIO now, S3 later) and exposes the exact multipart/presign primitives TD-02 needs. Key layout is keyed by `videoId` (UUID), independent from the public slug (TD-06), so the slug can change without moving objects.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** keeps a separate process (as the diagram requires) while reusing the existing domain code; `fluent-ffmpeg` is deliberately not used because it is marked deprecated on npm ("Package no longer supported"), so a thin `spawn` wrapper is safer than a dead dependency.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** a DB-enforced UNIQUE `slug` satisfies "sem conflito" deterministically, avoids the nanoid engine/ESM mismatch with Node 25.6, and adds no dependency.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** storage already implements Range/206 and attachment disposition; redirecting keeps the API out of the data path while preserving per-request authorization.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** satisfies the required lifecycle with the least schema, relies on proven queue retry semantics, and idempotent processing handles duplicate or retried jobs safely; reconciliation of stuck `processing` rows is a plan-level mitigation tied to the TD-01 enqueue trade-off.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** duration is the one value later phases need to query and display, so it is typed; remaining probe output is kept as JSONB to avoid schema churn.
**Libraries:** —

## Inherited Decisions Detail

_(backend TDs from prior phases only; frontend-slice TDs are not applicable to this backend phase)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The roadmap explicitly calls for auth, email, and storage in upcoming phases.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only (deliberately diverged from `@nestjs/passport` recommendation). Global JWT guard protects routes.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — documented NestJS approach; decorators used across the project.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — simple `{ statusCode, error, message }` format with domain codes.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — native NestJS integration; scope rate limiting via module-level `APP_GUARD` with `@SkipThrottle()` for exemptions.

**Libraries:** `@nestjs/throttler@^6.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` not initialized in this phase. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

Source: `testing-guide-nestjs-project` skill, §3 Feature Implementation Checklist.

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (mock repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration |
| Service with configured lib | Unit with real lib and test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter — here real MinIO/Redis from Compose |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — no unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard | E2E (+ Unit if complex internal logic) |
| Pipe | Unit |
| Interceptor | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
