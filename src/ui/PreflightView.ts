import type { AppState, MapPanel, RuntimeResourceCounts } from '../domain/types';
import { createDebugView } from '../debug/DebugView';

const ERROR_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  INSECURE_CONTEXT: 'Open this experience through HTTPS.',
  XR_API_UNAVAILABLE: 'This browser does not expose WebXR. Use a supported Quest browser.',
  IMMERSIVE_AR_UNSUPPORTED: 'Passthrough mixed reality is unavailable in this browser.',
  MANIFEST_LOAD_FAILED: 'Content could not be loaded. Check the connection and retry the page.',
  MANIFEST_INVALID: 'The content manifest is invalid. Ask the publisher to repair it.',
  NO_VALID_RECORDINGS: 'No valid recordings are available.',
  XR_RENDERER_INIT_FAILED: 'Mixed-reality rendering could not initialize. Restart the browser.',
  AUDIO_INITIALIZATION_FAILED: 'Spatial audio could not initialize. Restart the browser.',
  AUDIO_UNSUPPORTED: 'This browser cannot play any recording in the collection.',
  LOCATION_DENIED: 'Location permission was denied. Enter coordinates manually.',
  LOCATION_TIMEOUT: 'Location timed out. Retry or enter coordinates manually.',
  LOCATION_UNAVAILABLE: 'Current location is unavailable. Enter coordinates manually.',
  LOCATION_INVALID: 'Enter decimal latitude from -90 to 90 and longitude from -180 to 180.',
  XR_SESSION_REJECTED: 'Mixed-reality entry was declined. Try Enter Mixed Reality again.',
  REFERENCE_SPACE_UNAVAILABLE: 'A stable XR reference space is unavailable. Exit and retry.',
  CALIBRATION_INVALID: 'Keep your gaze approximately level, face north, and try again.',
  CALIBRATION_RESET: 'Tracking changed. Face true north and calibrate again.',
  AUDIO_CONTEXT_SUSPENDED: 'Audio needs another gesture. Press Play.',
  AUDIO_PLAY_REJECTED: 'Playback needs another gesture. Press Play.',
  AUDIO_NETWORK: 'Audio could not be loaded. Check the connection and retry.',
  AUDIO_CORS: 'The audio host blocked playback. Ask the publisher to allow this origin.',
  AUDIO_DECODE: 'This recording could not be decoded. Choose another recording.',
  AUDIO_ABORTED: 'Playback was interrupted. Press Play to retry.',
});

function paragraph(className: string, text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}

function button(action: string, label: string, disabled = false): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.dataset.action = action;
  element.textContent = label;
  element.disabled = disabled;
  return element;
}

/** Stateless shell renderer. AppController owns all delegated events. */
export class PreflightView {
  public constructor(private readonly root: HTMLElement) {}

  public render(
    state: AppState,
    counts: RuntimeResourceCounts,
    mapPanel: MapPanel | null,
  ): void {
    const oldLat = this.root.querySelector<HTMLInputElement>('[name="latitude"]')?.value ?? '';
    const oldLon = this.root.querySelector<HTMLInputElement>('[name="longitude"]')?.value ?? '';
    const main = document.createElement('main');
    main.className = 'app-shell';
    main.dataset.attuneOwned = 'app-shell';
    main.append(
      paragraph('eyebrow', 'Geo-referenced spatial audio'),
      Object.assign(document.createElement('h1'), { textContent: 'attune' }),
      paragraph('privacy', 'Coordinates stay in this page and are used locally for direction and distance.'),
    );

    if (state.phase === 'booting') {
      main.append(paragraph('status', 'Checking browser capabilities and content…'));
    } else if (state.phase === 'fatalError') {
      main.append(paragraph('error', ERROR_GUIDANCE[state.error?.code ?? ''] ?? 'The application could not start.'));
    } else {
      const summary = document.createElement('section');
      summary.className = 'preflight-summary';
      const heading = document.createElement('h2');
      heading.textContent = state.debugMode ? 'Desktop debug mode' : 'Preflight';
      const content = paragraph(
        'status',
        `${state.recordings.length} valid recording${state.recordings.length === 1 ? '' : 's'}, `
        + `${state.rejectedRecordCount} rejected, ${state.unsupportedRecordCount} unsupported.`,
      );
      summary.append(heading, content);
      if (state.debugMode && (!state.secureContext || !state.xrApiAvailable || !state.immersiveARSupported)) {
        summary.append(paragraph('warning', 'XR capability warnings are nonfatal in desktop debug mode; no XR session will be requested.'));
      }
      main.append(summary);

      const location = document.createElement('section');
      location.className = 'location-controls';
      const locationHeading = document.createElement('h2');
      locationHeading.textContent = 'Choose your location';
      const current = button(
        'use-location',
        state.phase === 'locationPending' ? 'Locating…' : 'Use current location',
        !state.browserGeolocationAvailable || state.phase === 'locationPending' || state.sessionActive,
      );
      const latLabel = document.createElement('label');
      latLabel.textContent = 'Latitude';
      const lat = document.createElement('input');
      lat.name = 'latitude';
      lat.inputMode = 'decimal';
      lat.value = oldLat;
      const lonLabel = document.createElement('label');
      lonLabel.textContent = 'Longitude';
      const lon = document.createElement('input');
      lon.name = 'longitude';
      lon.inputMode = 'decimal';
      lon.value = oldLon;
      latLabel.append(lat);
      lonLabel.append(lon);
      location.append(locationHeading, current, latLabel, lonLabel, button('submit-location', 'Use manual coordinates'));
      if (state.location !== undefined) {
        const accuracy = state.location.accuracyM === undefined ? '' : `; accuracy ${Math.round(state.location.accuracyM)} m`;
        location.append(paragraph(
          state.location.accuracyM !== undefined && state.location.accuracyM > 50 ? 'warning' : 'status',
          `${state.location.lat.toFixed(6)}, ${state.location.lon.toFixed(6)} (${state.location.source}${accuracy})`,
        ));
      }
      if (!state.debugMode) {
        const selectable = state.recordings.length - state.unsupportedRecordCount > 0;
        location.append(button(
          'enter-xr',
          state.phase === 'enteringXR' ? 'Entering…' : 'Enter Mixed Reality',
          state.phase !== 'locationReady' || !selectable,
        ));
      }
      main.append(location);

      if (state.error !== undefined) {
        main.append(paragraph('error', ERROR_GUIDANCE[state.error.code] ?? state.error.code));
        if (state.error.recoverable) main.append(button('clear-error', 'Dismiss'));
      }

      if (state.debugMode && mapPanel !== null) {
        const mapRegion = document.createElement('section');
        mapRegion.className = 'desktop-map';
        mapRegion.append(mapPanel.getCanvas());
        main.append(mapRegion, createDebugView(state, counts));
      }
    }
    this.root.replaceChildren(main);
  }

  public clear(): void {
    this.root.replaceChildren();
  }
}
