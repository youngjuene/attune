import type { AppState, RuntimeResourceCounts } from '../domain/types';

const CARDINAL_FIXTURES = Object.freeze([
  'north  37.567399320364, 126.978000000000',
  'east   37.566499994571, 126.979134579723',
  'south  37.565600679636, 126.978000000000',
  'west   37.566499994571, 126.976865420277',
]);

function definition(label: string, value: string): HTMLDivElement {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  row.append(term, detail);
  return row;
}

/** Render deterministic desktop-only diagnostics without installing handlers. */
export function createDebugView(
  state: AppState,
  counts: RuntimeResourceCounts,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'debug-view';
  section.dataset.testid = 'debug-view';
  const heading = document.createElement('h2');
  heading.textContent = 'Desktop debug diagnostics';
  const capabilities = document.createElement('dl');
  capabilities.append(
    definition('Secure context', String(state.secureContext)),
    definition('WebXR API', String(state.xrApiAvailable)),
    definition('Immersive AR', String(state.immersiveARSupported)),
    definition('Geolocation API', String(state.browserGeolocationAvailable)),
    definition('Active XR sessions', String(counts.activeXRSessions)),
    definition('Build', state.buildCommit),
  );
  const fixtureHeading = document.createElement('h3');
  fixtureHeading.textContent = 'Canonical cardinal fixture';
  const fixtures = document.createElement('pre');
  fixtures.textContent = CARDINAL_FIXTURES.join('\n');
  const stateHeading = document.createElement('h3');
  stateHeading.textContent = 'Current app state and resources';
  const diagnostics = document.createElement('pre');
  diagnostics.textContent = JSON.stringify({ state, resources: counts }, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && 'isVector3' in value) {
      const vector = value as unknown as { x: number; y: number; z: number };
      return [vector.x, vector.y, vector.z];
    }
    return value;
  }, 2);
  section.append(heading, capabilities, fixtureHeading, fixtures, stateHeading, diagnostics);
  return section;
}
