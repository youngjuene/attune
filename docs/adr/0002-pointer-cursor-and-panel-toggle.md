# ADR 0002: Pointer cursor and panel-visibility toggle contracts

## Status

Accepted for WP-7 (WP-E pointer cursor, WP-D panel toggle).

## Affected contract

`src/domain/types.ts`:

- New `PointerTargetKind = 'none' | 'panel' | 'marker' | 'control' | 'disabled'`.
- `RuntimeResourceCounts` gains `pointerReticles`, `reticleGeometries`, `reticleMaterials`
  (each `0 | 1`), and widens `registeredXRSessionHandlers` from `0 | 4` to `0 | 5`.
- `XRSessionController` gains `setPointerTarget(kind: PointerTargetKind): void` and adds the
  three reticle counts to its `resourceCounts()` projection.
- `MapPanel` gains `classifyTarget(canvasX, canvasY): PointerTargetKind`.
- `MapPanelModel` gains a required `panelVisible: boolean`.
- `AppState` gains `panelVisible: boolean`; `AppAction` gains `{ type: 'TOGGLE_PANEL' }`;
  `XRRuntimeEvent` gains `{ type: 'primarySqueeze'; sessionGeneration; nowMs }`.

## Context

WP-7 requires a real 3D pointer cursor and a way to hide the panel for clean passthrough.

A canvas-drawn cursor is disqualified: `CanvasMapPanel.draw()` re-uploads the whole texture,
so a per-move cursor would redraw and re-upload up to 90x/second (~7 MB each at the WP-B
resolution) and cannot render when the ray misses the panel. The cursor must be a scene
object, which introduces new GPU resources that the exhaustive resource-counting invariant
must track.

The cursor's colour states (marker/control/disabled) depend on hit-target classification,
which lives in `MapPanel`/`hitTest` — `readPointer` in `XRSessionController` has only the
intersection geometry. Rather than duplicate hit semantics inside the controller, the panel
exposes `classifyTarget`, and the controller exposes `setPointerTarget` so `AppController`
can push the classification to the reticle it owns.

The toggle uses the squeeze (grip) action because a canvas control cannot bring a hidden
panel back. Squeeze registration is a fifth session handler, changing the handler count. The
panel's visibility must live in `AppState` (not `MapPanel`, which stays mode-agnostic) and
reach the panel through `MapPanelModel`, exactly as `xrControlsVisible` does.

## Decision

The reticle is created in `createXRSceneResources`, driven from the intersection
`readPointer` already computes (zero extra raycasts), scaled by hit distance for constant
angular size, coloured from `PointerTargetKind`, and counted/disposed with the other scene
resources. Hiding is expressed by `MapPanelModel.panelVisible`; `readPointer` returns no hit
when the surface object is invisible, which quiets hover, selection, and the reticle without
nulling the interaction surface — so the panel is never re-posed and its world pose is
preserved across hide/show. Grip emits `primarySqueeze`; `AppController` dispatches
`TOGGLE_PANEL`, which the reducer honours only in the `ready` phase.

## Alternatives considered

- Drawing the cursor on the canvas: rejected (per-move texture re-upload; cannot render off
  the panel). See context.
- Nulling the interaction surface on hide: rejected — it resets `provisionalSurface` and the
  next frame re-poses the panel head-relative, breaking the same-world-pose requirement.
- Classifying hit targets inside `XRSessionController`: rejected — duplicates `hitTest`
  semantics and couples the controller to the map model. `MapPanel.classifyTarget` keeps the
  ownership correct.
- A canvas control to restore the panel: impossible once the panel (and its hit targets) is
  hidden; the grip action is always available.

## Compatibility impact

Source-breaking only for repository-owned producers/consumers of these contracts
(`AppController`, `MapPanel`, `XRSessionController`, their fakes, and the resource-count
tests), all updated in the same work. No factory signature changes. Resource ownership grows
by exactly one reticle mesh/geometry/material, all released in
`XRSceneResources.dispose()`.

## Verification

`tests/xr-session.test.ts` asserts the reticle counts return to zero after `dispose()` and
that the handler count is five while a session is registered. `tests/map-panel.test.ts`
asserts `classifyTarget` results and that classification triggers no canvas redraw.
`tests/app-integration.test.ts` asserts playback survives a hide/show cycle, the panel is not
re-posed, and every resource count returns to zero after disposal.
