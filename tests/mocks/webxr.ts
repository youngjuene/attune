import * as THREE from 'three';

import type { XRSceneResources } from '../../src/xr/scene';

export interface SessionRequestCall {
  readonly mode: XRSessionMode;
  readonly init?: XRSessionInit;
}

export class MockReferenceSpace extends EventTarget {
  public emitReset(): void {
    this.dispatchEvent(new Event('reset'));
  }
}

export class MockXRSession extends EventTarget {
  public readonly referenceSpaceRequests: XRReferenceSpaceType[] = [];
  public readonly inputSources: XRInputSource[] = [];
  public visibilityState: XRVisibilityState = 'visible';
  public endCallCount = 0;
  public autoEmitEnd = true;
  public localFloorError: unknown | null = null;
  public localError: unknown | null = null;
  public readonly localFloorSpace = new MockReferenceSpace();
  public readonly localSpace = new MockReferenceSpace();

  public requestReferenceSpace(type: XRReferenceSpaceType): Promise<XRReferenceSpace> {
    this.referenceSpaceRequests.push(type);
    if (type === 'local-floor') {
      return this.localFloorError === null
        ? Promise.resolve(this.localFloorSpace as unknown as XRReferenceSpace)
        : Promise.reject(this.localFloorError);
    }
    if (type === 'local') {
      return this.localError === null
        ? Promise.resolve(this.localSpace as unknown as XRReferenceSpace)
        : Promise.reject(this.localError);
    }
    return Promise.reject(new DOMException('unsupported', 'NotSupportedError'));
  }

  public end(): Promise<void> {
    ++this.endCallCount;
    if (this.autoEmitEnd) {
      this.dispatchEvent(new Event('end'));
    }
    return Promise.resolve();
  }

  public emitVisibility(state: XRVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }

  public emitInputSourcesChange(
    added: readonly XRInputSource[],
    removed: readonly XRInputSource[],
  ): void {
    const event = new Event('inputsourceschange');
    Object.defineProperties(event, {
      added: { value: added },
      removed: { value: removed },
    });
    this.dispatchEvent(event);
  }

  public emitSelect(inputSource: XRInputSource): void {
    const event = new Event('select');
    Object.defineProperty(event, 'inputSource', { value: inputSource });
    this.dispatchEvent(event);
  }
}

export class MockXRSystem {
  public readonly requestCalls: SessionRequestCall[] = [];
  private readonly queued: Array<Promise<XRSession>> = [];

  public enqueue(session: MockXRSession | Promise<XRSession>): void {
    this.queued.push(
      session instanceof MockXRSession
        ? Promise.resolve(session as unknown as XRSession)
        : session,
    );
  }

  public requestSession(mode: XRSessionMode, init?: XRSessionInit): Promise<XRSession> {
    this.requestCalls.push(init === undefined ? { mode } : { mode, init });
    const next = this.queued.shift();
    if (next === undefined) {
      return Promise.reject(new DOMException('no queued session', 'InvalidStateError'));
    }
    return next;
  }

  public asSystem(): XRSystem {
    return this as unknown as XRSystem;
  }
}

export function inputSource(
  handedness: XRHandedness,
  targetRayMode: XRTargetRayMode = 'tracked-pointer',
): XRInputSource {
  return { handedness, targetRayMode } as XRInputSource;
}

export class MockXRFrame {
  public constructor(public viewerPose: XRViewerPose | null = {} as XRViewerPose) {}

  public getViewerPose(_referenceSpace: XRReferenceSpace): XRViewerPose | null {
    return this.viewerPose;
  }
}

export interface MockRendererState {
  readonly setSessionCalls: XRSession[];
  readonly setReferenceSpaceCalls: XRReferenceSpace[];
  readonly framebufferScaleCalls: Array<{ scale: number; beforeSession: boolean }>;
  readonly getCameraArguments: unknown[][];
  readonly renderCalls: Array<{ scene: THREE.Scene; camera: THREE.Camera }>;
  readonly animationLoopCalls: Array<XRFrameRequestCallback | null>;
  setSessionError: unknown | null;
  viewerCamera: THREE.ArrayCamera;
  viewerCameraAfterRender: THREE.ArrayCamera | null;
  animationLoop: XRFrameRequestCallback | null;
  disposed: boolean;
}

export interface MockSceneState {
  readonly resources: XRSceneResources;
  readonly renderer: MockRendererState;
  poseCallCount: number;
  resizeCallCount: number;
  disposed: boolean;
  runFrame(frame?: MockXRFrame): void;
}

export function createMockSceneState(root: HTMLElement): MockSceneState {
  const scene = new THREE.Scene();
  const appCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 100);
  appCamera.position.set(0, 1.6, 0);
  appCamera.updateMatrixWorld(true);
  const firstGroup = new THREE.Group() as THREE.XRTargetRaySpace;
  const secondGroup = new THREE.Group() as THREE.XRTargetRaySpace;
  firstGroup.position.set(0, 1.52, 0);
  secondGroup.position.set(0, 1.52, 0);
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(),
    new THREE.Vector3(0, 0, -1),
  ]);
  const material = new THREE.LineBasicMaterial();
  const firstRay = new THREE.Line(geometry, material);
  const secondRay = new THREE.Line(geometry, material);
  firstRay.visible = false;
  secondRay.visible = false;
  firstGroup.add(firstRay);
  secondGroup.add(secondRay);
  scene.add(firstGroup, secondGroup);

  const reticleGeometry = new THREE.RingGeometry(0.55, 1, 24);
  const reticleMaterial = new THREE.MeshBasicMaterial();
  const reticle = new THREE.Mesh(reticleGeometry, reticleMaterial);
  reticle.visible = false;
  scene.add(reticle);

  const view = new THREE.PerspectiveCamera();
  const viewerCamera = new THREE.ArrayCamera([view]);
  viewerCamera.position.set(0, 1.6, 0);
  viewerCamera.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  root.append(canvas);

  const rendererState: MockRendererState = {
    setSessionCalls: [],
    setReferenceSpaceCalls: [],
    framebufferScaleCalls: [],
    getCameraArguments: [],
    renderCalls: [],
    animationLoopCalls: [],
    setSessionError: null,
    viewerCamera,
    viewerCameraAfterRender: null,
    animationLoop: null,
    disposed: false,
  };

  const xr = {
    setSession: async (session: XRSession): Promise<void> => {
      rendererState.setSessionCalls.push(session);
      if (rendererState.setSessionError !== null) {
        throw rendererState.setSessionError;
      }
    },
    setReferenceSpace: (space: XRReferenceSpace): void => {
      rendererState.setReferenceSpaceCalls.push(space);
    },
    setFramebufferScaleFactor: (scale: number): void => {
      rendererState.framebufferScaleCalls.push({
        scale,
        beforeSession: rendererState.setSessionCalls.length === 0,
      });
    },
    getCamera: (...args: unknown[]): THREE.ArrayCamera => {
      rendererState.getCameraArguments.push(args);
      return rendererState.viewerCamera;
    },
  };
  const renderer = {
    domElement: canvas,
    xr,
    setAnimationLoop: (callback: XRFrameRequestCallback | null): void => {
      rendererState.animationLoop = callback;
      rendererState.animationLoopCalls.push(callback);
    },
    render: (renderedScene: THREE.Scene, camera: THREE.Camera): void => {
      rendererState.renderCalls.push({ scene: renderedScene, camera });
      if (rendererState.viewerCameraAfterRender !== null) {
        rendererState.viewerCamera = rendererState.viewerCameraAfterRender;
        rendererState.viewerCameraAfterRender = null;
      }
    },
    dispose: (): void => {
      rendererState.disposed = true;
    },
  } as unknown as THREE.WebGLRenderer;

  const state = {} as MockSceneState;
  const resources: XRSceneResources = {
    renderer,
    scene,
    appCamera,
    controllerGroups: [firstGroup, secondGroup],
    controllerRays: [firstRay, secondRay],
    rayMaterial: material,
    reticle,
    resize: (): void => {
      ++state.resizeCallCount;
    },
    poseSurfaceFromCamera: (surface, camera): boolean => {
      ++state.poseCallCount;
      surface.position
        .copy(camera.getWorldPosition(new THREE.Vector3()))
        .add(new THREE.Vector3(0, 0, -1.25));
      surface.position.y = camera.getWorldPosition(new THREE.Vector3()).y - 0.08;
      surface.quaternion.identity();
      surface.updateMatrixWorld(true);
      return true;
    },
    dispose: (): void => {
      if (state.disposed) {
        return;
      }
      state.disposed = true;
      scene.remove(reticle);
      reticleGeometry.dispose();
      reticleMaterial.dispose();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      canvas.remove();
    },
  };
  Object.assign(state, {
    resources,
    renderer: rendererState,
    poseCallCount: 0,
    resizeCallCount: 0,
    disposed: false,
    runFrame: (frame?: MockXRFrame): void => {
      const loop = rendererState.animationLoop as unknown as
        | ((time: number, xrFrame?: XRFrame) => void)
        | null;
      loop?.(
        0,
        frame === undefined ? undefined : (frame as unknown as XRFrame),
      );
    },
  });
  return state;
}

export function connectController(group: THREE.XRTargetRaySpace, source: XRInputSource): void {
  group.dispatchEvent({ type: 'connected', data: source });
}

export function disconnectController(group: THREE.XRTargetRaySpace, source: XRInputSource): void {
  group.dispatchEvent({ type: 'disconnected', data: source });
}
