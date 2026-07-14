import './styles.css';

import { AppError } from './app/errors';
import { getAppConfig } from './config';
import type { AppConfig, Disposable } from './domain/types';

export interface BootstrapShell extends Disposable {
  readonly config: Readonly<AppConfig>;
  readonly root: HTMLElement;
}

let activeShell: BootstrapShell | undefined;

function sameConfig(left: Readonly<AppConfig>, right: Readonly<AppConfig>): boolean {
  return left.manifestUrl === right.manifestUrl
    && left.audioLoadTimeoutMs === right.audioLoadTimeoutMs
    && left.progressUpdateHz === right.progressUpdateHz
    && left.sourceRadiusMOverride === right.sourceRadiusMOverride
    && left.buildCommit === right.buildCommit
    && left.debugMode === right.debugMode;
}

export function initializeBootstrapShell(config: Readonly<AppConfig> = getAppConfig()): BootstrapShell {
  if (activeShell !== undefined) {
    if (!sameConfig(activeShell.config, config)) {
      throw new AppError('CONFIGURATION_CONFLICT');
    }
    return activeShell;
  }

  const root = document.querySelector<HTMLElement>('#app');
  if (root === null) {
    throw new AppError('CONFIGURATION_CONFLICT');
  }

  const view = document.createElement('main');
  view.className = 'bootstrap-shell';
  view.dataset.attuneOwned = 'bootstrap-shell';
  view.innerHTML = `
    <p class="eyebrow">Geo-referenced spatial audio</p>
    <h1>attune</h1>
    <p class="status">The Version 1.6 contract baseline is ready for content and capability preflight.</p>
    <dl>
      <div><dt>Manifest</dt><dd>${config.manifestUrl}</dd></div>
      <div><dt>Build</dt><dd>${config.buildCommit}</dd></div>
      <div><dt>Mode</dt><dd>${config.debugMode ? 'Desktop debug' : 'Mixed reality'}</dd></div>
    </dl>
    <p class="notice">Location is requested before mixed-reality entry. No permission request runs in this WP-0 shell.</p>
  `;

  const onRootClick = (): void => undefined;
  const onRootInput = (): void => undefined;
  const onRootPointerMove = (): void => undefined;
  const onWindowResize = (): void => undefined;
  const onDocumentVisibilityChange = (): void => undefined;

  root.addEventListener('click', onRootClick);
  root.addEventListener('input', onRootInput);
  root.addEventListener('pointermove', onRootPointerMove);
  window.addEventListener('resize', onWindowResize);
  document.addEventListener('visibilitychange', onDocumentVisibilityChange);
  root.append(view);

  let disposed = false;
  const shell: BootstrapShell = {
    config,
    root,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      root.removeEventListener('click', onRootClick);
      root.removeEventListener('input', onRootInput);
      root.removeEventListener('pointermove', onRootPointerMove);
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('visibilitychange', onDocumentVisibilityChange);
      view.remove();
      if (activeShell === shell) {
        activeShell = undefined;
      }
    },
  };

  activeShell = shell;
  return shell;
}

initializeBootstrapShell();
