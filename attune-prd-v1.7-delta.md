# attune PRD v1.7 delta — capped multi-source soundscape

This delta amends `attune-prd-v1.6.md`. Sections not amended here remain in
force verbatim. Decision rationale lives in
`docs/adr/0003-multi-source-soundscape.md`; this document is normative.

## D-1. Amended non-goal

v1.6 lists "Multiple simultaneous recording sources" as a non-goal. v1.7
narrows it: simultaneous sources **up to a configured cap** are in scope.
Anything beyond the cap, per-source transport UI, and any second
`AudioContext` remain out of scope.

## D-2. Configuration

- `VITE_MAX_SIMULTANEOUS_SOURCES` MUST parse as an integer in [1, 8];
  absent or blank means 1; any other value is `CONFIGURATION_CONFLICT`.
- The value MUST surface as `AppConfig.maxSimultaneousSources`, participate in
  the `sameConfig` comparison, and be immutable for the app generation.
- With value 1, observable behavior MUST be identical to v1.6 (degenerate
  case, single code path; no mode fork).

## D-3. Audio architecture

- A `SoundscapePlayer` coordinator MUST own a fixed pool of exactly
  `maxSimultaneousSources` `SpatialAudioPlayer` units created at
  initialization and recycled thereafter; units MUST NOT be constructed per
  selection (`createMediaElementSource` is once-per-element).
- All units MUST share one coordinator-owned `THREE.AudioListener` injected
  via `SpatialAudioPlayerOptions.sharedListener`; a unit given a shared
  listener MUST NOT attach it to the camera, MUST NOT disconnect it on
  dispose, and MUST report `listeners: 0`. The page-global `AudioContext`
  rule of v1.6 §Audio is unchanged.
- The coordinator MUST insert a `DynamicsCompressorNode` between the shared
  listener's gain and the destination via `AudioListener.setFilter()`.
- Each unit MUST expose `setMixGain(v ∈ [0,1], default 1)`, composed
  multiplicatively into effective gain with master gain and `gainDb`,
  retargeting any active ramp exactly as a master-volume change does
  (v1.6 §Gain automation invariants apply unchanged).
- The coordinator MUST set per-source mix gain to
  `distanceGain(distanceM) × trim(N_active)` where: `distanceGain` = 1 for
  d ≤ 100 m, 0.2 for d ≥ D_max (`map.maxDistanceM`, else the collection's
  maximum record distance), linear in log10(d) between, and 1 for co-located
  records; `trim` = 1/√N_active. Constant values MAY be tuned during WP-D;
  monotonicity and the floor MUST hold.

## D-4. Selection and set semantics

- In `ready`, a marker trigger MUST toggle that recording's membership in the
  audible set. Activation starts playback of that source; deactivation stops
  it. `selectedRecordingId` (focus, detail column) tracks the last toggled
  recording and is independent of membership. At cap 1, a trigger on the
  already-active focus retains v1.6 semantics instead of toggling off — no-op
  while loading/playing, resume when paused/stopped/ended, reload on error —
  because D-2 identity takes precedence.
- `AppState` gains `activeRecordingIds` (activation order, oldest first) and
  `playbackById` (per-id `PlaybackSnapshot`).
- Activating beyond the cap MUST evict the oldest active source by recycling
  its pool unit through `select()` (inheriting the 150 ms fade-out contract of
  v1.6 §Selection choreography).
- The single monotonic `selectionGeneration` counter is retained. Routed
  operations MUST supply a strictly newer generation to the targeted unit;
  collective operations MAY broadcast one fresh generation to all units.

## D-5. Lifecycle, recovery, and controls

- Visibility loss MUST pause all active sources.
- Recalibration MUST recompute and apply positions for all active sources and
  leave all of them paused. There MUST be no per-source silent auto-resume.
- The panel MUST provide **Stop All** and **Resume All** controls; Resume All
  is also the recovery affordance after gesture-required rejections
  (`AUDIO_PLAY_REJECTED` / `AUDIO_CONTEXT_SUSPENDED`).
- Exit Mixed Reality semantics are unchanged from v1.6.

## D-6. Events and rendering budget

- The coordinator MUST coalesce unit snapshots into at most one aggregate
  event per progress tick (`VITE_PROGRESS_UPDATE_HZ`), and MapPanel MUST
  redraw at most once per tick regardless of active-source count.

## D-7. Resource accounting

- Coordinator `resourceCounts()` MUST equal the exact sum of its units plus
  its own shared listener (e.g. cap 4 fully active: `mediaElements: 4`,
  `panners: 4`, `listeners: 1`). The v1.6 no-leak requirement (counts return
  to zero after disposal) applies to the aggregate.

## D-8. Test assets and acceptance

- The cardinal fixture MUST use four distinct per-direction pitches
  (440/550/660/880 Hz for N/E/S/W) so simultaneous playback is
  ear-distinguishable.
- On-device acceptance at cap 4: eyes-closed pointing test per direction,
  frame-timing check with 4 HRTF panners active, and an audible-artifact
  (crackle) check. The shipped default cap decision is taken after this pass.
