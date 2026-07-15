export interface DeferredPlay {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function deferredPlay(onResolve: () => void, onReject: () => void): DeferredPlay {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve() {
      onResolve();
      resolvePromise();
    },
    reject(error: unknown) {
      onReject();
      rejectPromise(error);
    },
  };
}

export class MockMediaElement extends EventTarget {
  public preload = '';
  public crossOrigin: string | null = null;
  public currentTime = 0;
  public duration = Number.NaN;
  public paused = true;
  public ended = false;
  public error: { code: number } | null = null;
  public readonly loadUrls: string[] = [];
  public readonly playAttempts: DeferredPlay[] = [];
  public readonly added = new Map<string, Set<EventListenerOrEventListenerObject>>();
  public loadCalls = 0;
  public playCalls = 0;
  public pauseCalls = 0;
  public emitAbortOnEmptyLoad = false;
  public canPlayTypeImpl: (mimeType: string) => CanPlayTypeResult = () => '';

  private assignedSrc = '';
  private srcPresent = false;

  public get src(): string {
    return this.assignedSrc;
  }

  public set src(value: string) {
    this.assignedSrc = new URL(value, document.baseURI).href;
    this.srcPresent = true;
    this.ended = false;
    this.error = null;
  }

  public get currentSrc(): string {
    return this.assignedSrc;
  }

  public override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, callback, options);
    if (callback === null) {
      return;
    }
    const handlers = this.added.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    handlers.add(callback);
    this.added.set(type, handlers);
  }

  public override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, callback, options);
    if (callback === null) {
      return;
    }
    this.added.get(type)?.delete(callback);
  }

  public canPlayType(mimeType: string): CanPlayTypeResult {
    return this.canPlayTypeImpl(mimeType);
  }

  public load(): void {
    this.loadCalls += 1;
    this.loadUrls.push(this.assignedSrc);
    if (this.emitAbortOnEmptyLoad && this.assignedSrc === '') {
      this.emit('abort');
    }
  }

  public play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    const attempt = deferredPlay(
      () => {
        this.paused = false;
      },
      () => {
        this.paused = true;
      },
    );
    this.playAttempts.push(attempt);
    return attempt.promise;
  }

  public pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  public removeAttribute(name: string): void {
    if (name === 'src') {
      this.assignedSrc = '';
      this.srcPresent = false;
      this.ended = false;
      this.error = null;
    }
  }

  public hasAttribute(name: string): boolean {
    return name === 'src' && this.srcPresent;
  }

  public emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  public listenerCount(type?: string): number {
    if (type !== undefined) {
      return this.added.get(type)?.size ?? 0;
    }
    let count = 0;
    for (const handlers of this.added.values()) {
      count += handlers.size;
    }
    return count;
  }

  public asElement(): HTMLAudioElement {
    return this as unknown as HTMLAudioElement;
  }
}

export function domException(name: string): DOMException {
  return new DOMException(name, name);
}
