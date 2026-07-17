# ADR 0003: Multi-source soundscape as a capped generalization of single-source playback

## Status

Accepted for WP-8 (soundscape work packages WP-A through WP-F). Amends the
"Multiple simultaneous recording sources" non-goal of PRD v1.6 through
`attune-prd-v1.7-delta.md`; the shipped default preserves v1.6 behavior exactly.

## Affected contract

`src/domain/types.ts` (phased):

- WP-B: `SpatialAudioPlayerOptions` gains `sharedListener?: THREE.AudioListener`.
  When supplied, the player neither attaches a listener to the camera nor
  disconnects it on dispose, and reports `listeners: 0` in `resourceCounts()`
  (the injector owns the listener and counts it once).
- WP-B: `SpatialAudioPlayer` gains `setMixGain(value: number): void` — an
  externally computed multiplier in [0, 1] (default 1) composed into the
  effective gain alongside master gain and the record's `gainDb` trim, with the
  same held-ramp retargeting semantics as `setMasterGain`.
- WP-C: `AppConfig` gains `maxSimultaneousSources: number` parsed from
  `VITE_MAX_SIMULTANEOUS_SOURCES` (integer 1–8, default 1, both bounds
  inclusive; anything else is `CONFIGURATION_CONFLICT`).
- WP-C: `AppState` gains `activeRecordingIds: readonly string[]` (activation
  order, oldest first) and `playbackById: Readonly<Record<string,
  PlaybackSnapshot>>`. `selectedRecordingId` remains the focus identity for the
  detail column and is independent of set membership.
- WP-C: a `SoundscapePlayer` contract aggregating N `SpatialAudioPlayer` units;
  its resource counts are the exact sums of its units plus its one shared
  listener, so the no-leak invariants stay numerically exact.

## Context

v1.6 renders exactly one audible recording. The soundscape goal is several
geo-referenced recordings audible simultaneously, each at its true bearing.
Constraints that shaped the architecture:

- `createMediaElementSource` is once-per-element for the life of the page. The
  existing player already encapsulates the safe pattern (one element assigned
  once, `src`-swap thereafter, fade choreography, generation guard, watchdog).
  Dissecting that state machine would put the repo's most invariant-dense code
  (PRD v1.6 fade-envelope and selection-choreography sections) at risk.
- `placeAtBearing` normalizes every source onto a ring at `sourceRadiusM`, so
  the `PannerNode` never sees geographic distance: distance loudness cannot come
  from panner rolloff and must be an explicit per-source gain curve.
- MapPanel canvas texture upload dominates XR frame cost (see ADR 0002); N
  sources emitting progress snapshots independently would multiply redraws.
- The single page-global `AudioContext` is a PRD v1.6 invariant and already
  supports many nodes; N listeners would be wasteful but N `PositionalAudio`
  units on one listener is the intended Web Audio topology.

## Decision

1. **Semantics — bounded multi-select toggle.** In `ready`, trigger on a marker
   toggles that recording's membership in the audible set (select = start
   playing, reselect = stop). The detail column shows the focus
   (`selectedRecordingId`, last toggled). No per-source transport UI.
2. **Cap — env knob, default single-source.** `VITE_MAX_SIMULTANEOUS_SOURCES`
   bounds the set (1–8, default 1). Cap 1 reproduces the v1.6 contract as the
   degenerate case of one code path; the soundscape is opt-in via `.env.local`
   (device testing uses 4).
3. **Eviction — oldest first.** Activating a source beyond the cap evicts the
   oldest active source by recycling its pool unit through `select()`, whose
   existing 150 ms fade-out-then-swap provides the audible transition for free.
4. **Architecture — composition, not extraction.** A `SoundscapePlayer`
   coordinator owns a fixed pool of N = cap `SpatialAudioPlayer` units created
   at init (never per selection, honoring the once-per-element rule), all
   sharing one coordinator-owned injected `THREE.AudioListener`. Operations
   route by recording id. The app-level `selectionGeneration` counter is reused
   unchanged: per unit, any strictly newer value is valid, so routed ops and
   broadcasts (which may share one fresh value) both satisfy the adoption rule.
5. **Mix gain — coordinator-computed scalar.** Each unit exposes
   `setMixGain(v)`; the coordinator sets v = distanceGain(d) × trim(N):
   distanceGain is 1 at d ≤ 100 m, floors at 0.2 for d ≥ D_max
   (`map.maxDistanceM` or the collection maximum), linear in log10(d) between,
   and 1 for co-located records; trim is 1/√N_active (equal-power). Constants
   are tunable in the WP-D listening pass; the shapes are locked here.
6. **Master bus limiter.** A `DynamicsCompressorNode` inserted with
   `listener.setFilter()` guards against summed clipping without altering the
   per-unit gain contracts.
7. **Lifecycle — collective, explicit.** Visibility loss pauses all active
   sources (one broadcast generation). Recalibration repositions every active
   source and leaves all paused; a single **Resume All** control (also the
   post-gesture-rejection recovery affordance) restarts them. No per-source
   silent auto-resume, preserving the v1.6 rule.
8. **Events — coalesced.** The coordinator aggregates unit snapshots and emits
   at most one combined event per progress tick; MapPanel redraws at most once
   per tick regardless of source count.

## Consequences

- Shipped behavior is unchanged until the knob is raised; the PRD delta narrows
  the non-goal instead of deleting it ("more than the configured cap" remains
  out of scope).
- Resource-count invariants extend by summation and stay exactly assertable
  (`mediaElements: N`, `panners: N`, `listeners: 1` coordinator-owned).
- WP-C rewrites a real slice of reducer and app-integration tests
  (single-`playback` assumptions); `spatial-audio.test.ts` remains valid for
  the unit contract.
- The cardinal fixture's four identical 440 Hz tones are indistinguishable when
  simultaneous; WP-F adds distinct per-direction pitches (440/550/660/880 Hz)
  so the acceptance test is ear-verifiable (eyes-closed pointing test).
- Quest performance must be re-verified on device with 4 HRTF panners active
  (frame timing, audio crackle); `XR_FOVEATION` guidance from WP-7 applies.
