import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { officeWorkSurface } from './officeWorkSurface';
import { createOfficeScreenTexture } from './officeScreenTexture';
import { createOfficeMotionPlayer } from './officeMotionPlayer';
import type { OfficeAgent } from '../../lib/agentOffice';
import {
  OfficeResources, batchOfficeArchitecture, createOfficeAvatar, createOfficeWorld, officeWorkstationLayoutKey,
  type OfficeAvatar, type OfficeWorld,
} from './officeGeometry';
import { createSceneScheduler } from './sceneScheduler';
import { layoutOfficeLabels, type OfficeLabelAnchor, type OfficeLabelPlacement, type OfficeProtectedArea } from './labelLayout';

export interface OfficeSceneInput {
  agents: OfficeAgent[];
  selectedId: string | null;
  paused: boolean;
  stale?: boolean;
  observedAt?: string | null;
  demoSeek?: { seconds: number; revision: number };
}

interface RuntimeOptions extends OfficeSceneInput {
  host: HTMLDivElement;
  labels: Map<string, HTMLButtonElement>;
  stems?: Map<string, SVGLineElement>;
  sign: HTMLSpanElement;
  onSelect: (id: string) => void;
  onUnavailable: (message: string) => void;
}

/** React owns accessible labels; this runtime owns the camera, geometry and GPU. */
export function createOfficeSceneRuntime(options: RuntimeOptions, createRenderer = () => new THREE.WebGLRenderer({
  antialias: true, alpha: false, powerPreference: 'low-power',
})) {
  const { host, labels, sign } = options;
  const renderer = createRenderer();
  const cleanups: (() => void)[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.reverse()) {
      // Continue releasing the rest even if a lost GPU context rejects one step.
      try { cleanup(); } catch { /* Best effort during teardown. */ }
    }
    cleanups.length = 0;
  };
  cleanups.push(() => renderer.forceContextLoss(), () => renderer.dispose());
  try {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0xf4f1ea);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-label', '可旋转和缩放的三维 Agent 办公室');
  canvas.setAttribute('role', 'img');
  host.prepend(canvas);
  cleanups.push(() => canvas.remove());

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 8, -8, 0.1, 120);
  camera.position.set(13, 13, 17);
  const controls = new OrbitControls(camera, canvas);
  cleanups.push(() => controls.dispose());
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.minPolarAngle = Math.PI / 8;
  controls.maxPolarAngle = Math.PI / 2.25;
  controls.minAzimuthAngle = -Math.PI / 12;
  controls.maxAzimuthAngle = Math.PI / 1.85;
  controls.minZoom = 0.65;
  controls.maxZoom = 4.5;
  controls.target.set(0, 0.65, 0);
  controls.update();

  scene.add(new THREE.HemisphereLight(0xffffff, 0xb6a48b, 1.85));
  const sun = new THREE.DirectionalLight(0xfff0e1, 3.2);
  sun.position.set(4, 13, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.normalBias = 0.045;
  sun.shadow.bias = -0.0002;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 50;
  scene.add(sun, sun.target);
  cleanups.push(() => sun.shadow.dispose());
  const fill = new THREE.DirectionalLight(0xe5efed, 1.1);
  fill.position.set(-7, 6, -4);
  scene.add(fill);

  let input: OfficeSceneInput = options;
  let resources = new OfficeResources();
  cleanups.push(() => resources.dispose());
  let avatarResources = new OfficeResources();
  cleanups.push(() => avatarResources.dispose());
  let world: OfficeWorld = createOfficeWorld(resources, input.agents.length, input.agents);
  const screenTextures = new Map<number, ReturnType<typeof createOfficeScreenTexture>>();
  const clearScreenTextures = () => { for (const screen of screenTextures.values()) screen?.dispose(); screenTextures.clear(); };
  cleanups.push(clearScreenTextures);
  batchOfficeArchitecture(resources, world);
  scene.add(world.root);
  let layoutKey = officeWorkstationLayoutKey(input.agents);
  let avatarIds = '';
  let avatars = new Map<string, OfficeAvatar>();
  const motionPlayers = new Map<string, ReturnType<typeof createOfficeMotionPlayer>>();
  const workSurfaces = new Map<string, ReturnType<typeof officeWorkSurface>>();
  let width = 1, height = 1;
  let focused = document.hasFocus();
  let intersecting = true;
  let contextLost = false;
  let animationTime = Number.isFinite(input.demoSeek?.seconds) ? Math.max(0, input.demoSeek!.seconds) : 0;
  let lastFrame: number | undefined;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const visible = () => !document.hidden && intersecting && !contextLost;
  const motionAllowed = () => visible() && focused && !input.paused && !input.stale && !reducedMotion?.matches;
  const animate = () => motionAllowed() && (Array.from(motionPlayers.values()).some(player => player.pending)
    || input.agents.some((agent) => ['working', 'thinking'].includes(agent.state)
      && workSurfaces.get(agent.id)?.kind !== 'unreported'));
  const projected = new THREE.Vector3();
  const labelSizes = new Map<string, { width: number; height: number }>();
  let labelLayoutKey = '';
  let labelPlacements: OfficeLabelPlacement[] = [];
  let focusedAgentId: string | null = null;

  function measureLabels() {
    labelSizes.clear();
    for (const [id, element] of labels) labelSizes.set(id, {
      width: element.offsetWidth || 126, height: element.offsetHeight || 42,
    });
    labelLayoutKey = '';
  }

  function positionAgentLabels() {
    const anchors: OfficeLabelAnchor[] = [];
    const protectedAreas: OfficeProtectedArea[] = [];
    const protect = (xs: number[], ys: number[], zs: number[], space?: THREE.Object3D) => {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const x of xs) for (const y of ys) for (const z of zs) {
        projected.set(x, y, z);
        if (space) projected.applyMatrix4(space.matrixWorld);
        projected.project(camera);
        if (projected.z <= -1 || projected.z >= 1) continue;
        const px = (projected.x * 0.5 + 0.5) * width, py = (-projected.y * 0.5 + 0.5) * height;
        left = Math.min(left, px); right = Math.max(right, px); top = Math.min(top, py); bottom = Math.max(bottom, py);
      }
      if (Number.isFinite(left)) protectedAreas.push({ left, top, width: right - left, height: bottom - top });
    };
    for (const [index, agent] of input.agents.entries()) {
      const avatar = avatars.get(agent.id), desk = world.desks[index];
      if (!avatar || !desk) continue;
      // Reserve the employee, hands and working props, plus the monitor face.
      // Work in avatar-local space so station rotation also rotates the protected region.
      protect([-.46, .46], [.13, 1.51], [-.62, .3], avatar.root);
      // The mouse and articulated forearms extend sideways at desk height only.
      // Keep that workspace clear without hiding labels across the whole body.
      protect([-.46, .86], [.33, .57], [-.7, -.2], avatar.root);
    }
    // Empty stations are still visible; their monitors must remain unobstructed too.
    for (const desk of world.desks) {
      const screen = desk.root.getObjectByName('office-work-screen');
      if (!(screen instanceof THREE.Mesh)) continue;
      if (!screen.geometry.boundingBox) screen.geometry.computeBoundingBox();
      const bounds = screen.geometry.boundingBox;
      if (bounds) protect([bounds.min.x - .02, bounds.max.x + .02], [bounds.min.y - .02, bounds.max.y + .02], [-.035, .035], screen);
    }
    for (const [id, avatar] of avatars) {
      if (!labels.has(id) || focusedAgentId && id !== focusedAgentId) continue;
      projected.copy(avatar.label).project(camera);
      if (projected.z <= -1 || projected.z >= 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
      anchors.push({ id, x: (projected.x * 0.5 + 0.5) * width, y: (-projected.y * 0.5 + 0.5) * height,
        ...(labelSizes.get(id) || { width: 126, height: 42 }), selected: id === input.selectedId });
    }
    const key = JSON.stringify([width, height, anchors, protectedAreas]);
    if (key !== labelLayoutKey) { labelPlacements = layoutOfficeLabels(anchors, width, height, protectedAreas); labelLayoutKey = key; }
    const shown = new Set(labelPlacements.map(item => item.id));
    for (const [id, element] of labels) {
      element.style.visibility = shown.has(id) ? 'visible' : 'hidden';
      const stem = options.stems?.get(id);
      if (stem) stem.style.visibility = shown.has(id) ? 'visible' : 'hidden';
    }
    for (const item of labelPlacements) {
      const element = labels.get(item.id)!;
      element.style.transform = `translate(${item.left}px, ${item.top}px)`;
      element.style.zIndex = item.selected ? '3' : '2';
      const stem = options.stems?.get(item.id);
      if (stem) {
        stem.setAttribute('x1', String(item.left + item.width / 2));
        stem.setAttribute('y1', String(item.top + item.height));
        stem.setAttribute('x2', String(item.x));
        stem.setAttribute('y2', String(item.y));
      }
    }
  }

  function projectLabel(element: HTMLElement, position: THREE.Vector3) {
    projected.copy(position).project(camera);
    const shown = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.12 && Math.abs(projected.y) < 1.12;
    element.style.visibility = shown ? 'visible' : 'hidden';
    element.style.transform = `translate(-50%, -100%) translate(${(projected.x * 0.5 + 0.5) * width}px, ${(-projected.y * 0.5 + 0.5) * height}px)`;
    element.style.zIndex = String(Math.round((1 - projected.z) * 1000));
  }

  const scheduler = createSceneScheduler({
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (id) => window.cancelAnimationFrame(id),
    visible,
    animate,
    draw: (time) => {
      const delta = motionAllowed() && lastFrame !== undefined ? Math.max(0, Math.min((time - lastFrame) / 1000, 0.06)) : 0;
      if (animate()) animationTime += delta;
      lastFrame = time;
      for (const agent of input.agents) {
        motionPlayers.get(agent.id)?.draw(agent.state, workSurfaces.get(agent.id)?.kind || 'unreported',
          animationTime, agent.id === input.selectedId, delta, motionAllowed());
      }
      camera.updateMatrixWorld();
      try { renderer.render(scene, camera); }
      catch {
        contextLost = true;
        options.onUnavailable('三维画面暂时无法继续绘制。Agent 状态仍可在列表中查看，请重试加载场景。');
        return;
      }
      positionAgentLabels();
      projectLabel(sign, world.sign);
    },
  });
  cleanups.push(() => scheduler.dispose());

  function refresh() {
    lastFrame = undefined;
    scheduler.refresh();
  }

  function fitCamera(reset: boolean) {
    const aspect = width / height;
    const radius = Math.hypot(world.width, world.depth) / 2;
    const halfHeight = Math.max(radius * 0.74, radius / Math.max(aspect, 0.1) * 1.07);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    if (reset) {
      camera.zoom = 1;
      // A higher three-quarter view exposes hands and desk surfaces instead of
      // stacking monitor backs over the characters' faces in the default view.
      camera.position.set(radius * 1.15, radius * 1.5, radius * 1.45);
      controls.target.set(0, 0.65, 0);
      controls.update();
    }
    camera.updateProjectionMatrix();
    const shadowSize = Math.max(world.width, world.depth) * 0.75;
    Object.assign(sun.shadow.camera, { left: -shadowSize, right: shadowSize, top: shadowSize, bottom: -shadowSize });
    sun.shadow.camera.updateProjectionMatrix();
    refresh();
  }

  function synchronizeAgents() {
    workSurfaces.clear();
    for (const agent of input.agents) workSurfaces.set(agent.id, officeWorkSurface(agent, { stale: input.stale, observedAt: input.observedAt }));
    const nextLayout = officeWorkstationLayoutKey(input.agents);
    if (nextLayout !== layoutKey) {
      clearScreenTextures();
      scene.remove(world.root);
      for (const avatar of avatars.values()) scene.remove(avatar.root);
      avatars.clear();
      motionPlayers.clear();
      resources.dispose();
      resources = new OfficeResources();
      world = createOfficeWorld(resources, input.agents.length, input.agents);
      batchOfficeArchitecture(resources, world);
      scene.add(world.root);
      layoutKey = nextLayout;
      avatarIds = '';
      fitCamera(false);
    }
    const ids = JSON.stringify(input.agents.map((agent) => [agent.id, agent.appearance]));
    if (avatarIds !== ids) {
      for (const avatar of avatars.values()) scene.remove(avatar.root);
      // Agent identities can churn while desk capacity stays unchanged. Release
      // their exclusive GPU assets without touching the world's monitor screens.
      avatarResources.dispose();
      avatarResources = new OfficeResources();
      motionPlayers.clear();
      avatars = new Map(input.agents.map((agent, index) => {
        const avatar = createOfficeAvatar(avatarResources, world.desks[index], agent.id, agent.appearance);
        scene.add(avatar.root);
        motionPlayers.set(agent.id, createOfficeMotionPlayer(avatar));
        return [agent.id, avatar];
      }));
      avatarIds = ids;
      // An unoccupied station must not retain a previous agent's active display.
      for (const desk of world.desks.slice(input.agents.length)) {
        desk.screen.color.setHex(0xaec9c3);
        desk.screen.emissiveIntensity = 0.15;
      }
    }
    for (const [index, desk] of world.desks.entries()) {
      const agent = input.agents[index];
      if (!agent) {
        const old = screenTextures.get(index);
        if (old) { desk.screen.map = null; desk.screen.needsUpdate = true; old.dispose(); }
        screenTextures.delete(index);
        continue;
      }
      if (!screenTextures.has(index)) screenTextures.set(index, createOfficeScreenTexture());
      const surface = screenTextures.get(index);
      if (!surface) continue;
      if (desk.screen.map !== surface.texture) {
        desk.screen.map = surface.texture;
        desk.screen.emissive.setHex(0x000000);
        desk.screen.color.setHex(0xffffff);
        desk.screen.needsUpdate = true;
      }
      surface.update(workSurfaces.get(agent.id) || null);
    }
    refresh();
  }

  function resize() {
    if (disposed) return;
    const bounds = host.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    measureLabels();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(width, height, false);
    fitCamera(false);
  }
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  cleanups.push(() => resizeObserver?.disconnect());
  resizeObserver?.observe(host);
  window.addEventListener('resize', resize);
  cleanups.push(() => window.removeEventListener('resize', resize));
  const intersectionObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    intersecting = entries[0]?.isIntersecting ?? true;
    refresh();
  });
  cleanups.push(() => intersectionObserver?.disconnect());
  intersectionObserver?.observe(host);

  const focus = () => { focused = true; refresh(); };
  const blur = () => { focused = false; refresh(); };
  const visibility = () => { focused = document.hasFocus(); refresh(); };
  window.addEventListener('focus', focus);
  window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', visibility);
  reducedMotion?.addEventListener('change', refresh);
  controls.addEventListener('change', scheduler.invalidate);
  cleanups.push(() => {
    window.removeEventListener('focus', focus);
    window.removeEventListener('blur', blur);
    document.removeEventListener('visibilitychange', visibility);
    reducedMotion?.removeEventListener('change', refresh);
    controls.removeEventListener('change', scheduler.invalidate);
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerDown: { x: number; y: number; id: number } | undefined;
  let moved = false;
  function onPointerDown(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) { pointerDown = undefined; return; }
    pointerDown = { x: event.clientX, y: event.clientY, id: event.pointerId };
    moved = false;
  }
  function onPointerMove(event: PointerEvent) {
    if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) moved = true;
  }
  function onPointerUp(event: PointerEvent) {
    const down = pointerDown;
    pointerDown = undefined;
    if (!down || moved || down.id !== event.pointerId || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const bounds = canvas.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / Math.max(bounds.width, 1) * 2 - 1,
      -(event.clientY - bounds.top) / Math.max(bounds.height, 1) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(Array.from(avatars.values(), (avatar) => avatar.root), true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node && typeof node.userData.agentId !== 'string') node = node.parent;
      if (node) { options.onSelect(node.userData.agentId); return; }
    }
  }
  const cancelPointer = () => { pointerDown = undefined; };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', cancelPointer);
  cleanups.push(() => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', cancelPointer);
  });
  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
    refresh();
    options.onUnavailable('三维画面连接已中断。Agent 状态仍可在列表中查看，请重试加载场景。');
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  cleanups.push(() => canvas.removeEventListener('webglcontextlost', onContextLost));
  cleanups.push(() => { scene.clear(); avatars.clear(); motionPlayers.clear(); });

  synchronizeAgents();
  resize();
  fitCamera(true);
  return {
    update(next: OfficeSceneInput) {
      if (disposed) return;
      if (next.demoSeek && (next.demoSeek.revision !== input.demoSeek?.revision || next.demoSeek.seconds !== input.demoSeek?.seconds)) {
        animationTime = Number.isFinite(next.demoSeek.seconds) ? Math.max(0, next.demoSeek.seconds) : 0;
        for (const player of motionPlayers.values()) player.reset();
      }
      input = next;
      measureLabels();
      synchronizeAgents();
    },
    reset() { if (!disposed) { focusedAgentId = null; fitCamera(true); } },
    focus(id: string) {
      const avatar = avatars.get(id);
      if (disposed || !avatar) return;
      focusedAgentId = id;
      controls.target.copy(avatar.root.position).add(new THREE.Vector3(0, .44, -.17).applyQuaternion(avatar.root.quaternion));
      camera.position.copy(controls.target).add(new THREE.Vector3(-7, 6.4, -8).applyQuaternion(avatar.root.quaternion));
      camera.zoom = 3.6;
      camera.updateProjectionMatrix(); controls.update(); refresh();
    },
    dispose,
  };
  } catch (error) {
    dispose();
    throw error;
  }
}

export type OfficeSceneRuntime = ReturnType<typeof createOfficeSceneRuntime>;
