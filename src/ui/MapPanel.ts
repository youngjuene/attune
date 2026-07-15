import * as THREE from 'three';

import { AppError } from '../app/errors';
import type {
  CreateMapPanel,
  MapMarkerModel,
  MapPanel,
  MapPanelAction,
  MapPanelModel,
  PlaybackSnapshot,
  PointerTargetKind,
} from '../domain/types';
import { COLORS } from './colors';
import { MapHitTester, controlActionAt } from './hitTest';
import {
  FOOTER_RECT,
  MAP_CANVAS_HEIGHT,
  MAP_CANVAS_SCALE,
  MAP_CANVAS_WIDTH,
  MAP_CENTER,
  MAP_CONTROLS,
  MAP_DRAWABLE_RADIUS_PX,
  MAP_RECT,
  MAP_WORLD_HEIGHT_M,
  MAP_WORLD_WIDTH_M,
  MARKER_VISUAL_RADIUS_PX,
  PROGRESS_RECT,
  SELECTED_DETAIL_RECT,
} from './mapLayout';

const PANEL_DISTANCE_M = 1.25;
const PANEL_VERTICAL_OFFSET_M = -0.08;
const MINIMUM_HORIZONTAL_FORWARD = 0.25;
const LOCAL_POSITIVE_Z = new THREE.Vector3(0, 0, 1);

// Passthrough type scale: no run below 18px logical (0.77deg em at 1.25m). Primary
// title/status 24-26px, control labels/body 20px, secondary/floor 18px.
const FONT_PROMPT = '700 26px system-ui, sans-serif';
const FONT_TITLE = '700 24px system-ui, sans-serif';
const FONT_BODY = '600 20px system-ui, sans-serif';
const FONT_LABEL = '600 20px system-ui, sans-serif';
const FONT_SECONDARY = '500 18px system-ui, sans-serif';
const FONT_COMPASS = '700 20px system-ui, sans-serif';

const HALO_STROKE_EXTRA_PX = 4;
const HALO_MARKER_EXTRA_PX = 3;
const HALO_TEXT_WIDTH_PX = 4;

function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--';
  }
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function fitText(context: CanvasRenderingContext2D, value: string, maximumWidth: number): string {
  if (context.measureText(value).width <= maximumWidth) {
    return value;
  }
  const suffix = '…';
  let result = value;
  while (result.length > 0 && context.measureText(`${result}${suffix}`).width > maximumWidth) {
    result = result.slice(0, -1);
  }
  return `${result}${suffix}`;
}

function markerLayer(marker: MapMarkerModel, hoveredRecordingId: string | null): number {
  if (
    marker.state === 'selected' ||
    marker.state === 'loading' ||
    marker.state === 'playing' ||
    marker.state === 'failed'
  ) {
    return 2;
  }
  if (marker.recordingId === hoveredRecordingId || marker.state === 'hovered') {
    return 1;
  }
  return 0;
}

function markerLabel(model: MapPanelModel, marker: MapMarkerModel): string {
  return model.selected?.recordingId === marker.recordingId
    ? model.selected.title
    : marker.recordingId;
}

function playbackControlLabel(playback: PlaybackSnapshot): string {
  return playback.state === 'playing' || playback.state === 'loading' ? 'Pause' : 'Play';
}

class CanvasMapPanel implements MapPanel {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly hitTester = new MapHitTester();
  private readonly lastValidPanelForward = new THREE.Vector3(0, 0, -1);
  private model: MapPanelModel | null = null;
  private hoveredRecordingId: string | null = null;
  private internalOverlapCycle: { index: number; count: number } | null = null;
  private disposed = false;

  public constructor(private readonly scene: THREE.Scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = MAP_CANVAS_WIDTH * MAP_CANVAS_SCALE;
    this.canvas.height = MAP_CANVAS_HEIGHT * MAP_CANVAS_SCALE;
    this.canvas.dataset.attuneOwned = 'map-canvas';
    const context = this.canvas.getContext('2d');
    if (context === null) {
      throw new AppError('XR_RENDERER_INIT_FAILED');
    }
    // Every draw() call works in logical 1024x768 coordinates; this transform maps them
    // onto the larger backing bitmap. setTransform (not scale) is absolute, so it does not
    // compound across the many redraws.
    context.setTransform(MAP_CANVAS_SCALE, 0, 0, MAP_CANVAS_SCALE, 0, 0);
    this.context = context;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.geometry = new THREE.PlaneGeometry(MAP_WORLD_WIDTH_M, MAP_WORLD_HEIGHT_M);
    this.plane = new THREE.Mesh(this.geometry, this.material);
    this.plane.name = 'attune-map-panel';
    this.plane.frustumCulled = false;
    this.plane.renderOrder = 10;
    this.scene.add(this.plane);
    this.draw();
  }

  public setModel(model: MapPanelModel): void {
    this.assertLive();
    if (model === this.model) {
      return;
    }
    const geometryChanged = this.hitTester.setMarkers(model.markers);
    this.model = model;
    if (geometryChanged) {
      this.internalOverlapCycle = null;
      this.hoveredRecordingId = null;
    }
    this.draw();
  }

  public getCanvas(): HTMLCanvasElement {
    this.assertLive();
    return this.canvas;
  }

  public setPoseFromCamera(camera: THREE.Camera): void {
    this.assertLive();
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const rawHorizontal = camera.getWorldDirection(new THREE.Vector3());
    rawHorizontal.y = 0;
    if (rawHorizontal.length() >= MINIMUM_HORIZONTAL_FORWARD) {
      this.lastValidPanelForward.copy(rawHorizontal).normalize();
    }

    this.plane.position.copy(cameraPosition).addScaledVector(this.lastValidPanelForward, PANEL_DISTANCE_M);
    this.plane.position.y = cameraPosition.y + PANEL_VERTICAL_OFFSET_M;
    const toCameraHorizontal = cameraPosition.clone().sub(this.plane.position);
    toCameraHorizontal.y = 0;
    if (toCameraHorizontal.lengthSq() > 0) {
      toCameraHorizontal.normalize();
      this.plane.quaternion.setFromUnitVectors(LOCAL_POSITIVE_Z, toCameraHorizontal);
    }
  }

  public updateHover(canvasX: number, canvasY: number, _nowMs: number): void {
    this.assertLive();
    const nextHover = this.hitTester.hover(canvasX, canvasY)?.recordingId ?? null;
    if (nextHover === this.hoveredRecordingId) {
      return;
    }
    this.hoveredRecordingId = nextHover;
    this.draw();
  }

  public clearHover(): void {
    this.assertLive();
    if (this.hoveredRecordingId === null) {
      return;
    }
    this.hoveredRecordingId = null;
    this.draw();
  }

  public hitTest(canvasX: number, canvasY: number, nowMs: number): MapPanelAction | null {
    this.assertLive();
    const model = this.model;
    if (model === null) {
      return null;
    }
    const hit = this.hitTester.select(model, canvasX, canvasY, nowMs);
    const previousCycle = this.internalOverlapCycle;
    this.internalOverlapCycle = hit?.kind === 'marker' && hit.overlapCount > 1
      ? { index: hit.overlapIndex, count: hit.overlapCount }
      : null;
    if (
      previousCycle?.index !== this.internalOverlapCycle?.index
      || previousCycle?.count !== this.internalOverlapCycle?.count
    ) {
      this.draw();
    }
    return hit?.action ?? null;
  }

  public classifyTarget(canvasX: number, canvasY: number): PointerTargetKind {
    this.assertLive();
    const model = this.model;
    if (model === null) {
      return 'none';
    }
    if (controlActionAt(model, canvasX, canvasY) !== null) {
      return 'control';
    }
    const marker = this.hitTester.hover(canvasX, canvasY);
    if (marker !== null) {
      return marker.enabled ? 'marker' : 'disabled';
    }
    return 'panel';
  }

  public getObject3D(): THREE.Object3D {
    this.assertLive();
    return this.plane;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.scene.remove(this.plane);
    this.texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
    this.hitTester.resetCycle();
    this.model = null;
    this.hoveredRecordingId = null;
    this.internalOverlapCycle = null;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new AppError('APP_DISPOSED');
    }
  }

  private draw(): void {
    const context = this.context;
    const model = this.model;
    context.clearRect(0, 0, MAP_CANVAS_WIDTH, MAP_CANVAS_HEIGHT);
    // No full-bleed plate: the map region is pure passthrough, and ink is made legible by
    // per-element halos and content-sized scrims rather than a backing panel.
    this.haloText(model?.collectionTitle ?? 'attune', 28, 54, FONT_TITLE, COLORS.accent);
    this.drawRadialMap();
    this.drawDetails();
    this.drawControls();
    this.drawFooter();
    if (model?.calibrationReady === false && model?.xrControlsVisible !== false) {
      this.drawCalibrationPrompt();
    }
    this.texture.needsUpdate = true;
  }

  /** Stroke the current path twice: a wide dark halo, then the coloured ink on top. */
  private strokeHalo(definePath: () => void, color: string, width: number): void {
    const context = this.context;
    definePath();
    context.lineWidth = width + HALO_STROKE_EXTRA_PX;
    context.strokeStyle = COLORS.halo;
    context.stroke();
    context.lineWidth = width;
    context.strokeStyle = color;
    context.stroke();
  }

  /** Draw text with a dark outline halo so it reads over any passthrough background. */
  private haloText(
    text: string,
    x: number,
    y: number,
    font: string,
    color: string,
    align: CanvasTextAlign = 'left',
  ): void {
    const context = this.context;
    context.font = font;
    context.textAlign = align;
    context.lineJoin = 'round';
    context.lineWidth = HALO_TEXT_WIDTH_PX;
    context.strokeStyle = COLORS.halo;
    context.strokeText(text, x, y);
    context.fillStyle = color;
    context.fillText(text, x, y);
  }

  private drawRadialMap(): void {
    const context = this.context;
    const model = this.model;

    const rings = model?.distanceRings ?? [];
    for (const ring of rings) {
      const radius = MAP_DRAWABLE_RADIUS_PX * ring.normalizedRadius;
      this.strokeHalo(() => {
        context.beginPath();
        context.arc(MAP_CENTER.x, MAP_CENTER.y, radius, 0, Math.PI * 2);
      }, COLORS.line, 2);
      this.haloText(ring.distanceText, MAP_CENTER.x + radius + 8, MAP_CENTER.y - 8, FONT_SECONDARY, COLORS.muted);
    }

    this.haloText('N', MAP_CENTER.x, MAP_CENTER.y - MAP_DRAWABLE_RADIUS_PX - 16, FONT_COMPASS, COLORS.text, 'center');
    this.haloText('E', MAP_CENTER.x + MAP_DRAWABLE_RADIUS_PX + 20, MAP_CENTER.y + 7, FONT_COMPASS, COLORS.text, 'center');
    this.haloText('S', MAP_CENTER.x, MAP_CENTER.y + MAP_DRAWABLE_RADIUS_PX + 30, FONT_COMPASS, COLORS.text, 'center');
    this.haloText('W', MAP_CENTER.x - MAP_DRAWABLE_RADIUS_PX - 20, MAP_CENTER.y + 7, FONT_COMPASS, COLORS.text, 'center');

    this.strokeHalo(() => {
      context.beginPath();
      context.arc(MAP_CENTER.x, MAP_CENTER.y, 9, 0, Math.PI * 2);
    }, COLORS.accent, 3);
    this.strokeHalo(() => {
      context.beginPath();
      context.moveTo(MAP_CENTER.x - 14, MAP_CENTER.y);
      context.lineTo(MAP_CENTER.x + 14, MAP_CENTER.y);
      context.moveTo(MAP_CENTER.x, MAP_CENTER.y - 14);
      context.lineTo(MAP_CENTER.x, MAP_CENTER.y + 14);
    }, COLORS.accent, 3);

    if (model === null) {
      return;
    }
    const ordered = model.markers
      .map((marker, index) => ({ marker, index, layer: markerLayer(marker, this.hoveredRecordingId) }))
      .sort((left, right) => left.layer - right.layer || left.index - right.index);
    for (const { marker } of ordered) {
      this.drawMarker(model, marker);
    }
  }

  private drawMarker(model: MapPanelModel, marker: MapMarkerModel): void {
    if (!Number.isFinite(marker.xPx) || !Number.isFinite(marker.yPx)) {
      return;
    }
    const context = this.context;
    const hovered = marker.recordingId === this.hoveredRecordingId || marker.state === 'hovered';
    const selected =
      marker.state === 'selected' ||
      marker.state === 'loading' ||
      marker.state === 'playing' ||
      marker.state === 'failed';
    const outlineRadius = hovered || selected ? 11 : MARKER_VISUAL_RADIUS_PX;

    context.save();
    // Dark halo disc behind every marker so its outline reads over live passthrough.
    context.beginPath();
    context.arc(marker.xPx, marker.yPx, outlineRadius + HALO_MARKER_EXTRA_PX, 0, Math.PI * 2);
    context.fillStyle = COLORS.halo;
    context.fill();
    context.lineWidth = selected ? 4 : hovered ? 3 : 2;
    context.strokeStyle = marker.state === 'failed'
      ? COLORS.error
      : selected
        ? COLORS.selected
        : hovered
          ? COLORS.accent
          : COLORS.line;
    context.fillStyle = !marker.enabled
      ? COLORS.disabled
      : marker.state === 'failed'
        ? COLORS.error
        : marker.state === 'loading'
          ? COLORS.warning
          : marker.state === 'playing'
            ? COLORS.accent
            : selected
              ? COLORS.selected
              : COLORS.accent;
    if (!marker.enabled || marker.state === 'disabled') {
      context.beginPath();
      context.moveTo(marker.xPx - outlineRadius, marker.yPx - outlineRadius);
      context.lineTo(marker.xPx + outlineRadius, marker.yPx + outlineRadius);
      context.moveTo(marker.xPx + outlineRadius, marker.yPx - outlineRadius);
      context.lineTo(marker.xPx - outlineRadius, marker.yPx + outlineRadius);
      context.stroke();
    } else if (marker.state === 'failed') {
      context.beginPath();
      context.arc(marker.xPx, marker.yPx, outlineRadius, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(marker.xPx - 6, marker.yPx - 6);
      context.lineTo(marker.xPx + 6, marker.yPx + 6);
      context.moveTo(marker.xPx + 6, marker.yPx - 6);
      context.lineTo(marker.xPx - 6, marker.yPx + 6);
      context.stroke();
    } else if (marker.state === 'playing') {
      context.beginPath();
      context.moveTo(marker.xPx - 7, marker.yPx - 10);
      context.lineTo(marker.xPx + 10, marker.yPx);
      context.lineTo(marker.xPx - 7, marker.yPx + 10);
      context.lineTo(marker.xPx - 7, marker.yPx - 10);
      context.fill();
      context.stroke();
    } else if (marker.state === 'loading') {
      context.beginPath();
      context.arc(marker.xPx, marker.yPx, outlineRadius, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.arc(marker.xPx, marker.yPx, 3, 0, Math.PI * 2);
      context.fill();
    } else if (selected) {
      context.beginPath();
      context.moveTo(marker.xPx, marker.yPx - outlineRadius);
      context.lineTo(marker.xPx + outlineRadius, marker.yPx);
      context.lineTo(marker.xPx, marker.yPx + outlineRadius);
      context.lineTo(marker.xPx - outlineRadius, marker.yPx);
      context.lineTo(marker.xPx, marker.yPx - outlineRadius);
      context.fill();
      context.stroke();
    } else {
      context.beginPath();
      context.arc(marker.xPx, marker.yPx, MARKER_VISUAL_RADIUS_PX, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    if (hovered || selected) {
      const disabledSuffix = !marker.enabled ? ' — Unsupported audio type' : '';
      context.font = FONT_SECONDARY;
      const label = fitText(context, `${markerLabel(model, marker)}${disabledSuffix}`, 260);
      context.fillStyle = COLORS.scrim;
      context.fillRect(marker.xPx + 14, marker.yPx - 31, context.measureText(label).width + 16, 30);
      this.haloText(label, marker.xPx + 22, marker.yPx - 10, FONT_SECONDARY, marker.enabled ? COLORS.text : COLORS.muted);
    }
    context.restore();
  }

  private drawDetails(): void {
    const context = this.context;
    const model = this.model;
    const selected = model?.selected;
    context.font = FONT_TITLE;
    this.haloText(
      fitText(context, selected?.title ?? 'Select a recording', SELECTED_DETAIL_RECT.width),
      SELECTED_DETAIL_RECT.x,
      140,
      FONT_TITLE,
      COLORS.text,
    );
    if (selected !== undefined) {
      // Distance and bearing first (the useful values in a headset); coordinates are
      // secondary and rendered at reduced precision by AppController.
      const detailLines = [
        selected.distanceText,
        selected.bearingText,
        `${selected.latitudeText}, ${selected.longitudeText}`,
        selected.description ?? '',
        selected.credit === undefined ? '' : `Credit: ${selected.credit}`,
      ].filter((line) => line.length > 0);
      context.font = FONT_BODY;
      detailLines.forEach((line, index) => {
        this.haloText(
          fitText(context, line, SELECTED_DETAIL_RECT.width),
          SELECTED_DETAIL_RECT.x,
          182 + index * 34,
          FONT_BODY,
          COLORS.muted,
        );
      });
    }

    const playback = model?.playback ?? { state: 'empty', currentTimeSec: 0 };
    const duration = playback.durationSec;
    const progress = duration !== undefined && Number.isFinite(duration) && duration > 0
      ? Math.min(1, Math.max(0, playback.currentTimeSec / duration))
      : 0;
    context.fillStyle = COLORS.halo;
    context.fillRect(PROGRESS_RECT.x - 2, PROGRESS_RECT.y + 16, PROGRESS_RECT.width + 4, 12);
    context.fillStyle = COLORS.line;
    context.fillRect(PROGRESS_RECT.x, PROGRESS_RECT.y + 18, PROGRESS_RECT.width, 8);
    context.fillStyle = COLORS.accent;
    context.fillRect(PROGRESS_RECT.x, PROGRESS_RECT.y + 18, PROGRESS_RECT.width * progress, 8);
    this.haloText(
      `${playback.state}  ${formatTime(playback.currentTimeSec)} / ${formatTime(duration)}`,
      PROGRESS_RECT.x,
      PROGRESS_RECT.y + 10,
      FONT_SECONDARY,
      COLORS.text,
    );
  }

  private drawControls(): void {
    const context = this.context;
    const model = this.model;
    const calibrationPending = model?.calibrationReady === false;
    for (const control of MAP_CONTROLS) {
      const xrOnly = control.id === 'exit-xr' || control.id === 'recenter' || control.id === 'recalibrate';
      if (model?.xrControlsVisible === false && xrOnly) {
        continue;
      }
      // During calibration only Exit MR is actionable; drawing the rest as dead buttons
      // misleads the user, so omit them entirely (hit testing already blocks them).
      if (calibrationPending && control.id !== 'exit-xr') {
        continue;
      }
      context.fillStyle = COLORS.panel;
      context.strokeStyle = COLORS.line;
      context.lineWidth = 2;
      context.fillRect(control.rect.x, control.rect.y, control.rect.width, control.rect.height);
      context.strokeRect(control.rect.x, control.rect.y, control.rect.width, control.rect.height);
      const label = control.id === 'play-pause' && model !== null
        ? playbackControlLabel(model.playback)
        : control.label;
      context.font = FONT_LABEL;
      this.haloText(
        fitText(context, label, control.rect.width - 20),
        control.rect.x + 12,
        control.rect.y + 36,
        FONT_LABEL,
        COLORS.text,
      );
    }
    if (!calibrationPending) {
      this.haloText(
        `Volume ${Math.round((model?.masterGain ?? 0.7) * 10) / 10}`,
        868,
        646,
        FONT_SECONDARY,
        COLORS.muted,
      );
    }
  }

  private drawFooter(): void {
    const context = this.context;
    const model = this.model;
    const overlap = model?.overlapCycle ?? this.internalOverlapCycle ?? undefined;
    // The calibration instruction is no longer here — it is the dominant centred prompt.
    let status = model?.xrControlsVisible === false
      ? ''
      : model?.controllerAvailable === false
        ? 'No tracked controller. Use the Quest system control to exit Mixed Reality.'
        : '';
    if (overlap !== undefined && overlap.count > 1) {
      status = `item ${overlap.index + 1} of ${overlap.count}`;
    }
    if (this.hoveredRecordingId !== null) {
      const hovered = model?.markers.find((marker) => marker.recordingId === this.hoveredRecordingId);
      if (hovered?.enabled === false) {
        status = 'Unsupported audio type';
      }
    }
    let color: string = COLORS.muted;
    if (model?.warningText !== undefined) {
      status = model.warningText;
      color = COLORS.warning;
    } else if (model?.errorCode !== undefined) {
      status = model.errorCode;
      color = COLORS.error;
    }
    if (status === '') {
      return;
    }
    context.font = FONT_SECONDARY;
    this.haloText(fitText(context, status, FOOTER_RECT.width - 40), 20, 760, FONT_SECONDARY, color);
  }

  /** During calibration, the one required instruction is the visually dominant element. */
  private drawCalibrationPrompt(): void {
    const context = this.context;
    const text = 'Face north, then pull the trigger.';
    context.font = FONT_PROMPT;
    const fitted = fitText(context, text, MAP_RECT.width - 48);
    const width = context.measureText(fitted).width;
    const centerX = MAP_CENTER.x;
    const baseline = MAP_CENTER.y + 9;
    context.fillStyle = COLORS.scrim;
    context.fillRect(centerX - width / 2 - 18, baseline - 34, width + 36, 52);
    this.haloText(fitted, centerX, baseline, FONT_PROMPT, COLORS.text, 'center');
  }
}

export const createMapPanel: CreateMapPanel = (scene) => new CanvasMapPanel(scene);
