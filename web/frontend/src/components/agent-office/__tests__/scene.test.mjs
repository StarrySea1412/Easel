import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { OfficeResources, createOfficeWorld, createOfficeAvatar, poseOfficeAvatar, batchOfficeArchitecture, officeWorkstationRole, officeWorkstationLayoutKey } = await loadTsModule('../officeGeometry.ts', import.meta.url);
const { createSceneScheduler } = await loadTsModule('../sceneScheduler.ts', import.meta.url);
const { createOfficeSceneRuntime } = await loadTsModule('../OfficeSceneRuntime.ts', import.meta.url);
const { default: AgentOfficeScene } = await loadTsModule('../AgentOfficeScene.tsx', import.meta.url);

function transforms(root) {
  const result = [];
  root.traverse((node) => result.push([...node.position, ...node.quaternion, ...node.scale]));
  return result;
}

test('four distinct animal employees have ears, muzzles, tails and paws without human hair', () => {
  const resources = new OfficeResources();
  const world = createOfficeWorld(resources, 1);
  const earHeights = new Map();
  for (const species of ['cat', 'rabbit', 'fox', 'bear']) {
    const avatar = createOfficeAvatar(resources, world.desks[0], species, { species, shirtColor:'#AA3355', skinColor:'#D8AD8C', hairColor:'#423833', hairStyle:'bun', accessory:'glasses' });
    assert.equal(avatar.root.userData.species, species);
    assert.equal(avatar.root.getObjectByName('employee-shirt').material[0].color.getHex(), 0xaa3355);
    const face = avatar.root.getObjectByName('animal-face');
    assert.equal(face.material.vertexColors, true);
    assert.equal(new THREE.Color().fromBufferAttribute(face.geometry.getAttribute('color'), 0).getHex(), 0xd8ad8c, 'unmarked fur retains the saved palette on the continuous face');
    for (const name of ['animal-ear-left', 'animal-ear-right', 'animal-muzzle', 'animal-nose', 'animal-tail', 'animal-paw-left', 'animal-paw-right']) assert.ok(avatar.root.getObjectByName(name), `${species} has ${name}`);
    assert.equal(avatar.root.getObjectByName('employee-hair'), undefined);
    const bounds = new THREE.Box3().setFromObject(avatar.root.getObjectByName('animal-ear-left'));
    earHeights.set(species, bounds.max.y - bounds.min.y);
  }
  assert.ok(earHeights.get('rabbit') > earHeights.get('cat') * 1.4, 'rabbit ears remain visibly longer than cat ears');
  assert.ok(earHeights.get('bear') < earHeights.get('cat'), 'bear ears have a compact round silhouette');
  resources.dispose();
});

test('evidence-specific large props sit above the desk and disappear when work is not reported', () => {
  const resources = new OfficeResources();
  const world = createOfficeWorld(resources, 1);
  const avatar = createOfficeAvatar(resources, world.desks[0], 'designer', { species:'rabbit', shirtColor:'#AA3355', skinColor:'#D8AD8C', hairColor:'#423833', hairStyle:'bun', accessory:'glasses' });
  assert.equal(avatar.root.getObjectByName('employee-shirt').material[0].color.getHex(), 0xaa3355);
  assert.ok(avatar.root.getObjectByName('employee-head'));
  assert.ok(avatar.root.getObjectByName('right-arm'));
  poseOfficeAvatar(avatar, 'working', 1, false, 'reading');
  assert.equal(avatar.document.visible, true); assert.equal(avatar.tablet.visible, false);
  avatar.root.updateMatrixWorld(true);
  const readingBounds = new THREE.Box3().setFromObject(avatar.document);
  assert.ok(readingBounds.min.y >= 0.952, 'reading board clears the desktop');
  assert.ok(readingBounds.max.x - readingBounds.min.x >= 0.58, 'reading board has a visible desk-scale width');
  const pad = avatar.leftWrist.localToWorld(new THREE.Vector3(0, -.025, -.08));
  const pageContact = avatar.document.localToWorld(new THREE.Vector3(-.22, avatar.document.userData.gripY, .042));
  assert.ok(pad.distanceTo(pageContact) < 1e-8, 'the rotated finger pad reaches the actual reading surface');
  poseOfficeAvatar(avatar, 'working', 1, false, 'writing');
  avatar.root.updateMatrixWorld(true);
  assert.ok(new THREE.Box3().setFromObject(avatar.document).min.y >= 0.952, 'writing board clears the desktop');
  poseOfficeAvatar(avatar, 'working', 2, false, 'designing');
  assert.equal(avatar.document.visible, true); assert.equal(avatar.document.userData.engaged, false); assert.equal(avatar.tablet.visible, true); assert.equal(avatar.pen.visible, true);
  avatar.root.updateMatrixWorld(true);
  const tabletBounds = new THREE.Box3().setFromObject(avatar.tablet);
  assert.ok(tabletBounds.min.y >= 0.952, 'drawing tablet clears the desktop');
  assert.ok(tabletBounds.max.x - tabletBounds.min.x >= 0.63, 'drawing tablet is large enough to recognize');
  poseOfficeAvatar(avatar, 'working', 3, false, 'unreported');
  assert.equal(avatar.tablet.visible, false); assert.equal(avatar.pen.userData.held, false);
  const unreported = transforms(avatar.root);
  poseOfficeAvatar(avatar, 'working', 30, false, 'unreported');
  assert.deepEqual(transforms(avatar.root), unreported, 'missing evidence does not invent work motion');
  for (const state of ['waiting', 'stopped', 'done', 'error', 'unknown']) {
    poseOfficeAvatar(avatar, state, 4, false, 'designing');
    assert.equal(avatar.tablet.visible, false); assert.equal(avatar.document.visible, true); assert.equal(avatar.document.userData.engaged, false); assert.equal(avatar.pen.userData.held, false);
  }
  resources.dispose();
});

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
      assert.equal(object.castShadow, !object.material.transparent && object.name !== 'office-work-screen');
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

test('six stable employee roles have distinct physical workstations, while live surfaces survive batching', () => {
  const roles = ['coordinator', 'researcher', 'designer', 'writer', 'tester', 'reviewer'];
  const landmarks = [
    ['coordination-planning-board', 'coordination-side-wing'],
    ['research-reference-library', 'research-open-reference'],
    ['design-display-dock', 'design-colour-swatches', 'design-sample-rail'],
    ['writing-manuscript-stack', 'writing-pen-cup'],
    ['quality-comparison-display', 'quality-device-rack'],
    ['review-two-level-document-trays', 'review-annotated-folio'],
  ];
  const agents = roles.map((id) => ({ id, role: 'custom display title', name: id, state: 'waiting', task: '', source: 'demo' }));
  const resources = new OfficeResources();
  const world = createOfficeWorld(resources, agents.length, agents);
  const shapes = new Set();
  for (const [index, role] of roles.entries()) {
    const desk = world.desks[index];
    assert.equal(desk.workstationRole, role);
    for (const name of landmarks[index]) {
      const landmark = desk.root.getObjectByName(name);
      assert.ok(landmark, `${role}: ${name} exists in the main office`);
      let meshCount = 0; landmark.traverse((object) => { if (object instanceof THREE.Mesh) meshCount++; });
      assert.ok(meshCount >= 2, `${name} has physical equipment/materials, not an empty tag`);
    }
    desk.root.updateWorldMatrix(true, true);
    const localGeometries = [];
    desk.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.computeBoundingBox();
      localGeometries.push([...object.position, ...object.quaternion, ...object.geometry.boundingBox.min, ...object.geometry.boundingBox.max]);
    });
    shapes.add(JSON.stringify(localGeometries));
    const display = desk.root.getObjectByName('office-work-screen');
    assert.equal(display.material, desk.screen);
    const texture = new THREE.Texture(); desk.screen.map = texture;
    const avatar = createOfficeAvatar(resources, desk, role);
    const faceDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(avatar.root.quaternion);
    assert.ok(faceDirection.z > .99, 'the actor faces the open room with its rotated workstation');
  }
  assert.equal(shapes.size, roles.length, 'equipment differences survive comparison with all material colors removed');
  const beforeBounds = new THREE.Box3().setFromObject(world.root);
  const surfaces = world.desks.map((desk) => desk.root.getObjectByName('office-work-screen'));
  batchOfficeArchitecture(resources, world);
  const afterBounds = new THREE.Box3().setFromObject(world.root);
  assert.ok(beforeBounds.min.distanceTo(afterBounds.min) < 1e-6 && beforeBounds.max.distanceTo(afterBounds.max) < 1e-6);
  world.desks.forEach((desk, index) => {
    assert.equal(desk.root.getObjectByName('office-work-screen'), surfaces[index]);
    if (index < 6) assert.ok(desk.screen.map, 'observed display texture remains attached');
  });
  let batches = 0; world.root.traverse((node) => { if (node instanceof THREE.Mesh) batches++; });
  assert.ok(batches < 110, `six role layouts still batch efficiently (${batches} meshes)`);
  world.desks.forEach((desk) => desk.screen.map?.dispose());
  resources.dispose();
});

test('workstation identity follows assigned role/card, never changing task text, color or transient state', () => {
  const agent = { id: 'runtime-42', role: '协作 Agent', task: '设计一份研究报告', state: 'working', source: 'live' };
  assert.equal(officeWorkstationRole(agent), 'generic', 'task prose cannot invent an assigned role');
  assert.equal(officeWorkstationRole({ ...agent, role: '资料研究' }), 'researcher');
  assert.equal(officeWorkstationRole({ ...agent, role: '任务协调', appearance: { id: 'writer', role: '自定义名称' } }), 'writer');
  const assigned = { ...agent, appearance: { id: 'designer', role: '视觉设计', shirtColor: '#ffffff' } };
  assert.equal(officeWorkstationLayoutKey([assigned]), officeWorkstationLayoutKey([{ ...assigned, task: 'other work', state: 'error', name: 'new label', appearance: { ...assigned.appearance, shirtColor: '#000000' } }]));
  assert.notEqual(officeWorkstationLayoutKey([assigned]), officeWorkstationLayoutKey([{ ...assigned, appearance: { ...assigned.appearance, id: 'reviewer' } }]));
});

test('agent state changes drive real transforms, independent screens and selection', () => {
  const resources = new OfficeResources();
  const world = createOfficeWorld(resources, 8);
  const avatar = createOfficeAvatar(resources, world.desks[0], 'agent-1');
  const second = createOfficeAvatar(resources, world.desks[1], 'agent-2');
  assert.equal(avatar.root.userData.agentId, 'agent-1');
  poseOfficeAvatar(avatar, 'working', 0, true, 'executing');
  const firstPaw = transforms(avatar.leftArm);
  poseOfficeAvatar(avatar, 'working', 0.1, false, 'executing');
  assert.notDeepEqual(transforms(avatar.leftArm), firstPaw, 'reported execution moves articulated limbs');
  assert.equal(avatar.selection.visible, false);
  assert.equal(avatar.screen.emissiveIntensity, 0.46);
  poseOfficeAvatar(avatar, 'thinking', 2, false);
  const thinking = transforms(avatar.root);
  poseOfficeAvatar(avatar, 'thinking', 2.4, false);
  assert.notDeepEqual(transforms(avatar.root), thinking, 'thinking has its own active pose');
  poseOfficeAvatar(avatar, 'done', 4, true);
  assert.equal(avatar.tablet.visible, false);
  const done = transforms(avatar.root);
  poseOfficeAvatar(avatar, 'done', 40, true);
  assert.deepEqual(transforms(avatar.root), done, 'completed work settles instead of looping');
  assert.equal(avatar.statusMaterial.color.getHex(), 0x67a877);
  assert.equal(avatar.selection.visible, true);
  poseOfficeAvatar(second, 'error', 3, false);
  const error = transforms(second.root);
  poseOfficeAvatar(second, 'error', 30, false);
  assert.deepEqual(transforms(second.root), error, 'errors remain a stable visible state');
  assert.equal(second.statusMaterial.color.getHex(), 0xd66d64);
  assert.equal(avatar.statusMaterial.color.getHex(), 0x67a877, 'other desks do not share mutable agent status materials');
  poseOfficeAvatar(avatar, 'waiting', 0, false);
  const waiting = [avatar.head.position.y, avatar.head.rotation.y, avatar.leftArm.rotation.x, avatar.rightArm.rotation.z, avatar.beacon.scale.x];
  poseOfficeAvatar(avatar, 'waiting', 20, false);
  assert.deepEqual([avatar.head.position.y, avatar.head.rotation.y, avatar.leftArm.rotation.x, avatar.rightArm.rotation.z, avatar.beacon.scale.x], waiting);
  assert.equal(avatar.tablet.visible, false);
  poseOfficeAvatar(avatar, 'stopped', 0, false);
  const stopped = [avatar.head.position.y, avatar.head.rotation.y, avatar.leftArm.rotation.x, avatar.rightArm.rotation.z, avatar.beacon.scale.x];
  poseOfficeAvatar(avatar, 'stopped', 20, false);
  assert.deepEqual([avatar.head.position.y, avatar.head.rotation.y, avatar.leftArm.rotation.x, avatar.rightArm.rotation.z, avatar.beacon.scale.x], stopped);
  assert.equal(avatar.statusMaterial.color.getHex(), 0x899397);
  assert.equal(avatar.screen.color.getHex(), 0xb8c3bd);
  assert.equal(avatar.tablet.visible, false);
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
  const agents = [{ id: 'agent-1', name: 'Scout', role: '研究', task: '核对资料', state: 'working', source: 'demo', action: { kind: 'executing', evidence: 'demo', label: '演示检查' } }];
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

test('explicit tour pauses with the scene, keeps observed agents at their stations, and releases its assets when closed', () => {
  const h=runtimeHarness();
  const runtime=createOfficeSceneRuntime({...h.options,tourEnabled:true},h.make);
  h.clock.tick(0);
  const mascot=h.calls.scene.getObjectByName('scene-tour-guide');
  assert.ok(mascot);
  const actual=h.calls.scene.getObjectByName('employee:agent-1');
  const actualPosition=actual.position.clone();
  for(let i=1;i<75;i++)h.clock.tick(i*60);
  const position=mascot.position.clone();
  assert.notEqual(position.x,0,'tour must walk beyond its initial pause');
  assert.deepEqual(actual.position,actualPosition,'the actual agent stays at its workstation');
  runtime.update({...h.options,tourEnabled:true,paused:true});h.clock.tick(4500);
  const paused=mascot.position.clone();h.clock.tick(5500);
  assert.deepEqual(mascot.position,paused);assert.equal(h.clock.pending.size,0);
  let disposals=0;
  mascot.getObjectByName('tour-leg-0').children[0].geometry.addEventListener('dispose',()=>disposals++);
  runtime.update({...h.options,tourEnabled:false,paused:true});h.clock.tick(5600);
  assert.equal(h.calls.scene.getObjectByName('scene-tour-guide'),undefined);
  assert.equal(disposals,1);
  runtime.dispose(); assert.equal(disposals,1);
  h.host.remove();h.window.close();
});

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
  calls.scene.traverse((item) => { if (item instanceof THREE.Mesh) { geometries.add(item.geometry); for (const material of Array.isArray(item.material) ? item.material : [item.material]) materials.add(material); } });
  let disposals = 0;
  for (const item of [...geometries, ...materials]) item.addEventListener('dispose', () => disposals++);
  runtime.update({ agents, selectedId: 'agent-1', paused: true });
  clock.tick(16);
  assert.equal(calls.made, 1);
  assert.equal(calls.camera, camera);
  assert.equal(calls.scene.getObjectByName('warm-isometric-office'), world);
  assert.equal(clock.pending.size, 0);
  assert.equal(calls.scene.getObjectByName('employee:agent-1').children.find((child) => child.geometry?.type === 'TorusGeometry' && child.position.y < 0).visible, true);
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

test('main office close-up shows the face and preserves camera during palette/role updates', () => {
  const harness = runtimeHarness();
  const runtime = createOfficeSceneRuntime(harness.options, harness.make);
  harness.clock.tick(0);
  const avatar = harness.calls.scene.getObjectByName('employee:agent-1');
  const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(avatar.quaternion);
  assert.ok(facing.dot(harness.calls.camera.position.clone().sub(avatar.position).normalize()) > .45, 'default view sees the open face side');
  runtime.focus('agent-1'); harness.clock.tick(16);
  assert.ok(facing.dot(harness.calls.camera.position.clone().sub(avatar.position).normalize()) > .60, 'close-up is in front of the face instead of behind the head');
  const position = harness.calls.camera.position.clone(), quaternion = harness.calls.camera.quaternion.clone(), zoom = harness.calls.camera.zoom;
  const originalWorld = harness.calls.scene.getObjectByName('warm-isometric-office');
  const originalScreen = originalWorld.getObjectByName('desk-1').getObjectByName('office-work-screen').material;
  let screenDisposals = 0; originalScreen.addEventListener('dispose', () => screenDisposals++);
  const edited = { ...harness.agents[0], appearance: { id: 'researcher', species: 'fox', shirtColor: '#123456', skinColor: '#bbaa99' } };
  runtime.update({ agents: [edited], selectedId: 'agent-1', paused: true }); harness.clock.tick(32);
  assert.equal(harness.calls.scene.getObjectByName('warm-isometric-office'), originalWorld, 'palette edit preserves physical workstation and screen');
  assert.equal(screenDisposals, 0);
  runtime.update({ agents: [{ ...edited, appearance: { ...edited.appearance, id: 'designer' } }], selectedId: 'agent-1', paused: true }); harness.clock.tick(48);
  const newWorld = harness.calls.scene.getObjectByName('warm-isometric-office');
  assert.notEqual(newWorld, originalWorld, 'a real role assignment rebuilds the matching equipment');
  assert.equal(newWorld.getObjectByName('desk-1').userData.workstationRole, 'designer');
  assert.equal(screenDisposals, 1, 'old world surface is released exactly once');
  assert.deepEqual(harness.calls.camera.position, position); assert.deepEqual(harness.calls.camera.quaternion.toArray(), quaternion.toArray()); assert.equal(harness.calls.camera.zoom, zoom);
  assert.equal(harness.calls.made, 1, 'role changes reuse the renderer');
  runtime.dispose(); assert.equal(screenDisposals, 1);
  harness.window.happyDOM.abort();
});

test('terminal agents update state immediately, settle briefly and then stop scheduling frames', () => {
  const harness = runtimeHarness();
  const runtime = createOfficeSceneRuntime(harness.options, harness.make);
  harness.clock.tick(0);
  assert.equal(harness.clock.pending.size, 1);
  runtime.update({ agents: [{ ...harness.agents[0], state: 'stopped' }], selectedId: null, paused: false });
  harness.clock.tick(16);
  assert.equal(harness.clock.pending.size, 1, 'one brief body transition may finish');
  const avatar = harness.calls.scene.getObjectByName('employee:agent-1');
  assert.ok(avatar.children.some((child) => child instanceof THREE.Mesh && child.material.color.getHex() === 0x899397));
  let time = 16;
  for (let i = 0; i < 9; i++) harness.clock.tick(time += 60);
  assert.equal(harness.clock.pending.size, 0, 'settling terminates after 420ms');
  for (const state of ['done', 'error', 'waiting', 'unknown']) {
    runtime.update({ agents: [{ ...harness.agents[0], state }], selectedId: null, paused: false });
    const before = harness.calls.render;
    harness.clock.tick(time += 16);
    assert.equal(harness.calls.render, before + 1, `${state} repaints immediately`);
    for (let i = 0; i < 9; i++) harness.clock.tick(time += 60);
    assert.equal(harness.clock.pending.size, 0, `${state} does not leave recurring frames`);
  }
  runtime.dispose();
  harness.window.happyDOM.abort();
});

test('demo seeking replaces the pose at the selected time while retaining renderer, identity and close-up', () => {
  const harness = runtimeHarness();
  const runtime = createOfficeSceneRuntime(harness.options, harness.make);
  harness.clock.tick(0);
  runtime.focus('agent-1'); harness.clock.tick(16);
  const avatar = harness.calls.scene.getObjectByName('employee:agent-1');
  const camera = harness.calls.camera;
  const position = camera.position.clone(), rotation = camera.quaternion.clone(), zoom = camera.zoom;
  const seek = (seconds, revision) => {
    runtime.update({ agents: harness.agents, selectedId: 'agent-1', paused: true, demoSeek: { seconds, revision } });
    harness.clock.tick(revision * 1000);
    assert.equal(harness.calls.scene.getObjectByName('employee:agent-1'), avatar);
    assert.equal(harness.clock.pending.size, 0);
    return transforms(avatar);
  };
  const first = seek(18, 1);
  const second = seek(28, 2);
  assert.notDeepEqual(first, second);
  assert.deepEqual(seek(18, 3), first, 'same time has identical posture even after seeking backward');
  assert.equal(harness.calls.camera, camera);
  assert.deepEqual(camera.position, position); assert.deepEqual(camera.quaternion.toArray(), rotation.toArray()); assert.equal(camera.zoom, zoom);
  assert.equal(harness.calls.made, 1);
  runtime.dispose(); harness.window.happyDOM.abort();
});

test('motion resumes without accumulating paused, hidden, unfocused or reduced-motion wall time', () => {
  const harness = runtimeHarness();
  const { clock, calls, window, media, observers, agents } = harness;
  const runtime = createOfficeSceneRuntime(harness.options, harness.make);
  let time = 0;
  clock.tick(time);
  clock.tick(time += 16);
  const avatar = calls.scene.getObjectByName('employee:agent-1');
  const changeVisibility = (hidden) => {
    Object.defineProperty(window.document, 'hidden', { value: hidden, configurable: true });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
  };
  const changeMotion = (matches) => { media.matches = matches; media.dispatchEvent(new window.Event('change')); };
  const modes = [
    [() => runtime.update({ agents, selectedId: null, paused: true }), () => runtime.update({ agents, selectedId: null, paused: false })],
    [() => window.dispatchEvent(new window.Event('blur')), () => window.dispatchEvent(new window.Event('focus'))],
    [() => changeVisibility(true), () => changeVisibility(false)],
    [() => changeMotion(true), () => changeMotion(false)],
    [() => observers[1].callback([{ isIntersecting: false }]), () => observers[1].callback([{ isIntersecting: true }])],
  ];
  for (const [freeze, resume] of modes) {
    const before = transforms(avatar);
    freeze();
    clock.tick(time += 10000);
    assert.equal(clock.pending.size, 0);
    assert.deepEqual(transforms(avatar), before, 'suspended time does not advance joints');
    resume();
    clock.tick(time += 10000);
    assert.deepEqual(transforms(avatar), before, 'first resumed frame keeps the frozen pose');
    clock.tick(time += 16);
    assert.notDeepEqual(transforms(avatar), before, 'subsequent active frames move normally');
  }
  runtime.dispose();
  window.happyDOM.abort();
});

test('unreported evidence suppresses a claimed tool action and paused action changes repaint immediately', () => {
  const harness = runtimeHarness();
  const runtime = createOfficeSceneRuntime(harness.options, harness.make);
  const agent = { ...harness.agents[0], source: 'session', action: { kind: 'designing', evidence: 'unreported', label: 'untrusted claim' } };
  runtime.update({ agents: [agent], selectedId: null, paused: false });
  harness.clock.tick(0);
  assert.equal(harness.clock.pending.size, 0, 'no active loop without reported operation');
  const avatar = harness.calls.scene.getObjectByName('employee:agent-1');
  const before = transforms(avatar);
  runtime.update({ agents: [agent], selectedId: null, paused: false });
  harness.clock.tick(10000);
  assert.deepEqual(transforms(avatar), before);
  runtime.update({ agents: [{ ...agent, action: { kind: 'designing', evidence: 'observed', label: 'draw' } }], selectedId: null, paused: true });
  harness.clock.tick(10016);
  assert.notDeepEqual(transforms(avatar), before, 'new evidence updates pose even while motion is paused');
  assert.equal(harness.clock.pending.size, 0);
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
    const oldAvatar = harness.calls.scene.getObjectByName(`employee:${currentId}`);
    const exclusive = new Set();
    oldAvatar.traverse((object) => {
      if (object instanceof THREE.Mesh) { exclusive.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) exclusive.add(material); }
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
    assert.ok(harness.calls.scene.getObjectByName(`employee:${currentId}`));
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
