import * as THREE from 'three';

import { AppError } from '../app/errors';
import type {
  CreateXRSessionController,
  ImmersiveARSessionInit,
  PointerTargetKind,
  RuntimeResourceCounts,
  Unsubscribe,
  XRInteractionSurface,
  XRRuntimeEvent,
  XRSessionController,
  XRSessionControllerOptions,
  XRSessionHandle,
} from '../domain/types';
import { COLORS } from '../ui/colors';
import { createXRSceneResources, type XRSceneResources } from './scene';

// Guards getNativeFramebufferScaleFactor against pathological values while still lifting
// the framebuffer above the user-agent default toward the display's native resolution.
const XR_MAX_FRAMEBUFFER_SCALE = 1.5;

// Reticle outer radius in metres per metre of hit distance, giving a constant angular size
// (~0.37deg). A small offset toward the viewer avoids z-fighting with the panel.
const RETICLE_ANGULAR_SIZE = 0.0065;
const RETICLE_SURFACE_OFFSET_M = 0.004;
const PANEL_LOCAL_NORMAL = new THREE.Vector3(0, 0, 1);
const RAY_COLOR_ACTIVE = 0xe9f6f1;
const RAY_COLOR_IDLE = 0x4a5c58;

function reticleColor(kind: PointerTargetKind): THREE.ColorRepresentation {
  switch (kind) {
    case 'marker':
    case 'control':
      return COLORS.accent;
    case 'disabled':
      return COLORS.disabled;
    case 'panel':
    case 'none':
      return COLORS.muted;
  }
}

type XRCounts = Pick<
  RuntimeResourceCounts,
  | 'renderers'
  | 'rendererCanvases'
  | 'scenes'
  | 'appCameras'
  | 'controllerGroups'
  | 'controllerRayVisuals'
  | 'pointerReticles'
  | 'reticleGeometries'
  | 'reticleMaterials'
  | 'activeXRSessions'
  | 'registeredXRSessionHandlers'
  | 'registeredReferenceSpaceHandlers'
  | 'registeredControllerGroupHandlers'
  | 'controllerBindings'
>;

interface PendingSelect {
  readonly source: XRInputSource;
  readonly nowMs: number;
}

type ControllerConnectedEvent = { type: 'connected'; data: XRInputSource };
type ControllerDisconnectedEvent = { type: 'disconnected'; data: XRInputSource };

interface SessionContext {
  readonly generation: number;
  readonly session: XRSession;
  referenceSpace: XRReferenceSpace | null;
  readonly groupSources: Map<THREE.XRTargetRaySpace, XRInputSource>;
  preferredGroup: THREE.XRTargetRaySpace | null;
  preferredSource: XRInputSource | null;
  pendingSelect: PendingSelect | null;
  lastPointer: { x: number; y: number } | null;
  provisionalSurface: THREE.Object3D | null;
  sessionHandlersRegistered: boolean;
  groupHandlersRegistered: boolean;
  referenceHandlerRegistered: boolean;
  cleaned: boolean;
  endedEmitted: boolean;
  endPromise: Promise<void> | null;
  handle: XRSessionHandle | null;
  readonly onEnd: (event: XRSessionEvent) => void;
  readonly onVisibilityChange: (event: XRSessionEvent) => void;
  readonly onInputSourcesChange: (event: XRInputSourcesChangeEvent) => void;
  readonly onSelect: (event: XRInputSourceEvent) => void;
  readonly onReferenceReset: (event: XRReferenceSpaceEvent) => void;
  readonly groupHandlers: readonly [
    {
      connected: (event: ControllerConnectedEvent) => void;
      disconnected: (event: ControllerDisconnectedEvent) => void;
    },
    {
      connected: (event: ControllerConnectedEvent) => void;
      disconnected: (event: ControllerDisconnectedEvent) => void;
    },
  ];
}

function applicationError(code: ConstructorParameters<typeof AppError>[0], cause?: unknown): AppError {
  return cause === undefined ? new AppError(code) : new AppError(code, { cause });
}

function requestError(cause: unknown): AppError {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'name' in cause &&
    cause.name === 'NotSupportedError'
  ) {
    return applicationError('IMMERSIVE_AR_UNSUPPORTED', cause);
  }
  return applicationError('XR_SESSION_REJECTED', cause);
}

function isFiniteCamera(camera: THREE.Camera): boolean {
  const position = camera.getWorldPosition(new THREE.Vector3());
  const quaternion = camera.getWorldQuaternion(new THREE.Quaternion());
  return (
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    Number.isFinite(position.z) &&
    Number.isFinite(quaternion.x) &&
    Number.isFinite(quaternion.y) &&
    Number.isFinite(quaternion.z) &&
    Number.isFinite(quaternion.w)
  );
}

function pointerPreference(source: XRInputSource): number {
  if (source.targetRayMode !== 'tracked-pointer') {
    return Number.POSITIVE_INFINITY;
  }
  switch (source.handedness) {
    case 'right':
      return 0;
    case 'left':
      return 1;
    case 'none':
      return 2;
  }
}

class SessionController implements XRSessionController {
  private readonly options: XRSessionControllerOptions;
  private readonly sceneResources: XRSceneResources;
  private readonly raycaster = new THREE.Raycaster();
  private readonly subscribers = new Set<(event: XRRuntimeEvent) => void>();
  private readonly resizeHandler: () => void;
  private sessionGeneration = 0;
  private context: SessionContext | null = null;
  private pendingStart: Promise<XRSessionHandle> | null = null;
  private interactionSurface: XRInteractionSurface | null = null;
  private pointerTargetKind: PointerTargetKind = 'none';
  private readonly reticleQuaternion = new THREE.Quaternion();
  private readonly reticleNormal = new THREE.Vector3();
  private animationLoopInstalled = false;
  private lifecycle: 'live' | 'disposing' | 'disposed' = 'live';
  private disposePromise: Promise<void> | null = null;

  public constructor(options: XRSessionControllerOptions) {
    this.options = options;
    try {
      this.sceneResources = createXRSceneResources(options.root, options.windowRef);
    } catch (cause) {
      throw applicationError('XR_RENDERER_INIT_FAILED', cause);
    }
    this.resizeHandler = (): void => {
      this.sceneResources.resize();
    };
    options.windowRef.addEventListener('resize', this.resizeHandler);
  }

  public start(): ReturnType<XRSessionController['start']> {
    this.assertLive();
    if (this.pendingStart !== null || this.context !== null) {
      throw applicationError('XR_SESSION_ALREADY_ACTIVE');
    }
    if (this.options.xrSystem === undefined) {
      throw applicationError('XR_API_UNAVAILABLE');
    }

    const generation = ++this.sessionGeneration;
    const sessionInit: ImmersiveARSessionInit = {
      optionalFeatures: ['local-floor'],
    };
    let sessionPromise: Promise<XRSession>;
    try {
      sessionPromise = this.options.xrSystem.requestSession('immersive-ar', sessionInit);
    } catch (cause) {
      sessionPromise = Promise.reject(cause);
    }

    const result = this.initializeSession(generation, sessionPromise);
    this.pendingStart = result;
    void result.then(
      () => {
        if (this.pendingStart === result) {
          this.pendingStart = null;
        }
      },
      () => {
        if (this.pendingStart === result) {
          this.pendingStart = null;
        }
      },
    );
    return { generation, result };
  }

  public getActive(): XRSessionHandle | null {
    this.assertLive();
    return this.context?.handle ?? null;
  }

  public getScene(): THREE.Scene {
    this.assertLive();
    return this.sceneResources.scene;
  }

  public getAppCamera(): THREE.PerspectiveCamera {
    this.assertLive();
    return this.sceneResources.appCamera;
  }

  public setInteractionSurface(surface: XRInteractionSurface | null): void {
    this.assertLive();
    if (
      surface === this.interactionSurface ||
      (surface !== null &&
        this.interactionSurface !== null &&
        surface.object === this.interactionSurface.object &&
        surface.widthPx === this.interactionSurface.widthPx &&
        surface.heightPx === this.interactionSurface.heightPx)
    ) {
      return;
    }
    if (surface !== null && (surface.widthPx !== 1024 || surface.heightPx !== 768)) {
      throw new TypeError('XR interaction surface must use the canonical 1024x768 coordinates');
    }
    this.interactionSurface = surface;
    if (this.context !== null) {
      this.context.pendingSelect = null;
      if (this.context.lastPointer !== null) {
        this.emit({ sessionGeneration: this.context.generation, type: 'pointerLeave' });
      }
      this.context.lastPointer = null;
      this.context.provisionalSurface = null;
    }
  }

  public setPointerTarget(kind: PointerTargetKind): void {
    if (this.lifecycle !== 'live') {
      return;
    }
    this.pointerTargetKind = kind;
  }

  public subscribe(listener: (event: XRRuntimeEvent) => void): Unsubscribe {
    this.assertLive();
    this.subscribers.add(listener);
    let subscribed = true;
    return (): void => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.subscribers.delete(listener);
    };
  }

  public resourceCounts(): XRCounts {
    const resourcesLive = this.lifecycle !== 'disposed';
    const context = this.context;
    return {
      renderers: resourcesLive ? 1 : 0,
      rendererCanvases: resourcesLive ? 1 : 0,
      scenes: resourcesLive ? 1 : 0,
      appCameras: resourcesLive ? 1 : 0,
      controllerGroups: resourcesLive ? 2 : 0,
      controllerRayVisuals: resourcesLive ? 2 : 0,
      pointerReticles: resourcesLive ? 1 : 0,
      reticleGeometries: resourcesLive ? 1 : 0,
      reticleMaterials: resourcesLive ? 1 : 0,
      activeXRSessions: context?.handle !== null && context?.handle !== undefined ? 1 : 0,
      registeredXRSessionHandlers: context?.sessionHandlersRegistered === true ? 4 : 0,
      registeredReferenceSpaceHandlers: context?.referenceHandlerRegistered === true ? 1 : 0,
      registeredControllerGroupHandlers: context?.groupHandlersRegistered === true ? 4 : 0,
      controllerBindings: context?.preferredSource !== null && context?.preferredSource !== undefined ? 1 : 0,
    };
  }

  public dispose(): Promise<void> {
    if (this.disposePromise !== null) {
      return this.disposePromise;
    }
    if (this.lifecycle === 'disposed') {
      return Promise.resolve();
    }

    this.lifecycle = 'disposing';
    ++this.sessionGeneration;
    const pendingAtDisposal = this.pendingStart;
    this.disposePromise = (async (): Promise<void> => {
      const context = this.context;
      if (context !== null) {
        await this.endContext(context);
        this.cleanupContext(context, false);
      }
      if (pendingAtDisposal !== null) {
        await pendingAtDisposal.catch(() => undefined);
      }
      const lateContext = this.context;
      if (lateContext !== null) {
        await this.endContext(lateContext);
        this.cleanupContext(lateContext, false);
      }

      this.options.windowRef.removeEventListener('resize', this.resizeHandler);
      this.sceneResources.dispose();
      this.interactionSurface = null;
      this.subscribers.clear();
      this.pendingStart = null;
      this.lifecycle = 'disposed';
    })();
    return this.disposePromise;
  }

  private async initializeSession(
    generation: number,
    sessionPromise: Promise<XRSession>,
  ): Promise<XRSessionHandle> {
    let session: XRSession;
    try {
      session = await sessionPromise;
    } catch (cause) {
      throw requestError(cause);
    }

    if (!this.isCurrentGeneration(generation)) {
      await this.bestEffortEnd(session);
      throw applicationError(this.lifecycle === 'live' ? 'XR_SESSION_REJECTED' : 'APP_DISPOSED');
    }

    const context = this.createContext(generation, session);
    this.context = context;
    try {
      this.registerSessionHandlers(context);
      this.registerGroupHandlers(context);
    } catch (cause) {
      await this.failPartialSession(context);
      throw applicationError('XR_RENDERER_INIT_FAILED', cause);
    }

    try {
      // setFramebufferScaleFactor is only read when the layer is constructed at
      // setSession time, so it must be set first. Feature-detect the static helper: it
      // is absent in the test environment and non-Quest browsers, where 1 is a safe
      // default that still exercises the ordering.
      const nativeScale =
        typeof XRWebGLLayer !== 'undefined' &&
        typeof XRWebGLLayer.getNativeFramebufferScaleFactor === 'function'
          ? XRWebGLLayer.getNativeFramebufferScaleFactor(session)
          : Number.NaN;
      const framebufferScale = Number.isFinite(nativeScale) && nativeScale > 0
        ? Math.min(nativeScale, XR_MAX_FRAMEBUFFER_SCALE)
        : 1;
      this.sceneResources.renderer.xr.setFramebufferScaleFactor(framebufferScale);
      await this.sceneResources.renderer.xr.setSession(session);
    } catch (cause) {
      await this.failPartialSession(context);
      throw applicationError('XR_RENDERER_INIT_FAILED', cause);
    }
    if (!this.isCurrentContext(context)) {
      await this.failPartialSession(context);
      throw applicationError(this.lifecycle === 'live' ? 'XR_SESSION_REJECTED' : 'APP_DISPOSED');
    }

    if (!this.animationLoopInstalled) {
      try {
        this.sceneResources.renderer.setAnimationLoop(this.renderFrame);
        this.animationLoopInstalled = true;
      } catch (cause) {
        await this.failPartialSession(context);
        throw applicationError('XR_RENDERER_INIT_FAILED', cause);
      }
    }

    let referenceSpace: XRReferenceSpace;
    try {
      try {
        referenceSpace = await session.requestReferenceSpace('local-floor');
      } catch {
        referenceSpace = await session.requestReferenceSpace('local');
      }
    } catch (cause) {
      await this.failPartialSession(context);
      throw applicationError('REFERENCE_SPACE_UNAVAILABLE', cause);
    }
    if (!this.isCurrentContext(context)) {
      await this.failPartialSession(context);
      throw applicationError(this.lifecycle === 'live' ? 'XR_SESSION_REJECTED' : 'APP_DISPOSED');
    }

    context.referenceSpace = referenceSpace;
    try {
      this.sceneResources.renderer.xr.setReferenceSpace(referenceSpace);
      referenceSpace.addEventListener('reset', context.onReferenceReset);
      context.referenceHandlerRegistered = true;
    } catch (cause) {
      await this.failPartialSession(context);
      throw applicationError('XR_RENDERER_INIT_FAILED', cause);
    }

    const handle: XRSessionHandle = {
      generation,
      session,
      referenceSpace,
      getAppCamera: (): THREE.PerspectiveCamera => {
        this.assertHandleLive(context);
        return this.sceneResources.appCamera;
      },
      getViewerCamera: (): THREE.ArrayCamera => {
        this.assertHandleLive(context);
        return this.sceneResources.renderer.xr.getCamera();
      },
      end: (): Promise<void> => this.endContext(context),
    };
    context.handle = handle;
    this.rebindPreferredPointer(context);
    return handle;
  }

  private createContext(generation: number, session: XRSession): SessionContext {
    const context = {} as SessionContext;
    Object.assign(context, {
      generation,
      session,
      referenceSpace: null,
      groupSources: new Map<THREE.XRTargetRaySpace, XRInputSource>(),
      preferredGroup: null,
      preferredSource: null,
      pendingSelect: null,
      lastPointer: null,
      provisionalSurface: null,
      sessionHandlersRegistered: false,
      groupHandlersRegistered: false,
      referenceHandlerRegistered: false,
      cleaned: false,
      endedEmitted: false,
      endPromise: null,
      handle: null,
      onEnd: (_event: XRSessionEvent): void => {
        if (!this.isCurrentContext(context)) {
          return;
        }
        this.finishSession(context, true);
      },
      onVisibilityChange: (_event: XRSessionEvent): void => {
        if (!this.isCurrentContext(context)) {
          return;
        }
        if (session.visibilityState !== 'visible') {
          context.pendingSelect = null;
        }
        this.emit({
          sessionGeneration: generation,
          type: 'visibilityChanged',
          visibilityState: session.visibilityState,
        });
      },
      onInputSourcesChange: (event: XRInputSourcesChangeEvent): void => {
        if (!this.isCurrentContext(context)) {
          return;
        }
        for (const removed of event.removed) {
          for (const [group, source] of context.groupSources) {
            if (source === removed) {
              context.groupSources.delete(group);
            }
          }
          if (context.pendingSelect?.source === removed) {
            context.pendingSelect = null;
          }
        }
        this.rebindPreferredPointer(context);
      },
      onSelect: (event: XRInputSourceEvent): void => {
        if (!this.isCurrentContext(context) || event.inputSource !== context.preferredSource) {
          return;
        }
        context.pendingSelect ??= {
          source: event.inputSource,
          nowMs: this.options.monotonicNowMs(),
        };
      },
      onReferenceReset: (_event: XRReferenceSpaceEvent): void => {
        if (!this.isCurrentContext(context)) {
          return;
        }
        context.pendingSelect = null;
        this.emit({ sessionGeneration: generation, type: 'referenceReset' });
      },
      groupHandlers: this.sceneResources.controllerGroups.map((group) => ({
        connected: (event: ControllerConnectedEvent): void => {
          if (!this.isCurrentContext(context)) {
            return;
          }
          context.groupSources.set(group, event.data);
          this.rebindPreferredPointer(context);
        },
        disconnected: (event: ControllerDisconnectedEvent): void => {
          if (!this.isCurrentContext(context)) {
            return;
          }
          if (context.groupSources.get(group) === event.data) {
            context.groupSources.delete(group);
          }
          if (context.pendingSelect?.source === event.data) {
            context.pendingSelect = null;
          }
          this.rebindPreferredPointer(context);
        },
      })) as unknown as SessionContext['groupHandlers'],
    } satisfies Partial<SessionContext>);
    return context;
  }

  private registerSessionHandlers(context: SessionContext): void {
    try {
      context.session.addEventListener('end', context.onEnd);
      context.session.addEventListener('visibilitychange', context.onVisibilityChange);
      context.session.addEventListener('inputsourceschange', context.onInputSourcesChange);
      context.session.addEventListener('select', context.onSelect);
      context.sessionHandlersRegistered = true;
    } catch (cause) {
      context.session.removeEventListener('end', context.onEnd);
      context.session.removeEventListener('visibilitychange', context.onVisibilityChange);
      context.session.removeEventListener('inputsourceschange', context.onInputSourcesChange);
      context.session.removeEventListener('select', context.onSelect);
      throw cause;
    }
  }

  private registerGroupHandlers(context: SessionContext): void {
    try {
      for (const [index, group] of this.sceneResources.controllerGroups.entries()) {
        const handlers = context.groupHandlers[index];
        if (handlers === undefined) {
          continue;
        }
        group.addEventListener('connected', handlers.connected);
        group.addEventListener('disconnected', handlers.disconnected);
      }
      context.groupHandlersRegistered = true;
    } catch (cause) {
      for (const [index, group] of this.sceneResources.controllerGroups.entries()) {
        const handlers = context.groupHandlers[index];
        if (handlers !== undefined) {
          group.removeEventListener('connected', handlers.connected);
          group.removeEventListener('disconnected', handlers.disconnected);
        }
      }
      throw cause;
    }
  }

  private readonly renderFrame: XRFrameRequestCallback = (_time, frame): void => {
    const context = this.context;
    if (
      this.lifecycle !== 'live' ||
      context === null ||
      context.handle === null ||
      context.referenceSpace === null ||
      context.generation !== this.sessionGeneration
    ) {
      return;
    }

    const hasViewerPose =
      frame !== undefined && frame.getViewerPose(context.referenceSpace) != null;

    const pointer = this.readPointer(context);
    this.emitPointerChange(context, pointer);
    this.consumeSelect(context, pointer);

    this.sceneResources.renderer.render(
      this.sceneResources.scene,
      this.sceneResources.appCamera,
    );

    const viewerCamera = this.sceneResources.renderer.xr.getCamera();
    if (
      hasViewerPose &&
      (viewerCamera.cameras as readonly THREE.Camera[]).length > 0 &&
      isFiniteCamera(viewerCamera) &&
      this.interactionSurface !== null &&
      context.provisionalSurface !== this.interactionSurface.object &&
      this.sceneResources.poseSurfaceFromCamera(this.interactionSurface.object, viewerCamera)
    ) {
      context.provisionalSurface = this.interactionSurface.object;
    }
  };

  private readPointer(context: SessionContext): { x: number; y: number } | null {
    // A hidden panel (interaction surface object invisible) yields no hit, which quiets
    // hover, selection, and the reticle without nulling the surface — so it is never
    // re-posed. See ADR 0002.
    if (
      context.preferredGroup === null ||
      this.interactionSurface === null ||
      !this.interactionSurface.object.visible
    ) {
      this.updatePointerVisuals(context, null);
      return null;
    }
    context.preferredGroup.updateWorldMatrix(true, false);
    this.interactionSurface.object.updateWorldMatrix(true, false);
    this.raycaster.setFromXRController(context.preferredGroup);
    const hit = this.raycaster.intersectObject(this.interactionSurface.object, false)[0];
    const uv = hit?.uv;
    if (hit === undefined || uv === undefined || !Number.isFinite(uv.x) || !Number.isFinite(uv.y)) {
      this.updatePointerVisuals(context, null);
      return null;
    }
    this.updatePointerVisuals(context, hit);
    return {
      x: uv.x * this.interactionSurface.widthPx,
      y: (1 - uv.y) * this.interactionSurface.heightPx,
    };
  }

  /** Place/hide the reticle and shorten the ray from the intersection readPointer computed. */
  private updatePointerVisuals(context: SessionContext, hit: THREE.Intersection | null): void {
    const reticle = this.sceneResources.reticle;
    if (hit === null || this.interactionSurface === null) {
      reticle.visible = false;
      this.sceneResources.rayMaterial.color.set(RAY_COLOR_IDLE);
      for (const ray of this.sceneResources.controllerRays) {
        ray.scale.z = 1;
      }
      return;
    }
    const surface = this.interactionSurface.object;
    surface.getWorldQuaternion(this.reticleQuaternion);
    this.reticleNormal.copy(PANEL_LOCAL_NORMAL).applyQuaternion(this.reticleQuaternion);
    reticle.position.copy(hit.point).addScaledVector(this.reticleNormal, RETICLE_SURFACE_OFFSET_M);
    reticle.quaternion.copy(this.reticleQuaternion);
    reticle.scale.setScalar(RETICLE_ANGULAR_SIZE * hit.distance);
    reticle.material.color.set(reticleColor(this.pointerTargetKind));
    reticle.visible = true;
    reticle.updateMatrixWorld(true);
    this.sceneResources.rayMaterial.color.set(RAY_COLOR_ACTIVE);
    const preferredRay = this.preferredRay(context);
    if (preferredRay !== null) {
      preferredRay.scale.z = hit.distance;
    }
  }

  private preferredRay(context: SessionContext): THREE.Line | null {
    if (context.preferredGroup === null) {
      return null;
    }
    const index = this.sceneResources.controllerGroups.indexOf(context.preferredGroup);
    return index >= 0 ? this.sceneResources.controllerRays[index] ?? null : null;
  }

  private emitPointerChange(
    context: SessionContext,
    pointer: { x: number; y: number } | null,
  ): void {
    if (pointer === null) {
      if (context.lastPointer !== null) {
        context.lastPointer = null;
        this.emit({ sessionGeneration: context.generation, type: 'pointerLeave' });
      }
      return;
    }
    if (context.lastPointer?.x === pointer.x && context.lastPointer.y === pointer.y) {
      return;
    }
    context.lastPointer = pointer;
    this.emit({
      sessionGeneration: context.generation,
      type: 'pointerMove',
      canvasX: pointer.x,
      canvasY: pointer.y,
      nowMs: this.options.monotonicNowMs(),
    });
  }

  private consumeSelect(
    context: SessionContext,
    pointer: { x: number; y: number } | null,
  ): void {
    const pending = context.pendingSelect;
    if (pending === null) {
      return;
    }
    context.pendingSelect = null;
    if (pending.source !== context.preferredSource) {
      return;
    }
    this.emit(
      pointer === null
        ? { sessionGeneration: context.generation, type: 'primarySelect', nowMs: pending.nowMs }
        : {
            sessionGeneration: context.generation,
            type: 'primarySelect',
            nowMs: pending.nowMs,
            canvasX: pointer.x,
            canvasY: pointer.y,
          },
    );
  }

  private rebindPreferredPointer(context: SessionContext): void {
    if (!this.isCurrentContext(context)) {
      return;
    }
    const previousSource = context.preferredSource;
    let preferredGroup: THREE.XRTargetRaySpace | null = null;
    let preferredSource: XRInputSource | null = null;
    let preferredScore = Number.POSITIVE_INFINITY;

    for (const group of this.sceneResources.controllerGroups) {
      const source = context.groupSources.get(group);
      if (source === undefined) {
        continue;
      }
      const score = pointerPreference(source);
      if (score < preferredScore) {
        preferredScore = score;
        preferredGroup = group;
        preferredSource = source;
      }
    }

    if (previousSource !== preferredSource) {
      context.pendingSelect = null;
      if (context.lastPointer !== null) {
        this.emit({ sessionGeneration: context.generation, type: 'pointerLeave' });
      }
      context.lastPointer = null;
    }
    context.preferredGroup = preferredGroup;
    context.preferredSource = preferredSource;
    for (const [index, group] of this.sceneResources.controllerGroups.entries()) {
      const ray = this.sceneResources.controllerRays[index];
      if (ray !== undefined) {
        ray.visible = group === preferredGroup;
      }
    }
    if ((previousSource !== null) !== (preferredSource !== null)) {
      this.emit({
        sessionGeneration: context.generation,
        type: 'inputAvailabilityChanged',
        hasTrackedPointer: preferredSource !== null,
      });
    }
  }

  private endContext(context: SessionContext): Promise<void> {
    if (context.endPromise !== null) {
      return context.endPromise;
    }
    if (context.cleaned) {
      return Promise.resolve();
    }
    let browserEnd: Promise<void>;
    try {
      browserEnd = context.session.end();
    } catch {
      browserEnd = Promise.resolve();
    }
    context.endPromise = browserEnd
      .catch(() => undefined)
      .then(() => {
        if (!context.cleaned) {
          this.finishSession(context, true);
        }
      });
    return context.endPromise;
  }

  private finishSession(context: SessionContext, emitEnded: boolean): void {
    if (context.cleaned) {
      return;
    }
    const generation = context.generation;
    this.cleanupContext(context, true);
    if (emitEnded && !context.endedEmitted) {
      context.endedEmitted = true;
      this.emit({ sessionGeneration: generation, type: 'ended' });
    }
  }

  private cleanupContext(context: SessionContext, incrementGeneration: boolean): void {
    if (context.cleaned) {
      return;
    }
    context.cleaned = true;
    if (incrementGeneration && this.sessionGeneration <= context.generation) {
      this.sessionGeneration = context.generation + 1;
    }

    if (context.referenceHandlerRegistered && context.referenceSpace !== null) {
      context.referenceSpace.removeEventListener('reset', context.onReferenceReset);
      context.referenceHandlerRegistered = false;
    }
    if (context.groupHandlersRegistered) {
      for (const [index, group] of this.sceneResources.controllerGroups.entries()) {
        const handlers = context.groupHandlers[index];
        if (handlers !== undefined) {
          group.removeEventListener('connected', handlers.connected);
          group.removeEventListener('disconnected', handlers.disconnected);
        }
      }
      context.groupHandlersRegistered = false;
    }
    if (context.sessionHandlersRegistered) {
      context.session.removeEventListener('end', context.onEnd);
      context.session.removeEventListener('visibilitychange', context.onVisibilityChange);
      context.session.removeEventListener('inputsourceschange', context.onInputSourcesChange);
      context.session.removeEventListener('select', context.onSelect);
      context.sessionHandlersRegistered = false;
    }
    context.groupSources.clear();
    context.preferredGroup = null;
    context.preferredSource = null;
    context.pendingSelect = null;
    context.lastPointer = null;
    context.handle = null;
    for (const ray of this.sceneResources.controllerRays) {
      ray.visible = false;
    }
    if (this.context === context) {
      this.context = null;
    }
  }

  private async failPartialSession(context: SessionContext): Promise<void> {
    if (context.cleaned) {
      if (context.endPromise !== null) {
        await context.endPromise;
      }
      return;
    }
    this.cleanupContext(context, true);
    if (context.endPromise !== null) {
      await context.endPromise;
    } else {
      await this.bestEffortEnd(context.session);
    }
  }

  private async bestEffortEnd(session: XRSession): Promise<void> {
    try {
      await session.end();
    } catch {
      // Cleanup is authoritative even when the user agent rejects end().
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.lifecycle === 'live' && generation === this.sessionGeneration;
  }

  private isCurrentContext(context: SessionContext): boolean {
    return (
      this.lifecycle === 'live' &&
      !context.cleaned &&
      this.context === context &&
      context.generation === this.sessionGeneration
    );
  }

  private assertHandleLive(context: SessionContext): void {
    if (!this.isCurrentContext(context) || context.handle === null) {
      throw applicationError('APP_DISPOSED');
    }
  }

  private assertLive(): void {
    if (this.lifecycle !== 'live') {
      throw applicationError('APP_DISPOSED');
    }
  }

  private emit(event: XRRuntimeEvent): void {
    if (this.lifecycle !== 'live') {
      return;
    }
    const snapshot = [...this.subscribers];
    for (const subscriber of snapshot) {
      if (!this.subscribers.has(subscriber)) {
        continue;
      }
      try {
        subscriber(event);
      } catch {
        console.error('INTERNAL_LISTENER_ERROR');
      }
    }
  }
}

export const createXRSessionController: CreateXRSessionController = (options) =>
  new SessionController(options);
