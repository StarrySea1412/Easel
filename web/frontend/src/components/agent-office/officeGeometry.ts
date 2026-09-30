import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { OfficeAgent } from '../../lib/agentOffice';

type AgentState = OfficeAgent['state'];

export const OFFICE_STATE_COLORS: Record<AgentState, number> = {
  working: 0x5da8a2, thinking: 0xd0a251, waiting: 0x99a2aa, stopped: 0x899397,
  done: 0x67a877, error: 0xd66d64, unknown: 0x9099a7,
};

/** Geometry and materials are shared within one renderer and disposed once. */
export class OfficeResources {
  private geometries = new Map<string, THREE.BufferGeometry>();
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private disposed = false;

  geometry(key: string, create: () => THREE.BufferGeometry) {
    let value = this.geometries.get(key);
    if (!value) { value = create(); this.geometries.set(key, value); }
    return value;
  }

  material(key: string, options: THREE.MeshStandardMaterialParameters) {
    let value = this.materials.get(key);
    if (!value) {
      value = new THREE.MeshStandardMaterial({ roughness: 0.78, ...options });
      this.materials.set(key, value);
    }
    return value;
  }

  color(color: number) { return this.material(`color:${color}`, { color }); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
  }
}

export interface DeskSlot {
  index: number;
  x: number;
  z: number;
}

export function officeLayout(agentCount: number) {
  const count = Math.max(8, Math.floor(agentCount));
  const columns = count > 12 ? 5 : 4;
  const rows = Math.ceil(count / columns);
  const width = columns * 2.35 + 2.8;
  const depth = Math.max(9.8, rows * 2.6 + 4.6);
  const slots: DeskSlot[] = Array.from({ length: count }, (_, index) => ({
    index,
    x: (index % columns - (columns - 1) / 2) * 2.35,
    z: (Math.floor(index / columns) - (rows - 1) / 2) * 2.6 + 0.4,
  }));
  return { columns, rows, width, depth, slots, key: `${columns}:${rows}:${count}` };
}

function mesh(
  parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material,
  x: number, y: number, z: number,
) {
  const result = new THREE.Mesh(geometry, material);
  result.position.set(x, y, z);
  result.castShadow = !material.transparent;
  result.receiveShadow = true;
  parent.add(result);
  return result;
}

function box(
  resources: OfficeResources, parent: THREE.Object3D, material: THREE.Material,
  size: [number, number, number], position: [number, number, number], round = true,
) {
  const key = `${round ? 'round' : 'box'}:${size.join(':')}`;
  const geometry = resources.geometry(key, () => round
    ? new RoundedBoxGeometry(...size, 2, Math.min(0.06, ...size.map((value) => value / 4)))
    : new THREE.BoxGeometry(...size));
  return mesh(parent, geometry, material, ...position);
}

function cylinder(
  resources: OfficeResources, parent: THREE.Object3D, material: THREE.Material,
  top: number, bottom: number, height: number, x: number, y: number, z: number,
  sides = 12,
) {
  return mesh(parent, resources.geometry(`cylinder:${top}:${bottom}:${height}:${sides}`,
    () => new THREE.CylinderGeometry(top, bottom, height, sides)), material, x, y, z);
}

function sphere(
  resources: OfficeResources, parent: THREE.Object3D, material: THREE.Material,
  radius: number, x: number, y: number, z: number, segments = 10,
) {
  return mesh(parent, resources.geometry(`sphere:${radius}:${segments}`,
    () => new THREE.SphereGeometry(radius, segments, 7)), material, x, y, z);
}

function plant(resources: OfficeResources, parent: THREE.Object3D, x: number, z: number, scale = 1) {
  const group = new THREE.Group();
  group.name = 'plant';
  group.position.set(x, 0, z);
  group.scale.setScalar(scale);
  parent.add(group);
  cylinder(resources, group, resources.color(0xc89376), 0.27, 0.21, 0.42, 0, 0.22, 0);
  cylinder(resources, group, resources.color(0x69544a), 0.235, 0.235, 0.03, 0, 0.435, 0);
  for (let index = 0; index < 7; index++) {
    const angle = index * 2.4;
    const stem = cylinder(resources, group, resources.color(0x637450), 0.018, 0.024, 0.75, 0, 0.78, 0, 5);
    stem.rotation.z = Math.cos(angle) * 0.27;
    stem.rotation.x = Math.sin(angle) * 0.27;
    const leaf = sphere(resources, group, resources.color(index % 2 ? 0x778d68 : 0x98a97c), 0.27,
      Math.cos(angle) * 0.24, 1.05 + (index % 3) * 0.15, Math.sin(angle) * 0.24, 7);
    leaf.scale.set(0.55, 1.45, 0.9);
    leaf.rotation.z = Math.cos(angle) * 0.6;
    leaf.rotation.x = Math.sin(angle) * 0.4;
  }
}

function mug(resources: OfficeResources, parent: THREE.Object3D, x: number, y: number, z: number) {
  cylinder(resources, parent, resources.color(0xe7dfcd), 0.075, 0.065, 0.13, x, y, z);
  cylinder(resources, parent, resources.color(0x5e4940), 0.061, 0.061, 0.006, x, y + 0.068, z);
  const handle = mesh(parent, resources.geometry('mug-handle', () => new THREE.TorusGeometry(0.047, 0.014, 5, 10)),
    resources.color(0xe7dfcd), x + 0.085, y, z);
  handle.rotation.y = Math.PI / 2;
}

export interface OfficeDesk {
  root: THREE.Group;
  slot: DeskSlot;
  screen: THREE.MeshStandardMaterial;
}

function desk(resources: OfficeResources, parent: THREE.Object3D, slot: DeskSlot): OfficeDesk {
  const root = new THREE.Group();
  root.name = `desk-${slot.index + 1}`;
  root.position.set(slot.x, 0, slot.z);
  parent.add(root);
  const cream = resources.color(0xf5f0e6);
  const wood = resources.color(0xccb69a);
  const metal = resources.color(0xbac1c1);
  box(resources, root, wood, [1.76, 0.09, 0.88], [0, 0.88, 0]);
  box(resources, root, cream, [1.75, 0.035, 0.87], [0, 0.935, 0]);
  for (const x of [-0.72, 0.72]) for (const z of [-0.32, 0.32]) {
    cylinder(resources, root, wood, 0.048, 0.062, 0.83, x, 0.43, z, 8);
  }
  box(resources, root, resources.color(0xd4cbbc), [0.34, 0.35, 0.65], [0.56, 0.66, 0]);
  box(resources, root, resources.color(0xa99d8b), [0.12, 0.02, 0.02], [0.56, 0.7, 0.335]);
  box(resources, root, metal, [0.29, 0.025, 0.2], [0.37, 0.97, -0.12]);
  box(resources, root, metal, [0.045, 0.22, 0.04], [0.37, 1.08, -0.17]);
  box(resources, root, resources.color(0x424b50), [0.72, 0.47, 0.065], [0.37, 1.34, -0.18]);
  const screen = resources.material(`screen:${slot.index}`, {
    color: 0xaec9c3, emissive: 0x79aaa2, emissiveIntensity: 0.15, roughness: 0.35,
  });
  box(resources, root, screen, [0.65, 0.39, 0.008], [0.37, 1.34, -0.143], false);
  for (let line = 0; line < 5; line++) {
    box(resources, root, resources.color(line % 2 ? 0x6f9298 : 0xe4f0dd),
      [0.2 + (line % 3) * 0.1, 0.017, 0.01], [0.3, 1.46 - line * 0.054, -0.134], false);
  }
  box(resources, root, resources.color(0xd1d5d0), [0.5, 0.027, 0.2], [0.02, 0.969, 0.2]);
  for (let row = 0; row < 3; row++) for (let column = 0; column < 6; column++) {
    box(resources, root, cream, [0.055, 0.009, 0.037], [-0.175 + column * 0.071, 0.987, 0.14 + row * 0.05], false);
  }
  const mouse = sphere(resources, root, cream, 0.055, 0.41, 0.978, 0.25);
  mouse.scale.set(0.75, 0.35, 1.15);
  mug(resources, root, -0.61, 1.015, -0.14);
  box(resources, root, resources.color(slot.index % 2 ? 0xd5aa86 : 0xb3c0a7), [0.23, 0.035, 0.3], [-0.57, 0.965, 0.19]);

  // A real chair with cushion, back, pedestal and casters.
  const seatX = -0.32, seatZ = 0.7;
  const fabric = resources.color(slot.index % 3 ? 0xbac3b9 : 0xd7b28f);
  box(resources, root, fabric, [0.6, 0.13, 0.56], [seatX, 0.53, seatZ]);
  box(resources, root, fabric, [0.59, 0.51, 0.11], [seatX, 0.85, seatZ + 0.28]);
  cylinder(resources, root, metal, 0.045, 0.06, 0.33, seatX, 0.29, seatZ);
  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI / 2;
    const spoke = box(resources, root, metal, [0.42, 0.035, 0.055], [seatX, 0.12, seatZ]);
    spoke.rotation.y = angle;
    sphere(resources, root, resources.color(0x687173), 0.065,
      seatX + Math.cos(angle) * 0.24, 0.075, seatZ + Math.sin(angle) * 0.24, 6);
  }
  return { root, slot, screen };
}

export interface OfficeWorld {
  root: THREE.Group;
  desks: OfficeDesk[];
  width: number;
  depth: number;
  sign: THREE.Vector3;
}

/** Batch opaque furniture by material; animated monitor materials stay independent. */
export function batchOfficeArchitecture(resources: OfficeResources, world: OfficeWorld) {
  const screens = new Set(world.desks.map((desk) => desk.screen));
  const groups = new Map<THREE.Material, THREE.Mesh<THREE.BufferGeometry, THREE.Material>[]>();
  world.root.updateMatrixWorld(true);
  world.root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || Array.isArray(node.material) || node.material.transparent || screens.has(node.material)) return;
    const group = groups.get(node.material) || [];
    group.push(node);
    groups.set(node.material, group);
  });
  for (const [material, meshes] of groups) {
    if (meshes.length < 2) continue;
    const merged = resources.geometry(`architecture:${material.uuid}`, () => {
      const parts = meshes.map((item) => (item.geometry.index ? item.geometry.toNonIndexed() : item.geometry.clone()).applyMatrix4(item.matrixWorld));
      try {
        const result = mergeGeometries(parts, false);
        if (!result) throw new Error('Unable to combine office furniture geometry.');
        return result;
      } finally { for (const part of parts) part.dispose(); }
    });
    for (const item of meshes) item.removeFromParent();
    const combined = mesh(world.root, merged, material, 0, 0, 0);
    combined.name = 'batched-office-furniture';
  }
}

export function createOfficeWorld(resources: OfficeResources, count: number): OfficeWorld {
  const layout = officeLayout(count);
  const { width, depth } = layout;
  const root = new THREE.Group();
  root.name = 'warm-isometric-office';
  const white = resources.color(0xf1eee7);
  const trim = resources.color(0xd8d8cb);
  const oak = resources.color(0xcab092);
  box(resources, root, resources.color(0xd5cabc), [width + 0.3, 0.3, depth + 0.3], [0, -0.21, 0]);
  box(resources, root, resources.color(0xe9e3d8), [width, 0.12, depth], [0, -0.035, 0]);
  for (let index = 1; index < Math.ceil(width / 0.65); index++) {
    box(resources, root, resources.color(0xdcd4c7), [0.012, 0.003, depth - 0.1], [-width / 2 + index * 0.65, 0.028, 0], false);
  }
  box(resources, root, white, [width, 2.8, 0.16], [0, 1.36, -depth / 2]);
  box(resources, root, white, [0.16, 2.8, depth], [-width / 2, 1.36, 0]);
  box(resources, root, trim, [width, 0.13, 0.065], [0, 0.07, -depth / 2 + 0.11]);
  box(resources, root, trim, [0.065, 0.13, depth], [-width / 2 + 0.11, 0.07, 0]);

  // Large windows and a floating open skylight, leaving the room visible.
  const glass = resources.material('glass', {
    color: 0xc3d9d6, transparent: true, opacity: 0.28, roughness: 0.12,
    metalness: 0.08, depthWrite: false, side: THREE.DoubleSide,
  });
  for (const x of [-width * 0.29, width * 0.26]) {
    box(resources, root, resources.color(0xe1d9c9), [2.85, 1.42, 0.09], [x, 1.87, -depth / 2 + 0.11]);
    box(resources, root, glass, [2.64, 1.24, 0.035], [x, 1.87, -depth / 2 + 0.17], false);
    box(resources, root, white, [0.055, 1.24, 0.055], [x, 1.87, -depth / 2 + 0.2], false);
    box(resources, root, white, [2.64, 0.055, 0.055], [x, 1.87, -depth / 2 + 0.2], false);
  }
  const skyZ = -depth / 2 + 1.7;
  box(resources, root, glass, [4.4, 0.025, 2.7], [0.2, 3.22, skyZ], false);
  for (const x of [-2.05, 2.45]) box(resources, root, trim, [0.075, 0.075, 2.8], [x, 3.22, skyZ]);
  for (const z of [skyZ - 1.39, skyZ + 1.39]) box(resources, root, trim, [4.58, 0.075, 0.075], [0.2, 3.22, z]);
  box(resources, root, trim, [0.055, 0.055, 2.8], [0.2, 3.22, skyZ]);

  // The carpet keeps desks visually grouped without using an image texture.
  box(resources, root, resources.color(0xd6cbbb), [width - 2.3, 0.015, Math.max(5.9, depth - 3.7)], [0.12, 0.042, 0.68]);
  box(resources, root, resources.color(0xdfc8ab), [2.4, 0.022, 0.7], [0.9, 0.049, depth / 2 - 0.63]);

  // Coffee cabinet, espresso machine, shelves, cups and stools.
  const coffeeX = -width / 2 + 2.05, coffeeZ = -depth / 2 + 0.75;
  box(resources, root, resources.color(0xd8c3a4), [2.8, 0.78, 0.64], [coffeeX, 0.44, coffeeZ]);
  box(resources, root, oak, [2.98, 0.085, 0.76], [coffeeX, 0.87, coffeeZ]);
  for (const x of [-0.88, 0, 0.88]) {
    box(resources, root, resources.color(0xc9b395), [0.015, 0.64, 0.014], [coffeeX + x + 0.43, 0.44, coffeeZ + 0.327], false);
    box(resources, root, resources.color(0x7f7567), [0.2, 0.024, 0.023], [coffeeX + x, 0.66, coffeeZ + 0.336]);
  }
  box(resources, root, resources.color(0x59645d), [0.47, 0.45, 0.4], [coffeeX - 0.68, 1.14, coffeeZ]);
  box(resources, root, resources.color(0xa7aaa0), [0.39, 0.06, 0.24], [coffeeX - 0.68, 0.97, coffeeZ + 0.2]);
  box(resources, root, resources.color(0x232c29), [0.16, 0.17, 0.025], [coffeeX - 0.68, 1.15, coffeeZ + 0.208]);
  mug(resources, root, coffeeX - 0.68, 1.07, coffeeZ + 0.18);
  mug(resources, root, coffeeX + 0.45, 0.99, coffeeZ + 0.09);
  mug(resources, root, coffeeX + 0.76, 0.99, coffeeZ - 0.06);
  box(resources, root, oak, [2.8, 0.07, 0.3], [coffeeX, 2.48, -depth / 2 + 0.3]);
  for (let index = 0; index < 5; index++) {
    box(resources, root, resources.color([0xaab7a2, 0xc38e75, 0xd8c8ac][index % 3]),
      [0.1, 0.26 + (index % 2) * 0.06, 0.17], [coffeeX - 0.8 + index * 0.13, 2.66, -depth / 2 + 0.32]);
  }
  for (const x of [coffeeX - 0.35, coffeeX + 0.6]) {
    cylinder(resources, root, oak, 0.23, 0.23, 0.08, x, 0.61, coffeeZ + 1.02);
    cylinder(resources, root, trim, 0.04, 0.07, 0.52, x, 0.31, coffeeZ + 1.02);
    cylinder(resources, root, trim, 0.19, 0.19, 0.045, x, 0.055, coffeeZ + 1.02);
  }

  // Glass meeting nook with a warm sofa on the back right.
  const loungeX = width / 2 - 2.1;
  box(resources, root, resources.color(0xc7aa89), [2.45, 0.4, 0.83], [loungeX, 0.32, coffeeZ + 0.15]);
  box(resources, root, resources.color(0xd9c1a2), [2.44, 0.6, 0.18], [loungeX, 0.69, coffeeZ - 0.17]);
  for (const x of [-0.68, 0.22, 0.78]) {
    const pillow = box(resources, root, resources.color(x < 0 ? 0xe8d9bd : 0xa5b5a3), [0.48, 0.38, 0.15], [loungeX + x, 0.7, coffeeZ + 0.06]);
    pillow.rotation.z = x * 0.12;
  }
  const partitionX = width / 2 - 0.58;
  box(resources, root, glass, [0.035, 2.02, 2.3], [partitionX, 1.04, coffeeZ + 0.6], false);
  for (const z of [coffeeZ - 0.6, coffeeZ + 1.8]) box(resources, root, trim, [0.05, 2.13, 0.055], [partitionX, 1.08, z]);
  box(resources, root, trim, [0.05, 0.05, 2.45], [partitionX, 2.13, coffeeZ + 0.6]);

  // Door and architectural nameplate; its lettering is projected HTML.
  box(resources, root, oak, [0.055, 2.1, 1.08], [-width / 2 + 0.12, 1.08, 1.8]);
  box(resources, root, glass, [0.018, 1.04, 0.62], [-width / 2 + 0.158, 1.35, 1.8], false);
  cylinder(resources, root, resources.color(0x807b70), 0.04, 0.04, 0.15, -width / 2 + 0.23, 0.91, 2.12).rotation.z = Math.PI / 2;
  box(resources, root, resources.color(0x687a70), [0.045, 0.25, 0.86], [-width / 2 + 0.14, 2.39, 1.8]);
  plant(resources, root, -width / 2 + 0.79, depth / 2 - 1.0, 1.06);
  plant(resources, root, width / 2 - 0.75, depth / 2 - 0.92, 0.87);
  plant(resources, root, width / 2 - 0.8, -depth / 2 + 0.61, 0.8);
  const desks = layout.slots.map((slot) => desk(resources, root, slot));
  return { root, desks, width, depth, sign: new THREE.Vector3(-width / 2 + 0.22, 2.4, 1.8) };
}

export interface OfficeAvatar {
  root: THREE.Group;
  head: THREE.Group;
  leftPaw: THREE.Group;
  rightPaw: THREE.Group;
  halo: THREE.Mesh;
  beacon: THREE.Mesh;
  selection: THREE.Mesh;
  statusMaterial: THREE.MeshStandardMaterial;
  screen: THREE.MeshStandardMaterial;
  label: THREE.Vector3;
  phase: number;
}

export function createOfficeAvatar(resources: OfficeResources, desk: OfficeDesk, id: string): OfficeAvatar {
  const root = new THREE.Group();
  root.name = `agent:${id}`;
  root.userData.agentId = id;
  root.position.set(desk.slot.x - 0.32, 0.61, desk.slot.z + 0.56);
  const fur = resources.material('cat-fur', { color: 0x293333, flatShading: true, roughness: 0.93 });
  const cream = resources.color(0xf3eddd);
  const capsule = resources.geometry('cat-body', () => new THREE.CapsuleGeometry(0.22, 0.35, 3, 8));
  mesh(root, capsule, fur, 0, 0.32, 0);
  const head = new THREE.Group();
  head.position.set(0, 0.77, 0.035);
  head.rotation.y = -0.16;
  root.add(head);
  sphere(resources, head, fur, 0.285, 0, 0, 0, 9).scale.set(1, 0.95, 0.9);
  for (const x of [-0.19, 0.19]) {
    const ear = mesh(head, resources.geometry('cat-ear', () => new THREE.ConeGeometry(0.125, 0.24, 3)), fur, x, 0.22, 0);
    ear.rotation.z = -x * 0.65;
    sphere(resources, head, cream, 0.048, x * 0.56, 0.018, 0.232, 8).scale.set(0.68, 1.12, 0.36);
    sphere(resources, head, resources.color(0xd3a59a), 0.027, x * 0.87, -0.075, 0.212, 6).scale.set(1.2, 0.45, 0.4);
  }
  sphere(resources, head, resources.color(0xb9c7b8), 0.025, 0, -0.068, 0.25, 5);
  const pawGeometry = resources.geometry('cat-paw', () => new THREE.CapsuleGeometry(0.074, 0.18, 2, 6));
  const paws = [-0.21, 0.21].map((x) => {
    const paw = new THREE.Group();
    paw.position.set(x, 0.42, 0.07);
    mesh(paw, pawGeometry, fur, 0, -0.055, -0.1).rotation.x = -0.55;
    root.add(paw);
    return paw;
  });
  const tail = mesh(root, resources.geometry('cat-tail', () => new THREE.TorusGeometry(0.18, 0.044, 5, 9, Math.PI * 1.3)),
    fur, 0.23, 0.1, -0.1);
  tail.rotation.y = -0.4;
  const statusMaterial = resources.material(`status:${desk.slot.index}`, { color: 0x99a2aa, emissive: 0x99a2aa, emissiveIntensity: 0.24 });
  const halo = mesh(root, resources.geometry('thinking-ring', () => new THREE.TorusGeometry(0.19, 0.015, 5, 20, Math.PI * 1.65)),
    statusMaterial, 0, 1.25, 0);
  halo.rotation.x = Math.PI / 2;
  const beacon = sphere(resources, root, statusMaterial, 0.055, 0.28, 1.07, 0.04, 8);
  const selection = mesh(root, resources.geometry('selected-ring', () => new THREE.TorusGeometry(0.42, 0.022, 5, 28)),
    resources.color(0x619a84), 0, -0.55, 0.08);
  selection.rotation.x = -Math.PI / 2;
  selection.visible = false;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return {
    root, head, leftPaw: paws[0], rightPaw: paws[1], halo, beacon, selection,
    statusMaterial, screen: desk.screen,
    label: new THREE.Vector3(root.position.x, 2.05, root.position.z), phase: (hash % 1000) / 100,
  };
}

export function poseOfficeAvatar(avatar: OfficeAvatar, state: AgentState, time: number, selected: boolean) {
  const color = OFFICE_STATE_COLORS[state];
  avatar.statusMaterial.color.setHex(color);
  avatar.statusMaterial.emissive.setHex(color);
  avatar.screen.color.setHex(state === 'error' ? 0xd9a59d : state === 'waiting' || state === 'stopped' || state === 'unknown' ? 0xb8c3bd : 0xb4d1c6);
  avatar.screen.emissiveIntensity = state === 'working' ? 0.46 : state === 'thinking' ? 0.29 : 0.08;
  const phase = time + avatar.phase;
  avatar.head.rotation.y = -0.16 + (state === 'thinking' ? Math.sin(phase * 1.2) * 0.17 : 0);
  avatar.head.rotation.z = state === 'thinking' ? Math.sin(phase) * 0.07 : 0;
  avatar.head.position.y = 0.77 + (state === 'working' ? Math.sin(phase * 2) * 0.012 : 0);
  avatar.leftPaw.rotation.x = state === 'working' ? -0.2 + Math.sin(phase * 9) * 0.17 : 0;
  avatar.rightPaw.rotation.x = state === 'working' ? -0.2 + Math.sin(phase * 9 + Math.PI) * 0.17 : 0;
  avatar.rightPaw.rotation.z = state === 'done' ? -1.9 + Math.sin(phase * 3.2) * 0.18 : 0;
  avatar.halo.visible = state === 'thinking';
  avatar.halo.rotation.z = phase * 0.65;
  avatar.beacon.scale.setScalar(state === 'error' ? 1 + Math.sin(phase * 3) * 0.13 : 1);
  avatar.selection.visible = selected;
}
