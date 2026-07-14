# attune

attune is a static Vite and Three.js application for exploring geographically indexed point-source recordings in Meta Quest 3 mixed reality.

This repository currently contains the WP-0 contract-freeze baseline: the strict TypeScript/Vite scaffold, shared contracts, deterministic content fixtures, bootstrap validator, adapter placeholder, and CI verification gate. The fixture path is intentional while external gates G-01 through G-05 remain open.

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

WP-0 does not claim WebXR, browser, hosting, production-content, audio-suitability, or physical Quest 3 validation.
