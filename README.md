# attune

attune is a static Vite and Three.js application for exploring geographically indexed point-source recordings in Meta Quest 3 mixed reality.

This repository builds on the WP-0 contract-freeze baseline (strict TypeScript/Vite scaffold, shared contracts, deterministic content fixtures, bootstrap validator, adapter placeholder, and CI verification gate) through the WP-1–WP-7 runtime: location, geodesy/projection, spatial audio, the canvas map panel, XR session lifecycle, and the WP-7 passthrough-legibility pass. The fixture path is intentional while external gates G-01 through G-05 remain open.

WP-7 adds passthrough-legibility compositor settings (foveation off, native framebuffer scale), a supersampled map canvas, a minimal per-element visual language with an 18px type floor, a grip toggle that hides the panel for clean passthrough without stopping audio, and a distance-scaled 3D pointer reticle. See `docs/adr/0002-pointer-cursor-and-panel-toggle.md`.

## Geographic and listener frames

Calibration creates a fixed geographic frame. Its origin and true-north/east axes do not follow later headset movement. Audio source positions are calculated in that fixed frame. Separately, the one live Three.js application camera owns the audio listener and is updated by WebXR, so head rotation and movement change listening perspective without rotating the geographic world.

## Requirements

- Node.js `22.16.0`
- npm `10.9.2`

Install and verify from a clean checkout:

```sh
npm ci
npm run verify
```

Start the desktop scaffold:

```sh
npm run dev
```

The bootstrap content validator writes deterministic machine-readable evidence to `artifacts/content-validation.json`. Generated JSON evidence is ignored by Git. `npm run adapt:content` deliberately exits with code 2 and reports G-01 open until representative source metadata and its approved field mapping are supplied.

On-device validation remains open: passthrough contrast and the WP-7 compositor frame-timing tradeoff (foveation, framebuffer scale) require a physical Quest 3 and are not exercised in CI. The repository does not claim hosting, production-content, or audio-suitability validation.
