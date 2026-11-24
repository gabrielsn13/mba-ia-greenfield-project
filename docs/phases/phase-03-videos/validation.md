---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 3
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-24T14:05:13-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-24T14:02:29-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "Who may stream/download a video before Phase 04 visibility exists"
  - id: AMB-2
    status: open
    summary: "Resumable upload API surface, size cap and accepted types undefined"
  - id: AMB-3
    status: open
    summary: "Mechanism to recover lost enqueue / stuck processing is deferred to plan"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — Capabilities "Reprodução via streaming" and "Download do vídeo pelo usuário" plus TD-07 ("authorize, then redirect to a pre-signed GET") do not say who is authorized, nor for which statuses. Visibility (public/unlisted) and the draft -> publication flow belong to Phase 04 (Neighbors), and the platform premise is that anonymous users can watch. Explicit choice: define in plan-resolve the Phase 03 rule (e.g., owner-only for any status vs. anyone for `ready`; behavior for `draft`/`processing`/`error`; anonymous allowed or not) and record it as a revision of TD-07 so the Authorization Matrix can be built.
- **AMB-2** — Project plan "Pontos de Atenção" requires upload to "permita retomar em caso de falha de conexão", and the challenge fixes 10GB, but TD-02 only says resumability comes "for free" from multipart. The API surface is not defined: endpoints to initiate, re-sign parts, list uploaded parts, complete and abort; part size / part count; the 10GB cap enforcement and accepted media types (video/*). Explicit choice: define in plan-resolve (revision of TD-02) the endpoint set, part-size policy, max size validation and allowed content types.
- **AMB-3** — TD-01 and TD-08 state that the lost-enqueue window (enqueue after DB commit is not atomic) and stuck `processing` rows are "a plan-level mitigation", but no mechanism is chosen. Explicit choice: define in plan-resolve (revision of TD-08) the reconciliation strategy (e.g., scheduled re-enqueue of `processing` videos older than N minutes, idempotent by videoId) and the job id / retry parameters.

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

_No issues resolved yet._
