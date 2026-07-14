# Implementation-Readiness Audit
## attune PRD Version 1.6

**Audit date:** 14 July 2026  
**Audited source supplied by user:** `webxr-spatial-audio-quest3-prd-v1.3.md`  
**Corrected specification:** `attune-prd-v1.6.md`  
**Target:** Meta Quest 3, Meta Quest Browser, WebXR `immersive-ar`

---

## 1. Executive verdict

### 1.1 Verdict on the supplied Version 1.3

**Version 1.3 should not be certified as independently implementation-ready.** It was unusually detailed, but a coding agent following it literally could still encounter incompatible or unsafe implementations. The blocking issues included pinned-library API mismatches, a bootstrap verification gate that could not be satisfied at the stage where it was required, non-compilable shared value declarations, ambiguity in source/target audio identity during interrupted transitions, an unreachable desktop-debug path when WebXR was absent, and insufficient protection from queued events on the reusable media element.

### 1.2 Verdict on corrected Version 1.6

**Version 1.6 is implementation-ready for WP-0 through WP-6 for a competent coding agent that follows the normative requirements, owns the specified paths, and has ordinary Node/TypeScript build tools.** It is detailed enough for separate agents to implement packages idempotently against a frozen contract baseline without inventing product behavior, architecture, state transitions, concurrency policy, resource ownership, or repository structure.

**WP-7 and a production-complete claim remain conditional.** They require real metadata, an audit of the actual audio assets, an installation-specific true-north procedure, a selected HTTPS host, and recorded tests on a physical Meta Quest 3. These are external evidence gates, not omissions in the software design.

### 1.3 Necessary qualification of “any coding agent”

No PRD can guarantee successful output from literally any agent, byte-identical source from different agents, access to unavailable hardware, or correctness from an agent that ignores normative constraints. The strongest defensible claim is:

> A competent coding agent can implement WP-0 through WP-6 independently and idempotently, and a second agent can mechanically verify the result, without making unresolved product or architecture decisions.

The PRD defines idempotence as equivalent dependency resolution, repository state, observable behavior, asynchronous-result handling, generated assets, and runtime resource counts—not identical formatting or source text.

---

## 2. Readiness matrix

| Area | Result | Audit conclusion |
|---|---|---|
| Product goal and MVP boundary | Pass | The listening experience, fixed geographic frame, live headset listener, map interaction, and deliberate non-goals are explicit. |
| Static-first architecture | Pass | Vite, strict TypeScript, Three.js, WebXR, Web Audio, static JSON, and static HTTPS hosting are fixed; no backend or framework choice remains open. |
| User journeys | Pass | Preflight, location, XR entry, calibration, map selection, playback, recovery, exit, re-entry, and desktop debug are sequenced. |
| Geographic computation | Pass | WGS 84 input semantics, Haversine distance, initial bearing, cardinal mapping, edge cases, map projection, and XR placement are deterministic. |
| WebXR lifecycle | Pass | Session request options, transient-gesture ownership, reference-space fallback, valid-frame gating, handlers, calibration, reset, teardown, and re-entry are normative. |
| Spatial audio graph | Pass | One media element, one media source node, one listener, one positional source, one panner, gain behavior, HRTF settings, and disposal rules are fixed. |
| Audio concurrency | Pass after correction | Selection generations, target-versus-loaded identity, reset/load ordering, captured play-promise confirmation, queued-event rejection, timers, fades, Pause/Stop, and A→B→C races are specified. |
| State management | Pass | The reducer, legal actions, generation ownership, non-reentrant FIFO dispatch, snapshots, errors, and stale-result filtering are defined. |
| Map UI | Pass | Canvas dimensions, physical plane dimensions, marker/ring models, controls, hit testing, overlap cycling, input priority, and redraw triggers are fixed. |
| Desktop debug | Pass after correction | `?debug=1` works with `navigator.xr` absent, uses the production contracts, never requests an XR session, and exposes deterministic counters and fixtures. |
| Content validation | Pass for fixtures; externally gated for real content | Envelope/record validation, normalized output, diagnostic order, adapter boundary, deterministic fixtures, path containment, and CLI behavior are specified. |
| Toolchain and CI | Pass | Exact package versions, lockfile policy, strict compiler options, scripts, runner image, immutable action commits, and clean-checkout checks are fixed. |
| Parallel-agent ownership | Pass | WP ownership paths, dependencies, handoffs, prohibited duplication, contract-freeze gate, pre-integration gate, and rerun behavior are defined. |
| Runtime idempotence | Pass | Duplicate initialize/start/end/play/pause/stop/dispose semantics and resource ceilings are explicit and testable. |
| Privacy and deployment | Pass as a specification | Coordinate handling, logging restrictions, CORS/range/MIME/header checks, HTTPS, and caching requirements are present. |
| Quest 3 production acceptance | Conditional | Physical headset, browser/OS version, build commit, cardinal listening, controller, lifecycle, and performance evidence remain required. |

---

## 3. Blocking defects found in Version 1.3 and resolved in Version 1.6

### 3.1 Pinned Three.js API mismatch

Version 1.3 described `renderer.xr.getCamera(appCamera)`. The pinned Three.js release exposes a no-argument `getCamera()` method. A literal implementation would fail type checking. Version 1.6 uses `renderer.xr.getCamera()` and separately defines the stable application camera as the only `AudioListener` parent.

### 3.2 Incomplete XR feature request

The earlier session request and subsequent reference-space behavior were not fully aligned. Version 1.6 fixes the request to:

```ts
navigator.xr.requestSession('immersive-ar', {
  optionalFeatures: ['local-floor'],
});
```

It then requests `local-floor`, falls back to the default immersive `local` reference space, and installs the selected space through Three.js.

### 3.3 Impossible WP-0 verification gate

The previous bootstrap could require verification of files or behavioral modules assigned to later work packages. Version 1.6 gives WP-0 a functional minimum validator, deterministic fixture, adapter stub, smoke test, shared types, and test harness. Behavioral tests for WP-1 through WP-5 are explicitly deferred rather than faked.

### 3.4 Shared contracts that did not compile as `.ts`

The earlier appendix used implementation-less exported function declarations in a normal TypeScript source contract. A literal `src/domain/types.ts` implementation would fail. Version 1.6 replaces them with function type aliases and requires concrete exports from the owning implementation modules.

### 3.5 Target-versus-loaded audio identity race

During an audible A→B switch, B could become the selected target while A remained loaded during fade-out. A Pause, Stop, or later C selection could therefore leave enough ambiguity for A to be replayed under B or C. Version 1.6 separately owns `targetRecording`, `targetPosition`, and `loadedRecordingId`; interrupted pre-assignment transitions reset A, clear loaded identity, retain the newer target, and require a later Play to execute the target’s idle load path.

### 3.6 Reusable-media queued-event race

Generation checks alone are insufficient because media events carry no application generation and an event queued for a previous load can reach later listeners. Version 1.6 now:

1. Removes the stored handler set.
2. Cancels timers and gain automation.
3. Pauses the element.
4. Removes `src` and calls the HTML media-element load algorithm once to reset.
5. Attaches a generation/expected-URL handler set.
6. Assigns the target URL and calls `load()` once for that target.
7. Permits only the captured current `media.play()` promise—not `playing` or `canplay`—to confirm playback.
8. Accepts `ended` only when the current URL/identity matches and `media.ended` is true.

### 3.7 Unreachable non-XR debug mode

Version 1.3 could fail capability checks before reaching its claimed desktop-debug flow. Version 1.6 freezes the exact `?debug=1` query result into configuration, treats absent WebXR as a nonfatal capability result in debug mode, never calls `requestSession()`, creates a canonical debug geographic frame after location acceptance, and routes mouse selection and audio controls through the production contracts.

### 3.8 Nondeterministic partial boot cleanup

Version 1.6 establishes an exact construction order. Lightweight shell, manifest, location, and capability work precede renderer/map/audio construction. Expected boot failures retain only the fatal-state shell; unexpected invariant failures dispose partial resources, clear the singleton, reject initialization, and permit a fresh attempt.

### 3.9 Projection and module-ownership overlap

Version 1.6 makes WP-2 the sole projection-math owner. WP-4 consumes preprojected marker and ring models. This prevents agents from implementing subtly different map projection logic in both geodesy and UI modules.

### 3.10 Insufficient resource accounting

The final resource contract counts not only visible Three.js objects but also application-owned session, reference-space, controller, media, DOM, window, document, watchdog, fade, and subscription resources. Expected counts are defined for fatal boot, initialized, active XR, loading, fading, ended XR, and full disposal.

---

## 4. Mechanical validation performed

### 4.1 Document structure

The corrected PRD contains:

- 26 unique functional requirements (`FR-001` through `FR-026`)
- 24 unique acceptance criteria (`AC-001` through `AC-024`)
- 8 unique work packages (`WP-0` through `WP-7`)
- 5 named external gates (`G-01` through `G-05`)
- 187 unique Markdown headings
- 84 balanced code-fence lines, forming 42 fenced blocks
- 22 TypeScript fenced blocks
- No duplicate requirement, acceptance, work-package, or heading identifiers
- No unresolved `TODO`, `TBD`, or `FIXME` marker
- No stale Version 1.3–1.5 wording in the normative contract
- No stale `getCamera(appCamera)` or TypeScript 7 reference

### 4.2 TypeScript parsing and strict contract compilation

All 22 TypeScript snippets parse with TypeScript 5.9.3. The shared declaration set was then composed into one contract file and compiled under:

- `strict`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `useUnknownInCatchVariables`
- `isolatedModules`
- `verbatimModuleSyntax`
- `target: ES2022`
- `module: ESNext`
- `moduleResolution: Bundler`
- DOM, DOM Iterable, Node, and WebXR types

The composed contract produced no TypeScript error.

### 4.3 Exact toolchain feasibility

A clean-room package graph installed and resolved with:

- Node.js 22.16.0
- npm 10.9.2
- TypeScript 5.9.3
- Three.js 0.185.1
- `@types/three` 0.185.1
- `@types/webxr` 0.5.24
- Vite 8.1.4
- Vitest 4.1.10
- jsdom 29.1.1
- tsx 4.23.1
- `@types/node` 22.16.0

The generated npm lockfile used lockfile version 3. Exact Three.js/WebXR and positional-audio API probes compiled with this graph, including the no-argument XR camera getter, reference-space APIs, `AudioListener`, `PositionalAudio`, media-element source attachment, HRTF distance model, cone, and gain scheduling.

### 4.4 Deterministic fixture validation

The canonical WAV recipe produced two independently generated, byte-identical files:

- Size: 96,044 bytes
- SHA-256: `e4df7c1075940a8d01285505c96e080a5adae2c819ae7f16a0e9338e6a228110`

This matches the normative fixture value in Appendix F.

### 4.5 Corrected PRD fingerprint

`attune-prd-v1.6.md`

```text
SHA-256: 666b3d51dcf0d476e491d9e06c5c782b8ba8f26f62dbaea2740daa2b4339ce8a
```

The hash identifies the exact specification audited here.

### 4.6 What was not mechanically executed

The application repository described by WP-0 has not yet been generated from the PRD. Therefore, the audit did **not** claim that the future repository’s `npm ci && npm run verify` already passes, that audio assets play on Quest, or that headset performance is acceptable. The audit established specification consistency, toolchain feasibility, contract compilation, deterministic fixture generation, and official-API alignment.

---

## 5. Idempotence contract now available to agents

Version 1.6 is sufficient for idempotent implementation because it defines all of the following:

1. **Repository idempotence:** exact dependency graph, one lockfile, deterministic generators, stable output order, atomic writes, ignored generated reports, and a clean tracked tree after repeated verification.
2. **Construction idempotence:** one global app instance; repeat initialization reuses a compatible instance or rejects conflicting configuration.
3. **Session idempotence:** no concurrent XR start, one session generation, duplicate end as a no-op, late session cleanup, and no listener accumulation on re-entry.
4. **UI idempotence:** one app root, renderer canvas, map canvas/texture/plane, stable camera, two controller groups, and one handler per owned event type.
5. **Audio idempotence:** one media element, media source node, listener, positional source, and panner; recording changes reuse the graph.
6. **Command idempotence:** duplicate Play, Pause, Stop, selection, calibration, exit, and dispose behavior is specified by state.
7. **Asynchronous idempotence:** location, session, selection, timer, media-event, and promise completions carry or close over monotonic generations and cannot mutate newer state.
8. **Agent idempotence:** work packages own paths, inspect existing work before scaffolding, implement only missing deltas, prohibit parallel replacement modules, and require pre/post verification.
9. **Verification idempotence:** a second run of the documented commands must leave tracked files unchanged and return counters to the normative baseline.

---

## 6. Remaining external gates

### G-01 — Real metadata mapping

A representative source metadata sample and an approved field mapping are required before the production adapter can be completed. An agent must not infer field names or silently discard unmapped fields.

### G-02 — Audio suitability

The actual files require an audit of container, codec, sample rate, duration, channel count, and spatial format. Already-binaural, ambisonic, or unsupported multichannel content must not be passed silently through a point-source HRTF panner.

### G-03 — True-north operating procedure

The deployment must define how the user identifies true north: for example, a marked wall/floor direction or a trusted external compass procedure. A WebXR local reference space does not establish geographic north.

### G-04 — Production host

The chosen HTTPS host must be tested for the required permissions policy, MIME types, CORS behavior, byte ranges, cache headers, relative-base deployment, and cross-origin isolation assumptions actually used by the build.

### G-05 — Physical Meta Quest 3 evidence

The test record must identify Quest OS, Meta Quest Browser, build commit, content version, and hosting origin. It must cover MR entry, passthrough, controller interaction, north calibration, cardinal listening, head-turn world lock, reference-space reset, explicit exit, re-entry, rapid A→B→C selection, errors, and a five-minute stability/performance run.

An open gate blocks a **production-complete** claim but does not block implementation of the fixture-backed WP-0 through WP-6 architecture.

---

## 7. Recommended agent handoff rule

The coordinating agent should first implement **WP-0 only** and satisfy Appendix G.1. WP-1 through WP-5 may then branch from that frozen contract baseline. WP-6 begins only after Appendix G.2 passes. WP-7 may prepare deployment automation, but must report G-01 through G-05 honestly and must not substitute mocks for physical-device acceptance.

Every work-package completion report should include:

1. Files changed.
2. Commands and exit codes.
3. Requirements and acceptance criteria covered.
4. Tests added or updated.
5. Resource/lifecycle effects.
6. Deviations and ADRs.
7. Open external gates.
8. Next packages unblocked.

---

## 8. Final certification statement

**Certified status:** implementation-ready for WP-0 through WP-6 under Version 1.6’s frozen contracts; externally gated for production content, hosting, and Meta Quest 3 release acceptance.

**Not certified:** byte-identical output from arbitrary agents, completed production metadata integration, codec compatibility of unknown recordings, geographic-heading accuracy without an operating procedure, hosting correctness on an unselected provider, or device performance without a physical Quest 3 test.
