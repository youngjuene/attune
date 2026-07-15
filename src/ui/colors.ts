/**
 * Shared passthrough palette. Consumed by the canvas map panel and the 3D pointer reticle
 * so both read as one visual language. Values are CSS colour strings; THREE.Color.set()
 * accepts them directly for the reticle materials.
 */
export const COLORS = Object.freeze({
  background: 'rgba(11, 27, 29, 0.88)',
  panel: 'rgba(16, 39, 42, 0.92)',
  panelAlt: 'rgba(13, 32, 34, 0.9)',
  line: '#47726b',
  muted: '#c4d6d0',
  text: '#e9f6f1',
  accent: '#8edcc5',
  selected: '#fff4b8',
  warning: '#ffd28a',
  error: '#ff9e9e',
  disabled: '#8f9d99',
  // Dark, near-opaque backings that make ink legible directly over live passthrough
  // without a full panel plate. `halo` outlines strokes/text; `scrim` sits behind a text
  // run or control sized to its content.
  halo: 'rgba(4, 12, 13, 0.78)',
  scrim: 'rgba(6, 16, 18, 0.64)',
});
