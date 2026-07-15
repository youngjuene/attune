import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MockReferenceSpace,
  MockXRFrame,
  MockXRSession,
  MockXRSystem,
  createMockSceneState,
  type MockSceneState,
} from './mocks/webxr';

const sceneStates: MockSceneState[] = [];

vi.mock('../src/xr/scene', () => ({
  createXRSceneResources: (root: HTMLElement): MockSceneState['resources'] => {
    const state = createMockSceneState(root);
    sceneStates.push(state);
    return state.resources;
  },
}));

import { createXRSessionController } from '../src/xr/XRSessionController';

function controllerFor(system: MockXRSystem) {
  return createXRSessionController({
    root: document.querySelector<HTMLElement>('#app')!,
    xrSystem: system.asSystem(),
    windowRef: window,
    monotonicNowMs: () => 123,
  });
}

describe('XRSessionController session lifecycle', () => {
  beforeEach(() => {
    sceneStates.length = 0;
    document.querySelector<HTMLElement>('#app')!.replaceChildren();
  });

  it('requests the exact immersive session and prefers local-floor', async () => {
    const system = new MockXRSystem();
    const session = new MockXRSession();
    system.enqueue(session);
    const controller = controllerFor(system);

    const operation = controller.start();
    expect(system.requestCalls).toEqual([
      { mode: 'immersive-ar', init: { optionalFeatures: ['local-floor'] } },
    ]);
    expect(Object.keys(system.requestCalls[0]!.init!)).toEqual(['optionalFeatures']);
    const handle = await operation.result;

    expect(operation.generation).toBe(1);
    expect(handle.generation).toBe(1);
    expect(session.referenceSpaceRequests).toEqual(['local-floor']);
    expect(handle.referenceSpace).toBe(session.localFloorSpace);
    expect(sceneStates[0]!.renderer.setSessionCalls).toEqual([session]);
    expect(sceneStates[0]!.renderer.setReferenceSpaceCalls).toEqual([session.localFloorSpace]);
    expect(controller.resourceCounts()).toMatchObject({
      renderers: 1,
      rendererCanvases: 1,
      scenes: 1,
      appCameras: 1,
      controllerGroups: 2,
      controllerRayVisuals: 2,
      activeXRSessions: 1,
      registeredXRSessionHandlers: 4,
      registeredReferenceSpaceHandlers: 1,
      registeredControllerGroupHandlers: 4,
      controllerBindings: 0,
    });
    expect(() => controller.start()).toThrowError(
      expect.objectContaining({ code: 'XR_SESSION_ALREADY_ACTIVE' }),
    );

    await controller.dispose();
  });

  it('falls back from local-floor to local and maps complete reference failure', async () => {
    const system = new MockXRSystem();
    const fallbackSession = new MockXRSession();
    fallbackSession.localFloorError = new DOMException('floor unavailable', 'NotSupportedError');
    system.enqueue(fallbackSession);
    const controller = controllerFor(system);

    const fallbackHandle = await controller.start().result;
    expect(fallbackSession.referenceSpaceRequests).toEqual(['local-floor', 'local']);
    expect(fallbackHandle.referenceSpace).toBe(fallbackSession.localSpace);
    await fallbackHandle.end();

    const failedSession = new MockXRSession();
    failedSession.localFloorError = new DOMException('floor unavailable', 'NotSupportedError');
    failedSession.localError = new DOMException('local unavailable', 'NotSupportedError');
    system.enqueue(failedSession);
    await expect(controller.start().result).rejects.toMatchObject({
      name: 'AppError',
      code: 'REFERENCE_SPACE_UNAVAILABLE',
    });
    expect(failedSession.endCallCount).toBe(1);
    expect(controller.resourceCounts()).toMatchObject({
      activeXRSessions: 0,
      registeredXRSessionHandlers: 0,
      registeredReferenceSpaceHandlers: 0,
      registeredControllerGroupHandlers: 0,
    });

    await controller.dispose();
  });

  it('gates provisional placement on a valid pose and calls renderer.xr.getCamera with no argument', async () => {
    const system = new MockXRSystem();
    const session = new MockXRSession();
    system.enqueue(session);
    const controller = controllerFor(system);
    const surface = document.createElement('div');
    const object = new (await import('three')).Object3D();
    controller.setInteractionSurface({ object, widthPx: 1024, heightPx: 768 });
    await controller.start().result;
    const state = sceneStates[0]!;

    state.runFrame();
    state.runFrame(new MockXRFrame(null));
    expect(state.renderer.renderCalls).toHaveLength(2);
    expect(state.poseCallCount).toBe(0);
    expect(state.renderer.getCameraArguments).toEqual([[], []]);

    state.renderer.viewerCamera = new (await import('three')).ArrayCamera([]);
    state.runFrame(new MockXRFrame());
    expect(state.renderer.renderCalls).toHaveLength(3);
    expect(state.poseCallCount).toBe(0);

    const THREE = await import('three');
    const viewerCamera = new THREE.ArrayCamera([new THREE.PerspectiveCamera()]);
    viewerCamera.position.set(0, 1.6, 0);
    viewerCamera.updateMatrixWorld(true);
    state.renderer.viewerCameraAfterRender = viewerCamera;
    state.runFrame(new MockXRFrame());
    state.runFrame(new MockXRFrame());

    expect(state.renderer.renderCalls).toHaveLength(5);
    expect(state.renderer.renderCalls.every((call) => call.camera === controller.getAppCamera())).toBe(true);
    expect(state.renderer.getCameraArguments.every((args) => args.length === 0)).toBe(true);
    expect(state.poseCallCount).toBe(1);
    surface.remove();
    await controller.dispose();
  });

  it('emits visibility/reset/end with the captured generation and re-enters without growth', async () => {
    const system = new MockXRSystem();
    const firstSession = new MockXRSession();
    system.enqueue(firstSession);
    const controller = controllerFor(system);
    const events: unknown[] = [];
    controller.subscribe((event) => events.push(event));
    const firstHandle = await controller.start().result;

    firstSession.emitVisibility('visible-blurred');
    firstSession.emitVisibility('hidden');
    firstSession.emitVisibility('visible');
    firstSession.localFloorSpace.emitReset();
    const firstEnd = firstHandle.end();
    const duplicateEnd = firstHandle.end();
    expect(duplicateEnd).toBe(firstEnd);
    await firstEnd;
    expect(firstSession.endCallCount).toBe(1);
    expect(events).toEqual([
      { sessionGeneration: 1, type: 'visibilityChanged', visibilityState: 'visible-blurred' },
      { sessionGeneration: 1, type: 'visibilityChanged', visibilityState: 'hidden' },
      { sessionGeneration: 1, type: 'visibilityChanged', visibilityState: 'visible' },
      { sessionGeneration: 1, type: 'referenceReset' },
      { sessionGeneration: 1, type: 'ended' },
    ]);
    expect(controller.resourceCounts()).toMatchObject({
      renderers: 1,
      controllerGroups: 2,
      controllerRayVisuals: 2,
      activeXRSessions: 0,
      registeredXRSessionHandlers: 0,
      registeredReferenceSpaceHandlers: 0,
      registeredControllerGroupHandlers: 0,
      controllerBindings: 0,
    });

    const secondSession = new MockXRSession();
    system.enqueue(secondSession);
    const secondHandle = await controller.start().result;
    expect(secondHandle.generation).toBeGreaterThan(firstHandle.generation);
    expect(sceneStates).toHaveLength(1);
    expect(sceneStates[0]!.renderer.animationLoopCalls.filter(Boolean)).toHaveLength(1);
    expect(controller.resourceCounts()).toMatchObject({
      renderers: 1,
      controllerGroups: 2,
      controllerRayVisuals: 2,
      activeXRSessions: 1,
      registeredXRSessionHandlers: 4,
      registeredReferenceSpaceHandlers: 1,
      registeredControllerGroupHandlers: 4,
    });

    await controller.dispose();
    expect(controller.resourceCounts()).toEqual({
      renderers: 0,
      rendererCanvases: 0,
      scenes: 0,
      appCameras: 0,
      controllerGroups: 0,
      controllerRayVisuals: 0,
      activeXRSessions: 0,
      registeredXRSessionHandlers: 0,
      registeredReferenceSpaceHandlers: 0,
      registeredControllerGroupHandlers: 0,
      controllerBindings: 0,
    });
    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(secondSession.endCallCount).toBe(1);
  });

  it('maps browser request and renderer failures to stable AppError codes', async () => {
    const unsupportedSystem = new MockXRSystem();
    unsupportedSystem.enqueue(Promise.reject(new DOMException('no AR', 'NotSupportedError')));
    const unsupported = controllerFor(unsupportedSystem);
    await expect(unsupported.start().result).rejects.toMatchObject({
      name: 'AppError',
      code: 'IMMERSIVE_AR_UNSUPPORTED',
    });
    await unsupported.dispose();

    const rendererSystem = new MockXRSystem();
    const session = new MockXRSession();
    rendererSystem.enqueue(session);
    const rendererFailure = controllerFor(rendererSystem);
    sceneStates.at(-1)!.renderer.setSessionError = new Error('injection failed');
    await expect(rendererFailure.start().result).rejects.toMatchObject({
      name: 'AppError',
      code: 'XR_RENDERER_INIT_FAILED',
    });
    expect(session.endCallCount).toBe(1);
    await rendererFailure.dispose();
  });

  it('ends a late-created session during disposal and ignores its stale result/events', async () => {
    let resolveSession!: (session: XRSession) => void;
    const lateSessionPromise = new Promise<XRSession>((resolve) => {
      resolveSession = resolve;
    });
    const system = new MockXRSystem();
    const session = new MockXRSession();
    system.enqueue(lateSessionPromise);
    const controller = controllerFor(system);
    const events: unknown[] = [];
    controller.subscribe((event) => events.push(event));

    const operation = controller.start();
    const disposing = controller.dispose();
    expect(controller.dispose()).toBe(disposing);
    resolveSession(session as unknown as XRSession);

    await expect(operation.result).rejects.toMatchObject({ name: 'AppError', code: 'APP_DISPOSED' });
    await disposing;
    expect(session.endCallCount).toBe(1);
    expect(events).toEqual([]);
    expect(controller.resourceCounts()).toMatchObject({
      renderers: 0,
      activeXRSessions: 0,
      registeredXRSessionHandlers: 0,
      registeredReferenceSpaceHandlers: 0,
      registeredControllerGroupHandlers: 0,
    });
  });
});
