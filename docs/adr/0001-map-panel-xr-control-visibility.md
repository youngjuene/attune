# ADR 0001: Explicit XR-control visibility in the map model

## Status

Accepted for WP-6 integration.

## Affected contract

`MapPanelModel` in `src/domain/types.ts` gains the required boolean field
`xrControlsVisible`.

## Context

FR-020 requires desktop debug mode to use the production map while omitting the
XR-only Exit, Recenter, and Recalibrate controls. The frozen Version 1.6 map
contract exposed neither application mode nor control visibility, so WP-6 could
not express that required state without making `MapPanel` read global location
state or adding a second debug-only map implementation.

## Decision

`AppController` supplies `xrControlsVisible: !config.debugMode` in every
`MapPanelModel`. `MapPanel` omits the three XR-only controls from both drawing and
hit testing when the value is false. Playback, stop, and volume controls remain
available. The map remains mode-agnostic and consumes only explicit render data.

## Alternatives considered

- Reading `window.location` inside `MapPanel` would duplicate the canonical
  configuration decision and make the component harder to test.
- A debug-only panel would violate the single production map/projection path.
- Hiding controls in WP-6 with an overlay would leave their hit targets active.

## Compatibility impact

The change is source-breaking only for `MapPanelModel` producers, all of which
are repository-owned and updated in the same integration. No factory or runtime
resource ownership changes.

## Verification

WP-4 tests assert that all three XR-only labels and hit targets are absent when
`xrControlsVisible` is false and remain present in normal mode.
