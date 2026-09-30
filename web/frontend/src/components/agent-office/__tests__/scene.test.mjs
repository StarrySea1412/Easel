import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { OfficeResources, createOfficeWorld, createOfficeAvatar, poseOfficeAvatar, batchOfficeArchitecture } = await loadTsModule('../officeGeometry.ts', import.meta.url);
const { createSceneScheduler } = await loadTsModule('../sceneScheduler.ts', import.meta.url);
const { createOfficeSceneRuntime } = await loadTsModule('../OfficeSceneRuntime.ts', import.meta.url);
const { default: AgentOfficeScene } = await loadTsModule('../AgentOfficeScene.tsx', import.meta.url);

test('real Three office geometry includes every station and batches furniture without changing bounds', () => {
  const resources = new OfficeResources();
  const world = createOfficeWorld(resources, 20);
  assert.equal(world.desks.length, 20);
  assert.equal(new Set(world.desks.map(({ slot }) => `${slot.x}:${slot.z}`)).size, 20);
  const beforeBounds = new THREE.Box3().setFromObject(world.root);
  let before = 0, after = 0;
  world.root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      before++;
      assert.ok(object.geometry.getAttribute('position').count > 0);
      assert.equal(object.material.map, null, 'scene is actual geometry without a background image');
      assert.equal(object.castShadow, !object.material.transparent);
    }
  });
  assert.ok(before > 1000);
  batchOfficeArchitecture(resources, world);
  world.root.traverse((object) => { if (object instanceof THREE.Mesh) after++; });
  assert.ok(after < 100, `expected fewer than 100 furniture meshes; got ${after} from ${before}`);
  const afterBounds = new THREE.Box3().setFromObject(world.root);
  assert.ok(beforeBounds.min.distanceTo(afterBounds.min) < 0.00001);
  assert.ok(beforeBounds.max.distanceTo(afterBounds.max) < 0.00001);
  assert.ok([...afterBounds.min, ...afterBounds.max].every(Number.isFinite));
  assert.ok(world.desks.every((desk) => desk.root.children.some((child) => child.material === desk.screen)), 'animated screens remain separate from static batches');
  resources.dispose();
});

test('empty office keeps eight desks, while larger populations are never truncated', () => {
  for (const [count, expected] of [[0, 8], [6, 8], [21, 21]]) {
    const resources = new OfficeResources();
    const world = createOfficeWorld(resources, count);
    assert.equal(world.desks.length, expected);
    resources.dispose();
  }
});

test('agent state changes drive real transforms, independent screens and selection', () => {
  const resources = new OfficeResources();
  const world = createOfficeWorld(resources, 8);
  const avatar = createOfficeAvatar(resources, world.desks[0], 'agent-1');
  const second = createOfficeAvatar(resources, world.desks[1], 'agent-2');
  assert.equal(avatar.root.userData.agentId, 'agent-1');
  poseOfficeAvatar(avatar, 'working', 0, true);
  const firstPaw = avatar.leftPaw.rotation.x;
  poseOfficeAvatar(avatar, 'working', 0.1, false);
  assert.notEqual(avatar.leftPaw.rotation.x, firstPaw);
  assert.equal(avatar.selection.visible, false);
  assert.equal(avatar.screen.emissiveIntensity, 0.46);
  poseOfficeAvatar(avatar, 'thinking', 2, false);
  assert.equal(avatar.halo.visible, true);
  assert.notEqual(avatar.head.rotation.z, 0);
  poseOfficeAvatar(avatar, 'done', 4, true);
  assert.equal(avatar.halo.visible, false);
  assert.ok(avatar.rightPaw.rotation.z < -1);
  assert.equal(avatar.statusMaterial.color.getHex(), 0x67a877);
  assert.equal(avatar.selection.visible, true);
  poseOfficeAvatar(second, 'error', 3, false);
  assert.equal(second.statusMaterial.color.getHex(), 0xd66d64);
  assert.equal(avatar.statusMaterial.color.getHex(), 0x67a877, 'other desks do not share mutable agent status materials');
  poseOfficeAvatar(avatar, 'waiting', 0, false);
  const waiting = [avatar.head.position.y, avatar.head.rotation.y, avatar.leftPaw.rotation.x, avatar.rightPaw.rotation.z, avatar.beacon.scale.x];
  poseOfficeAvatar(avatar, 'waiting', 20, false);
  assert.deepEqual([avatar.head.position.y, avatar.head.rotation.y, avatar.leftPaw.rotation.x, avatar.rightPaw.rotation.z, avatar.beacon.scale.x], waiting);
  assert.equal(avatar.halo.visible, false);
  poseOfficeAvatar(avatar, 'stopped', 0, false);
  const stopped = [avatar.head.position.y, avatar.head.rotation.y, avatar.leftPaw.rotation.x, avatar.rightPaw.rotation.z, avatar.beacon.scale.x];
  poseOfficeAvatar(avatar, 'stopped', 20, false);
  assert.deepEqual([avatar.head.position.y, avatar.head.rotation.y, avatar.leftPaw.rotation.x, avatar.rightPaw.rotation.z, avatar.beacon.scale.x], stopped);
  assert.equal(avatar.statusMaterial.color.getHex(), 0x899397);
  assert.equal(avatar.screen.color.getHex(), 0xb8c3bd);
  assert.equal(avatar.halo.visible, false);
  resources.dispose();
});

test('shared geometry and materials are disposed exactly once', () => {
  const resources = new OfficeResources();
  const geometry = resources.geometry('shared', () => new THREE.BoxGeometry());
  const material = resources.material('shared', { color: 'white' });
  assert.equal(resources.geometry('shared', () => { throw Error('duplicate geometry'); }), geometry);
  assert.equal(resources.material('shared', { color: 'black' }), material);
  let geometryDisposals = 0, materialDisposals = 0;
  geometry.addEventListener('dispose', () => geometryDisposals++);
  material.addEventListener('dispose', () => materialDisposals++);
  resources.dispose();
  resources.dispose();
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
});

function frames() {
  let id = 0;
  const pending = new Map();
  return {
    pending,
    request(callback) { pending.set(++id, callback); return id; },
    cancel(key) { pending.delete(key); },
    tick(time) { const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback(time); },
  };
}

test('RAF scheduler runs only one frame at a time and stops when paused, hidden or disposed', () => {
  const clock = frames();
  let moving = true, shown = true, draws = 0;
  const scheduler = createSceneScheduler({ request: clock.request, cancel: clock.cancel, draw: () => draws++, animate: () => moving, visible: () => shown });
  scheduler.invalidate(); scheduler.invalidate(); scheduler.invalidate();
  assert.equal(clock.pending.size, 1);
  clock.tick(0);
  assert.equal(draws, 1);
  assert.equal(clock.pending.size, 1);
  moving = false;
  scheduler.refresh();
  clock.tick(20);
  assert.equal(clock.pending.size, 0);
  assert.equal(draws, 2, 'a paused scene still repaints once for selection or camera movement');
  shown = false;
  scheduler.refresh(); scheduler.invalidate();
  assert.equal(clock.pending.size, 0);
  shown = true;
  moving = true;
  scheduler.refresh();
  assert.equal(clock.pending.size, 1);
  scheduler.dispose(); scheduler.dispose(); scheduler.invalidate();
  assert.equal(clock.pending.size, 0);
});

function runtimeHarness({ throwOnRender = false } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  window.document.hasFocus = () => true;
  Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
  const media = new window.EventTarget();
  media.matches = false;
  window.matchMedia = () => media;
  const clock = frames();
  window.requestAnimationFrame = clock.request;
  window.cancelAnimationFrame = clock.cancel;
  const observers = [];
  const Observer = class {
    disconnected = false;
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  globalThis.ResizeObserver = Observer;
  globalThis.IntersectionObserver = Observer;
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ width: 1000, height: 600, x: 0, y: 0, left: 0, top: 0 });
  const sign = document.createElement('span');
  host.append(sign);
  document.body.append(host);
  const label = document.createElement('button');
  host.append(label);
  const agents = [{ id: 'agent-1', name: 'Scout', role: '研究', task: '核对资料', state: 'working', source: 'demo' }];
  const unavailable = [];
  const calls = { render: 0, disposed: 0, lost: 0, made: 0, scene: null, camera: null };
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = host.getBoundingClientRect;
  const renderer = {
    domElement: canvas, shadowMap: {},
    setPixelRatio() {}, setClearColor() {}, setSize() {},
    render(scene, camera) {
      if (throwOnRender) throw new Error('simulated render failure');
      calls.render++; calls.scene = scene; calls.camera = camera;
      scene.updateMatrixWorld(true);
    },
    dispose() { calls.disposed++; },
    forceContextLoss() { calls.lost++; canvas.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true })); },
  };
  const options = { host, labels: new Map([['agent-1', label]]), sign, agents, selectedId: null, paused: false, onSelect() {}, onUnavailable: (message) => unavailable.push(message) };
  const make = () => { calls.made++; return renderer; };
  return { options, make, calls, clock, window, media, observers, host, canvas, unavailable, agents, label };
}

test('simulated DOM with real Three/OrbitControls preserves renderer on selection, pauses and releases resources on exit', () => {
  const harness = runtimeHarness();
  const { options, make, calls, clock, window, observers, host, agents, label } = harness;
  const runtime = createOfficeSceneRuntime(options, make);
  assert.equal(calls.made, 1);
  assert.equal(host.querySelectorAll('canvas').length, 1);
  clock.tick(0);
  assert.equal(calls.render, 1);
  assert.match(label.style.transform, /translate/);
  const camera = calls.camera;
  const world = calls.scene.getObjectByName('warm-isometric-office');
  const geometries = new Set(), materials = new Set();
  calls.scene.traverse((item) => { if (item instanceof THREE.Mesh) { geometries.add(item.geometry); materials.add(item.material); } });
  let disposals = 0;
  for (const item of [...geometries, ...materials]) item.addEventListener('dispose', () => disposals++);
  runtime.update({ agents, selectedId: 'agent-1', paused: true });
  clock.tick(16);
  assert.equal(calls.made, 1);
  assert.equal(calls.camera, camera);
  assert.equal(calls.scene.getObjectByName('warm-isometric-office'), world);
  assert.equal(clock.pending.size, 0);
  assert.equal(calls.scene.getObjectByName('agent:agent-1').children.find((child) => child.geometry?.type === 'TorusGeometry' && child.position.y < 0).visible, true);
  runtime.update({ agents, selectedId: null, paused: false });
  clock.tick(32);
  assert.equal(clock.pending.size, 1);
  window.dispatchEvent(new window.Event('blur'));
  clock.tick(48);
  assert.equal(clock.pending.size, 0);
  window.dispatchEvent(new window.Event('focus'));
  clock.tick(64);
  assert.equal(clock.pending.size, 1);
  Object.defineProperty(window.document, 'hidden', { value: true, configurable: true });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(clock.pending.size, 0);
  runtime.dispose(); runtime.dispose();
  assert.equal(calls.disposed, 1);
  assert.equal(calls.lost, 1);
  assert.equal(host.querySelectorAll('canvas').length, 0);
  assert.equal(clock.pending.size, 0);
  assert.ok(observers.every((observer) => observer.disconnected));
  assert.equal(disposals, geometries.size + materials.size);
  window.dispatchEvent(new window.Event('focus'));
  assert.equal(clock.pending.size, 0);
  assert.deepEqual(harness.unavailable, [], 'intentional disposal does not report context failure');
  window.happyDOM.abort();
});

test('simulated reduced motion stops recurring frames and context loss reports an honest unavailable state', () => {
  const harness = runtimeHarness();
  const runtime = createOfficeSceneRuntime(harness.options, harness.make);
  harness.clock.tick(0);
  harness.media.matches = true;
  harness.media.dispatchEvent(new harness.window.Event('change'));
  harness.clock.tick(16);
  assert.equal(harness.clock.pending.size, 0);
  const lost = new harness.window.Event('webglcontextlost', { cancelable: true });
  harness.canvas.dispatchEvent(lost);
  assert.equal(lost.defaultPrevented, true);
  assert.equal(harness.clock.pending.size, 0);
  assert.equal(harness.unavailable.length, 1);
  assert.match(harness.unavailable[0], /三维画面连接已中断/);
  runtime.dispose();
  harness.window.happyDOM.abort();
});

test('stopped agents repaint their final state once without keeping an animation loop alive', () => {
  const harness = runtimeHarness();
  const runtime = createOfficeSceneRuntime(harness.options, harness.make);
  harness.clock.tick(0);
  assert.equal(harness.clock.pending.size, 1);
  runtime.update({ agents: [{ ...harness.agents[0], state: 'stopped' }], selectedId: null, paused: false });
  harness.clock.tick(16);
  assert.equal(harness.clock.pending.size, 0);
  const avatar = harness.calls.scene.getObjectByName('agent:agent-1');
  assert.ok(avatar.children.some((child) => child instanceof THREE.Mesh && child.material.color.getHex() === 0x899397));
  runtime.dispose();
  harness.window.happyDOM.abort();
});

test('replacing agent identities within the same layout releases old avatars while preserving live desk screens', () => {
  const harness = runtimeHarness();
  const runtime = createOfficeSceneRuntime(harness.options, harness.make);
  harness.clock.tick(0);
  const world = harness.calls.scene.getObjectByName('warm-isometric-office');
  const screen = world.getObjectByName('desk-1').children.find((child) => child instanceof THREE.Mesh).material;
  let screenDisposals = 0;
  screen.addEventListener('dispose', () => screenDisposals++);
  const disposalCounts = new Map();
  let currentId = 'agent-1';
  for (let index = 0; index < 5; index++) {
    const oldAvatar = harness.calls.scene.getObjectByName(`agent:${currentId}`);
    const exclusive = new Set();
    oldAvatar.traverse((object) => {
      if (object instanceof THREE.Mesh) { exclusive.add(object.geometry); exclusive.add(object.material); }
    });
    for (const asset of exclusive) {
      disposalCounts.set(asset, 0);
      asset.addEventListener('dispose', () => disposalCounts.set(asset, disposalCounts.get(asset) + 1));
    }
    currentId = `replacement-${index}`;
    runtime.update({ agents: [{ ...harness.agents[0], id: currentId, state: 'error' }], selectedId: null, paused: true });
    harness.clock.tick(16 + index * 16);
    assert.equal(harness.calls.scene.getObjectByName('warm-isometric-office'), world);
    assert.equal(oldAvatar.parent, null);
    assert.ok(harness.calls.scene.getObjectByName(`agent:${currentId}`));
    assert.ok([...exclusive].every((asset) => disposalCounts.get(asset) === 1), 'every replaced avatar asset is released immediately');
    assert.equal(screenDisposals, 0, 'shared desk display remains owned by the world');
    assert.equal(screen.color.getHex(), 0xd9a59d, 'new agent still animates the surviving display');
    assert.equal(harness.calls.made, 1);
  }
  runtime.dispose();
  assert.equal(screenDisposals, 1);
  assert.ok([...disposalCounts.values()].every((count) => count === 1), 'old avatar resources are not disposed again during final teardown');
  harness.window.happyDOM.abort();
});

test('partial initialization failure removes the canvas and disposes the allocated renderer', () => {
  const harness = runtimeHarness();
  harness.host.getBoundingClientRect = () => { throw new Error('simulated initial layout failure'); };
  assert.throws(() => createOfficeSceneRuntime(harness.options, harness.make), /simulated initial layout failure/);
  assert.equal(harness.calls.disposed, 1);
  assert.equal(harness.calls.lost, 1);
  assert.equal(harness.host.querySelectorAll('canvas').length, 0);
  assert.equal(harness.clock.pending.size, 0);
  assert.ok(harness.observers.every((observer) => observer.disconnected));
  harness.window.happyDOM.abort();
});

test('rendering failures stop animation and report the unavailable view', () => {
  const harness = runtimeHarness({ throwOnRender: true });
  const runtime = createOfficeSceneRuntime(harness.options, harness.make);
  harness.clock.tick(0);
  assert.equal(harness.unavailable.length, 1);
  assert.match(harness.unavailable[0], /无法继续绘制/);
  assert.equal(harness.clock.pending.size, 0);
  runtime.dispose();
  harness.window.happyDOM.abort();
});

test('React shows an honest WebGL failure and offers a retry without creating a substitute scene', async () => {
  const harness = runtimeHarness();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const reported = [];
  const originalError = console.error;
  console.error = (...args) => {
    if (String(args[0]).includes('THREE.WebGLRenderer:')) return;
    originalError(...args);
  };
  try {
    await act(async () => root.render(React.createElement(AgentOfficeScene, {
      agents: harness.agents, selectedId: null, onSelect() {}, paused: false, resetKey: 0,
      onUnavailable: (message) => reported.push(message),
    })));
    assert.equal(reported.length, 1);
    assert.match(element.querySelector('[role="status"]').textContent, /三维场景暂不可用/);
    assert.equal(element.querySelector('canvas'), null);
    assert.equal(element.querySelector('.agent-office-scene__labels').hidden, true);
    const retry = element.querySelector('.agent-office-scene__fallback button');
    assert.equal(retry.textContent, '重新加载场景');
    await act(async () => retry.click());
    assert.equal(reported.length, 2);
    assert.equal(element.querySelector('canvas'), null);
  } finally {
    await act(async () => root.unmount());
    console.error = originalError;
    harness.window.happyDOM.abort();
  }
});
