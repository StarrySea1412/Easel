import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { OfficeAgent } from '../../lib/agentOffice';
import { applyOfficeAvatarMotion } from './officeAvatarMotion';

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
  box(resources, root, resources.color(0x424b50), [0.98, 0.67, 0.065], [0.45, 1.42, -0.18]);
  const screen = resources.material(`screen:${slot.index}`, {
    color: 0xaec9c3, emissive: 0x79aaa2, emissiveIntensity: 0.15, roughness: 0.35,
  });
  const display = mesh(root, resources.geometry('office-screen-plane', () => new THREE.PlaneGeometry(0.92, 0.61)), screen, 0.45, 1.42, -0.143);
  display.castShadow = false;
  display.name = 'office-work-screen';
  box(resources, root, resources.color(0xd1d5d0), [0.5, 0.027, 0.2], [0.02, 0.969, 0.2]);
  for (let row = 0; row < 3; row++) for (let column = 0; column < 6; column++) {
    box(resources, root, cream, [0.055, 0.009, 0.037], [-0.175 + column * 0.071, 0.987, 0.14 + row * 0.05], false);
  }
  const mouse = sphere(resources, root, cream, 0.055, 0.41, 0.978, 0.25);
  mouse.scale.set(0.75, 0.35, 1.15);
  mug(resources, root, -0.61, 1.015, -0.14);
  box(resources, root, resources.color(slot.index % 2 ? 0xd5aa86 : 0xb3c0a7), [0.23, 0.035, 0.3], [-0.57, 0.965, 0.19]);

  // A real chair with cushion, back, pedestal and casters.
  const seatX = -0.10, seatZ = 0.7;
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
  body: THREE.Group;
  head: THREE.Group;
  leftElbow: THREE.Group;
  rightElbow: THREE.Group;
  leftWrist: THREE.Group;
  rightWrist: THREE.Group;
  ears: THREE.Group[];
  eyes: THREE.Group;
  tail: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  document: THREE.Group;
  tablet: THREE.Group;
  pen: THREE.Mesh;
  beacon: THREE.Mesh;
  selection: THREE.Mesh;
  statusMaterial: THREE.MeshStandardMaterial;
  screen: THREE.MeshStandardMaterial;
  label: THREE.Vector3;
  phase: number;
}

export function createOfficeAvatar(resources: OfficeResources, desk: OfficeDesk, id: string, appearance?: OfficeAgent['appearance']): OfficeAvatar {
  const root = new THREE.Group();
  root.name = `employee:${id}`;
  root.userData.agentId = id;
  root.position.set(desk.slot.x - 0.10, 0.61, desk.slot.z + 0.56);
  const species = appearance?.species || 'cat';
  root.userData.species = species;
  // Saved skin/hair keys stay compatible, but now color animal fur and markings.
  const fur = resources.material(`fur:${appearance?.skinColor}`, { color: appearance?.skinColor || '#D9C5A6' });
  const shirt = resources.material(`shirt:${appearance?.shirtColor}`, { color: appearance?.shirtColor || '#8E9B9D' });
  const markings = resources.material(`markings:${appearance?.hairColor}`, { color: appearance?.hairColor || '#806B58' });
  const cream = resources.color(0xfff4df), ink = resources.color(0x363b3a);
  const body = new THREE.Group(); body.name = 'employee-body'; root.add(body);
  const torso = sphere(resources, body, shirt, 0.25, 0, 0.26, 0, 16);
  torso.scale.set(0.96, 1.04, 0.76); torso.name = 'employee-shirt';
  for (const x of [-0.067, 0.067]) {
    const collar = box(resources, body, cream, [0.11, 0.075, 0.035], [x, 0.46, -0.15]);
    collar.rotation.z = x < 0 ? -0.32 : 0.32;
  }
  box(resources, body, cream, [0.067, 0.087, 0.012], [0.11, 0.31, -0.187]);
  box(resources, body, markings, [0.042, 0.015, 0.014], [0.11, 0.329, -0.197], false);
  const head = new THREE.Group(); head.name = 'employee-head'; head.position.set(0, 0.79, 0);
  head.userData.species = species;
  body.add(head);
  const face = sphere(resources, head, fur, 0.305, 0, 0, 0, 20);
  face.name = 'animal-face'; face.scale.set(1.04, 1, 0.92);
  const ears: THREE.Group[] = [];
  for (const x of [-0.2, 0.2]) {
    const ear = new THREE.Group(); ear.name = x < 0 ? 'animal-ear-left' : 'animal-ear-right';
    ear.position.set(x, 0.22, 0); head.add(ear); ears.push(ear);
    if (species === 'rabbit') {
      const outer = sphere(resources, ear, fur, 0.11, 0, 0.18, 0, 16); outer.scale.set(0.85, 2.6, 0.74);
      const inner = sphere(resources, ear, markings, 0.069, 0, 0.2, -0.069, 12); inner.scale.set(0.78, 3.1, 0.23);
      ear.rotation.z = x < 0 ? 0.14 : -0.14;
    } else if (species === 'bear') {
      sphere(resources, ear, fur, 0.13, 0, 0.025, 0, 16);
      sphere(resources, ear, markings, 0.076, 0, 0.025, -0.09, 12).scale.z = 0.3;
    } else {
      const geometry = resources.geometry('rounded-animal-ear', () => {
        const shape = new THREE.Shape(); shape.moveTo(-0.115, 0); shape.lineTo(0, 0.26); shape.lineTo(0.115, 0); shape.closePath();
        return new THREE.ExtrudeGeometry(shape, { depth: 0.085, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.025, bevelThickness: 0.025 });
      });
      mesh(ear, geometry, species === 'fox' ? markings : fur, 0, 0, -0.04);
      const inset = mesh(ear, geometry, species === 'fox' ? fur : markings, 0, 0.025, -0.063);
      inset.scale.set(0.55, 0.65, 0.3);
      ear.rotation.z = x < 0 ? 0.15 : -0.15;
    }
  }
  const muzzle = new THREE.Group(); muzzle.name = 'animal-muzzle'; head.add(muzzle);
  for (const x of [-0.064, 0.064]) {
    const cheek = sphere(resources, muzzle, cream, species === 'fox' ? 0.115 : 0.094, x, -0.072, -0.249, 16);
    cheek.scale.set(1.08, 0.82, species === 'fox' ? 1.18 : 0.88);
  }
  const nose = sphere(resources, muzzle, ink, 0.03, 0, -0.057, species === 'fox' ? -0.371 : -0.337, 12);
  nose.name = 'animal-nose'; nose.scale.set(1.2, 0.75, 0.7);
  const eyes = new THREE.Group(); eyes.name = 'animal-eyes'; eyes.position.y = 0.033; head.add(eyes);
  for (const x of [-0.116, 0.116]) {
    sphere(resources, eyes, ink, 0.032, x, 0, -0.265, 12).scale.set(0.78, 1.07, 0.56);
    sphere(resources, eyes, cream, 0.009, x - 0.008, 0.012, -0.282, 8);
  }
  for (const x of [-0.212, 0.212]) {
    sphere(resources, head, resources.color(0xdba69a), 0.045, x, -0.073, -0.212, 12).scale.set(1, 0.48, 0.25);
  }
  if (species === 'cat') {
    for (const x of [-0.065, 0, 0.065]) {
      const stripe = box(resources, head, markings, [0.028, 0.095, 0.018], [x, 0.18, -0.236]);
      stripe.rotation.x = -0.3;
    }
    for (const direction of [-1, 1]) for (const offset of [-1, 1]) {
      const whisker = box(resources, head, markings, [0.13, 0.008, 0.008], [direction * 0.26, -0.083 + offset * 0.029, -0.216], false);
      whisker.rotation.z = direction * offset * 0.16;
    }
  }
  if (appearance?.accessory === 'glasses') {
    for (const x of [-0.119, 0.119]) mesh(head, resources.geometry('animal-glasses', () => new THREE.TorusGeometry(0.075, 0.012, 6, 18)), ink, x, 0.027, -0.278);
    box(resources, head, ink, [0.084, 0.015, 0.012], [0, 0.03, -0.288], false);
  }
  if (appearance?.accessory === 'headset') {
    for (const x of [-0.302, 0.302]) box(resources, head, ink, [0.052, 0.15, 0.12], [x, 0.015, 0]);
    const band = mesh(head, resources.geometry('animal-headset-band', () => new THREE.TorusGeometry(0.32, 0.018, 6, 22, Math.PI)), ink, 0, 0.015, 0.04);
    box(resources, head, ink, [0.015, 0.015, 0.24], [-0.305, -0.06, -0.1], false);
    band.name = 'animal-headset';
  }
  const tail = new THREE.Group(); tail.name = 'animal-tail'; tail.position.set(0.16, 0.02, 0.14); root.add(tail);
  if (species === 'cat') {
    for (let n = 0; n < 9; n++) {
      const angle = n / 8 * Math.PI * 1.2;
      sphere(resources, tail, n > 6 ? markings : fur, 0.056 - n * 0.0014, Math.sin(angle) * 0.22, (1 - Math.cos(angle)) * 0.13, 0.06 + n * 0.014, 12);
    }
  } else if (species === 'fox') {
    const brush = sphere(resources, tail, fur, 0.17, 0.17, 0.08, 0.09, 16); brush.scale.set(1.8, 0.9, 0.9); brush.rotation.z = 0.45;
    sphere(resources, tail, cream, 0.11, 0.38, 0.18, 0.09, 14).scale.set(1.2, 0.9, 0.85);
  } else sphere(resources, tail, species === 'rabbit' ? cream : fur, 0.12, 0.06, 0.06, 0.11, 16);
  // The upper arm, forearm and paw form a real shoulder → elbow → wrist chain.
  // Both limb lengths are fixed; the motion solver rotates joints to reach desk contacts.
  const arms = [-0.245, 0.245].map(x => {
    const side = x < 0 ? 'left' : 'right';
    const arm = new THREE.Group(); arm.name = `${side}-arm`;
    arm.position.set(x, 0.44, 0); body.add(arm);
    const sleeve = sphere(resources, arm, shirt, 0.1, 0, 0, -0.11, 14);
    sleeve.scale.set(0.9, 0.9, 1.3);
    const elbow = new THREE.Group(); elbow.name = `${side}-elbow`; elbow.position.z = -0.25; arm.add(elbow);
    sphere(resources, elbow, fur, 0.075, 0, 0, 0, 12);
    const forearm = sphere(resources, elbow, fur, 0.075, 0, 0, -0.125, 14); forearm.scale.set(0.83, 0.83, 1.75);
    const wrist = new THREE.Group(); wrist.name = `${side}-wrist`; wrist.position.z = -0.27; elbow.add(wrist);
    const paw = sphere(resources, wrist, fur, 0.079, 0, 0, 0, 16);
    paw.name = `animal-paw-${side}`; paw.scale.set(1, 0.65, 1.08);
    for (const offset of [-0.029, 0.029]) box(resources, wrist, markings, [0.006, 0.006, 0.034], [offset, 0.045, -0.04], false);
    return { arm, elbow, wrist };
  });
  for (const x of [-0.115, 0.115]) {
    sphere(resources, root, resources.color(0x687779), 0.125, x, -0.085, -0.11, 14).scale.set(0.9, 1.05, 1.6);
    sphere(resources, root, fur, 0.107, x, -0.29, -0.255, 14).scale.set(1.05, 0.88, 1.5);
  }
  // Raised, camera-facing surfaces and large geometric marks make the tool legible at desk scale.
  const document = new THREE.Group(); document.name = 'reading-document'; root.add(document);
  document.position.set(0.01, 0.54, -0.36); document.rotation.x = -0.8;
  box(resources, document, resources.color(0xc8ab7e), [0.59, 0.43, 0.03], [0, 0, 0]);
  box(resources, document, cream, [0.54, 0.38, 0.012], [0, 0, 0.023]);
  box(resources, document, resources.color(0x648fa1), [0.25, 0.026, 0.008], [-0.075, 0.137, 0.035], false);
  for (let n = 0; n < 4; n++) box(resources, document, resources.color(0x8d9a9e), [0.38 - n % 2 * 0.09, 0.018, 0.008], [-0.015, 0.07 - n * 0.06, 0.035], false);
  const tablet = new THREE.Group(); tablet.name = 'design-tablet'; root.add(tablet);
  tablet.position.set(0.09, 0.45, -0.39); tablet.rotation.x = -Math.PI / 2 + 0.34;
  box(resources, tablet, ink, [0.64, 0.42, 0.033], [0, 0, 0]);
  box(resources, tablet, resources.color(0xd4e7df), [0.57, 0.35, 0.01], [0, 0, 0.024]);
  box(resources, tablet, resources.color(0x8cae9a), [0.18, 0.3, 0.009], [-0.17, 0, 0.035]);
  sphere(resources, tablet, resources.color(0xe5b577), 0.065, 0.03, 0.08, 0.046, 12).scale.z = 0.1;
  box(resources, tablet, resources.color(0xb08079), [0.2, 0.11, 0.012], [0.105, -0.09, 0.043]);
  const pen = cylinder(resources, arms[1].wrist, ink, 0.013, 0.013, 0.22, 0.034, 0.06, 0, 8);
  pen.name = 'drawing-stylus';
  const statusMaterial = resources.material(`status:${desk.slot.index}`, { color: 0x99a2aa, emissive: 0x99a2aa, emissiveIntensity: 0.24 });
  const beacon = sphere(resources, root, statusMaterial, 0.055, 0.28, 1.07, 0.04, 8);
  const selection = mesh(root, resources.geometry('selected-ring', () => new THREE.TorusGeometry(0.42, 0.022, 5, 28)),
    resources.color(0x619a84), 0, -0.55, 0.08);
  selection.rotation.x = -Math.PI / 2; selection.visible = false;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  document.visible = tablet.visible = pen.visible = false;
  return { root, body, head, ears, eyes, tail, leftArm: arms[0].arm, rightArm: arms[1].arm,
    leftElbow: arms[0].elbow, rightElbow: arms[1].elbow, leftWrist: arms[0].wrist, rightWrist: arms[1].wrist, document, tablet, pen, beacon, selection,
    statusMaterial, screen: desk.screen, label: new THREE.Vector3(root.position.x, species === 'rabbit' ? 2.18 : 2.04, root.position.z), phase: (hash % 1000) / 100 };
}

export function poseOfficeAvatar(avatar: OfficeAvatar, state: AgentState, time: number, selected: boolean, action: NonNullable<OfficeAgent['action']>['kind'] = 'unreported') {
  const color = OFFICE_STATE_COLORS[state];
  avatar.statusMaterial.color.setHex(color); avatar.statusMaterial.emissive.setHex(color);
  avatar.screen.color.setHex(avatar.screen.map ? 0xffffff : state === 'error' ? 0xd9a59d : ['waiting', 'stopped', 'unknown'].includes(state) ? 0xb8c3bd : 0xb4d1c6);
  avatar.screen.emissiveIntensity = avatar.screen.map ? 0.08 : state === 'working' ? 0.46 : state === 'thinking' ? 0.29 : 0.08;
  applyOfficeAvatarMotion(avatar, state, time, action);
  avatar.beacon.scale.setScalar(1);
  avatar.selection.visible = selected;
}
