import './styles.css';

import { initializeApp } from './app/AppController';
import { AppError } from './app/errors';
import { getAppConfig } from './config';
import type { AppConfig, Disposable } from './domain/types';

/** Compatibility surface retained for the frozen WP-0 scaffold test only. */
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
    && left.debugMode === right.debugMode
    && left.maxSimultaneousSources === right.maxSimultaneousSources
    && left.defaultLocation?.lat === right.defaultLocation?.lat
    && left.defaultLocation?.lon === right.defaultLocation?.lon;
}

export function initializeBootstrapShell(config: Readonly<AppConfig> = getAppConfig()): BootstrapShell {
  if (activeShell !== undefined) {
    if (!sameConfig(activeShell.config, config)) throw new AppError('CONFIGURATION_CONFLICT');
    return activeShell;
  }
  const root = document.querySelector<HTMLElement>('#app');
  if (root === null) throw new AppError('CONFIGURATION_CONFLICT');
  const view = document.createElement('main');
  view.className = 'bootstrap-shell';
  view.dataset.attuneOwned = 'bootstrap-shell';
  const heading = document.createElement('h1');
  heading.textContent = 'attune';
  view.append(heading);
  root.append(view);
  let disposed = false;
  const shell: BootstrapShell = {
    config,
    root,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      view.remove();
      if (activeShell === shell) activeShell = undefined;
    },
  };
  activeShell = shell;
  return shell;
}

export async function bootstrapApplication(): Promise<void> {
  try {
    await initializeApp(getAppConfig());
  } catch (cause) {
    const code = cause instanceof AppError ? cause.code : 'CONFIGURATION_CONFLICT';
    console.error(code);
    const root = document.querySelector<HTMLElement>('#app');
    if (root !== null) {
      const message = document.createElement('p');
      message.className = 'error';
      message.textContent = `Startup failed (${code}). Reload after correcting the configuration.`;
      root.replaceChildren(message);
    }
  }
}

if (import.meta.env.MODE !== 'test') {
  void bootstrapApplication();
}
