import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { OfficeAgent } from '../../lib/agentOffice';
import { applyOfficeAvatarMotion, type OfficeMotionBlend } from './officeAvatarMotion';
import { createOfficePenGeometry, OFFICE_PEN_DOCK } from './officePen';
import { createOfficeBodySkin, type OfficeBodySkin } from './officeBodySkin';
import { createOfficeHand, type OfficeHandRig } from './officeHands';
import { characterFaceSurface, createCharacterHeadGeometry, createCharacterLegGeometry } from './officeCharacterForms';

type AgentState = OfficeAgent['state'];

export const OFFICE_STATE_COLORS: Record<AgentState, number> = {
  working: 0x5da8a2, thinking: 0xd0a251, waiting: 0x99a2aa, stopped: 0x899397,
  done: 0x67a877, error: 0xd66d64, unknown: 0x9099a7,
};

/** Geometry and materials are shared within one renderer and disposed once. */
export class OfficeResources {
  private geometries = new Map<string, THREE.BufferGeometry>();
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private disposables = new Set<{ dispose(): void }>();
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

  ownDisposable<T extends { dispose(): void }>(value: T): T { this.disposables.add(value); return value; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const value of this.disposables) value.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.disposables.clear();
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
    () => new THREE.SphereGeometry(radius, segments, Math.max(7, Math.floor(segments * .65)))), material, x, y, z);
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
  workstationRole: OfficeWorkstationRole;
}

export const OFFICE_WORKSTATION_ROLES = ['coordinator', 'researcher', 'designer', 'writer', 'tester', 'reviewer', 'generic'] as const;
export type OfficeWorkstationRole = typeof OFFICE_WORKSTATION_ROLES[number];

/** An assigned employee card is stable even when display names/tasks are edited. */
export function officeWorkstationRole(agent?: Pick<OfficeAgent, 'id' | 'role' | 'appearance'>): OfficeWorkstationRole {
  const known = (value: unknown): value is OfficeWorkstationRole => typeof value === 'string' && OFFICE_WORKSTATION_ROLES.includes(value as OfficeWorkstationRole);
  if (!agent) return 'generic';
  if (known(agent.appearance?.id) && agent.appearance.id !== 'generic') return agent.appearance.id;
  if (known(agent.id)) return agent.id;
  const role = `${agent.appearance?.role || ''} ${agent.role}`.toLowerCase();
  if (/协调|统筹|coordinat|\broot\b/.test(role)) return 'coordinator';
  if (/研究|资料|research/.test(role)) return 'researcher';
  if (/设计|视觉|design/.test(role)) return 'designer';
  if (/文案|写作|创作|writ/.test(role)) return 'writer';
  if (/检查|测试|质量|test|\bqa\b/.test(role)) return 'tester';
  if (/审阅|评审|review/.test(role)) return 'reviewer';
  return 'generic';
}

/** State, name, task and palette edits do not invalidate batched architecture. */
export function officeWorkstationLayoutKey(agents: readonly OfficeAgent[]) {
  const layout = officeLayout(agents.length);
  return `${layout.key}:${layout.slots.map((slot) => officeWorkstationRole(agents[slot.index])).join(',')}`;
}

function desk(resources: OfficeResources, parent: THREE.Object3D, slot: DeskSlot, workstationRole: OfficeWorkstationRole): OfficeDesk {
  const root = new THREE.Group();
  root.name = `desk-${slot.index + 1}`;
  root.position.set(slot.x, 0, slot.z);
  // Rotate the complete station, including its actor, toward the open room.
  // Local contact coordinates stay unchanged for keyboard/mouse/held surfaces.
  root.rotation.y = Math.PI;
  root.userData.workstationRole = workstationRole;
  parent.add(root);
  const cream = resources.color(0xf5f0e6);
  const wood = resources.color(0xccb69a);
  const metal = resources.color(0xbac1c1);
  const ink = resources.color(0x424b50), paper = resources.color(0xfff8e8), muted = resources.color(0x8a9d91);
  const tops: Record<OfficeWorkstationRole, [number, number, number]> = {
    coordinator: [1.92, 0.09, 0.96], researcher: [1.72, 0.11, 1.02], designer: [1.94, 0.075, 1.04],
    writer: [1.84, 0.09, 0.92], tester: [1.96, 0.07, 0.96], reviewer: [1.92, 0.09, 1.08], generic: [1.76, 0.09, 0.88],
  };
  const top = tops[workstationRole];
  box(resources, root, wood, top, [0, 0.88, 0]).name = `worktop-${workstationRole}`;
  box(resources, root, workstationRole === 'writer' || workstationRole === 'researcher' ? wood : cream,
    [top[0] - 0.012, 0.035, top[2] - 0.012], [0, 0.935, 0]);
  if (workstationRole === 'designer') {
    for (const x of [-0.73, 0.73]) {
      box(resources, root, wood, [0.08, 0.81, 0.7], [x, 0.43, 0]).rotation.z = x < 0 ? -0.09 : 0.09;
      box(resources, root, metal, [0.4, 0.065, 0.74], [x, 0.06, 0]);
    }
  } else {
    for (const x of [-0.72, 0.72]) for (const z of [-0.32, 0.32]) {
      cylinder(resources, root, workstationRole === 'tester' ? metal : wood, 0.038, 0.053, 0.83, x, 0.43, z, 8);
    }
  }
  if (workstationRole === 'writer' || workstationRole === 'reviewer' || workstationRole === 'generic') {
    box(resources, root, resources.color(0xd4cbbc), [0.34, 0.35, 0.65], [0.56, 0.66, 0]);
    box(resources, root, resources.color(0xa99d8b), [0.12, 0.02, 0.02], [0.56, 0.7, 0.335]);
  }

  // Keep the observed work texture independent from static furniture batching.
  // A side-facing monitor lets the three-quarter camera see its surface and face.
  const sizes: Record<OfficeWorkstationRole, [number, number]> = {
    coordinator: [.74, .53], researcher: [.58, .79], designer: [.77, .53], writer: [.83, .50],
    tester: [.69, .55], reviewer: [.73, .56], generic: [.78, .55],
  };
  const [screenWidth, screenHeight] = sizes[workstationRole];
  const monitor = new THREE.Group(); monitor.name = `monitor-${workstationRole}`; monitor.position.set(.45, 1.42, -.18); monitor.rotation.y = -.94; root.add(monitor);
  box(resources, root, metal, [0.29, 0.025, 0.2], [0.37, 0.97, -0.12]);
  box(resources, root, metal, [0.045, 0.22, 0.04], [0.37, 1.08, -0.17]);
  box(resources, monitor, ink, [screenWidth, screenHeight, .05], [0, 0, 0]);
  const screen = resources.material(`screen:${slot.index}`, {
    color: 0xaec9c3, emissive: 0x79aaa2, emissiveIntensity: 0.15, roughness: 0.35,
  });
  const display = mesh(root, resources.geometry(`office-screen-plane:${workstationRole}`, () => new THREE.PlaneGeometry(screenWidth - .032, screenHeight - .032)), screen,
    .45 + Math.sin(-.94) * .027, 1.42, -.18 + Math.cos(-.94) * .027);
  display.rotation.y = -.94;
  display.castShadow = false;
  display.name = 'office-work-screen';
  const inputBase = box(resources, root, workstationRole === 'designer' ? ink : resources.color(0xd1d5d0), [0.5, 0.027, 0.2], [0.02, 0.969, 0.2]);
  inputBase.name = workstationRole === 'designer' ? 'tablet-shortcut-console' : 'office-keyboard';
  for (let row = 0; row < 3; row++) for (let column = 0; column < 6; column++) {
    box(resources, root, workstationRole === 'designer' && column > 3 ? muted : cream, [0.055, 0.009, 0.037], [-0.175 + column * 0.071, 0.987, 0.14 + row * 0.05], false);
  }
  const mouse = sphere(resources, root, cream, 0.055, 0.41, 0.978, 0.25);
  mouse.name = 'office-mouse'; mouse.scale.set(0.75, 0.35, 1.15);

  const feature = (name: string) => { const group = new THREE.Group(); group.name = name; root.add(group); return group; };
  const sheet = (parent: THREE.Object3D, x: number, y: number, z: number, w = .31, d = .27) => {
    box(resources, parent, paper, [w, .006, d], [x, y, z], false);
    for (let line = 0; line < 4; line++) box(resources, parent, resources.color(0xaab0a8), [w * (line % 2 ? .60 : .76), .003, .007], [x, y + .005, z - d * .31 + line * d * .17], false);
  };
  if (workstationRole === 'coordinator') {
    const board = feature('coordination-planning-board');
    box(resources, board, wood, [.53, .53, .035], [-.57, 1.30, -.21]);
    box(resources, board, cream, [.48, .48, .008], [-.57, 1.30, -.186]);
    for (let column = 0; column < 3; column++) {
      box(resources, board, muted, [.10, .035, .007], [-.72 + column * .15, 1.49, -.177], false);
      for (let row = 0; row < 2; row++) box(resources, board, resources.color(row ? 0xdac49e : 0xb6c9bf), [.11, .095, .009], [-.72 + column * .15, 1.39 - row * .14, -.174]);
    }
    const wing = feature('coordination-side-wing');
    box(resources, wing, wood, [.39, .06, .72], [-.80, .96, .18]);
    box(resources, wing, metal, [.045, .92, .045], [-.92, .47, .42]);
    sheet(wing, -.79, 1.001, .21, .26, .29);
  } else if (workstationRole === 'researcher') {
    const rack = feature('research-reference-library');
    box(resources, rack, wood, [.51, .045, .33], [-.58, 1.06, -.29]);
    for (let i = 0; i < 5; i++) {
      box(resources, rack, resources.color([0x8ea5b4, 0xb6c4a9, 0xc9ad84][i % 3]), [.065, .29 + (i % 2) * .07, .23], [-.77 + i * .081, 1.22 + (i % 2) * .035, -.29]);
      box(resources, rack, cream, [.043, .015, .003], [-.77 + i * .081, 1.19, -.173], false);
    }
    const book = feature('research-open-reference'); book.position.set(-.56, .992, .17); book.rotation.x = -.13;
    for (const side of [-1, 1]) {
      const page = new THREE.Group(); page.position.x = side * .111; page.rotation.z = side * .10; book.add(page);
      box(resources, page, wood, [.226, .028, .29], [0, 0, 0]); sheet(page, 0, .02, 0, .215, .278);
    }
  } else if (workstationRole === 'designer') {
    const board = feature('design-display-dock');
    box(resources, board, ink, [.66, .025, .30], [-.03, .966, -.045]);
    box(resources, board, resources.color(0xaec4b8), [.59, .008, .245], [-.03, .985, -.045]);
    const swatches = feature('design-colour-swatches');
    for (let i = 0; i < 5; i++) {
      const card = box(resources, swatches, resources.color([0x52796b, 0x97b7a0, 0xe4cbaa, 0xc99171, 0x9288a0][i]), [.10, .008, .19], [-.68 + i * .035, .967 + i * .01, .23]);
      card.rotation.y = -.23 + i * .12;
    }
    const samples = feature('design-sample-rail');
    box(resources, samples, wood, [.53, .038, .085], [-.59, .98, -.32]);
    for (const x of [-.73, -.46]) {
      box(resources, samples, paper, [.22, .31, .02], [x, 1.15, -.33]).rotation.x = -.10;
      box(resources, samples, muted, [.15, .19, .013], [x, 1.17, -.313]).rotation.x = -.10;
    }
  } else if (workstationRole === 'writer') {
    const draft = feature('writing-manuscript-stack');
    for (let i = 0; i < 4; i++) sheet(draft, -.59 + i * .012, .96 + i * .009, .07 - i * .005, .40, .40);
    const pens = feature('writing-pen-cup');
    cylinder(resources, pens, resources.color(0xc49c80), .065, .06, .13, -.77, 1.02, -.28);
    for (const offset of [-.022, .015]) cylinder(resources, pens, ink, .007, .007, .18, -.77 + offset, 1.10, -.28, 6).rotation.z = offset * 5;
    box(resources, draft, resources.color(0x9eaca2), [.09, .004, .024], [-.58, 1.003, -.106], false);
  } else if (workstationRole === 'tester') {
    const comparison = feature('quality-comparison-display');
    box(resources, comparison, metal, [.22, .018, .18], [-.59, .97, -.21]);
    box(resources, comparison, metal, [.033, .17, .033], [-.59, 1.06, -.21]);
    box(resources, comparison, ink, [.55, .44, .04], [-.59, 1.34, -.21]);
    box(resources, comparison, resources.color(0xd9e1de), [.50, .39, .007], [-.59, 1.34, -.184]);
    for (let line = 0; line < 4; line++) {
      box(resources, comparison, muted, [.024, .024, .005], [-.77, 1.46 - line * .068, -.177], false);
      box(resources, comparison, resources.color(0xa3b0ac), [.31, .012, .005], [-.565, 1.46 - line * .068, -.177], false);
    }
    const devices = feature('quality-device-rack');
    box(resources, devices, metal, [.36, .025, .24], [-.63, .97, .21]);
    for (const x of [-.73, -.54]) {
      box(resources, devices, ink, [.12, .21, .019], [x, 1.08, .22]).rotation.x = -.17;
      box(resources, devices, resources.color(0xcbd8d4), [.092, .166, .005], [x, 1.083, .233]).rotation.x = -.17;
    }
    box(resources, devices, ink, [.22, .39, .41], [-.69, .64, -.11]).name = 'quality-workstation-tower';
  } else if (workstationRole === 'reviewer') {
    const trays = feature('review-two-level-document-trays');
    for (const y of [.986, 1.12]) {
      box(resources, trays, metal, [.44, .022, .32], [-.59, y, -.23]);
      for (const x of [-.80, -.38]) box(resources, trays, metal, [.016, .075, .32], [x, y + .033, -.23]);
      sheet(trays, -.59, y + .025, -.23, .35, .26);
    }
    for (const x of [-.80, -.38]) box(resources, trays, metal, [.018, .18, .018], [x, 1.05, -.375]);
    const folio = feature('review-annotated-folio');
    sheet(folio, -.57, .966, .24, .40, .31);
    for (let i = 0; i < 3; i++) box(resources, folio, resources.color(0xd2ad89), [.045, .004, .030], [-.355, .975, .14 + i * .08], false);
    box(resources, folio, resources.color(0x95796b), [.014, .014, .20], [-.82, .97, .24]);
  } else {
    mug(resources, root, -.61, 1.015, -.14);
    box(resources, root, muted, [.23, .035, .3], [-.57, .965, .19]);
  }

  // A real chair with cushion, back, pedestal and casters.
  const seatX = -0.10, seatZ = 0.7;
  const fabric = resources.color(workstationRole === 'designer' || workstationRole === 'reviewer' ? 0xd7b28f : 0xbac3b9);
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
  return { root, slot, screen, workstationRole };
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

export function createOfficeWorld(resources: OfficeResources, count: number, agents: readonly OfficeAgent[] = []): OfficeWorld {
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

  // Keep the room open above the desks so close-up rotation never puts roof
  // beams or a glass sheet in front of a character's face and shoulders.
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
  const desks = layout.slots.map((slot) => desk(resources, root, slot, officeWorkstationRole(agents[slot.index])));
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
  leftHand: OfficeHandRig;
  rightHand: OfficeHandRig;
  ears: THREE.Group[];
  eyes: THREE.Group;
  tail: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  bodySkin: OfficeBodySkin;
  document: THREE.Group;
  tablet: THREE.Group;
  pen: THREE.Mesh;
  beacon: THREE.Mesh;
  selection: THREE.Mesh;
  statusMaterial: THREE.MeshStandardMaterial;
  screen: THREE.MeshStandardMaterial;
  label: THREE.Vector3;
  phase: number;
  workstationRole: OfficeWorkstationRole;
  postureVariation: number;
}

export function createOfficeAvatar(resources: OfficeResources, desk: OfficeDesk, id: string, appearance?: OfficeAgent['appearance']): OfficeAvatar {
  const root = new THREE.Group();
  root.name = `employee:${id}`;
  root.userData.agentId = id;
  root.userData.workstationRole = desk.workstationRole;
  desk.root.updateWorldMatrix(true, false);
  root.position.copy(desk.root.localToWorld(new THREE.Vector3(-0.10, 0.61, 0.56)));
  root.rotation.y = desk.root.rotation.y;
  const species = appearance?.species || 'cat';
  root.userData.species = species;
  // Saved skin/hair keys stay compatible, but now color animal fur and markings.
  const fur = resources.material(`fur:${appearance?.skinColor}`, { color: appearance?.skinColor || '#D9C5A6' });
  const shirt = resources.material(`shirt:${appearance?.shirtColor}`, { color: appearance?.shirtColor || '#8E9B9D' });
  const markings = resources.material(`markings:${appearance?.hairColor}`, { color: appearance?.hairColor || '#806B58' });
  const cream = resources.color(0xfff4df), ink = resources.color(0x363b3a);
  const body = new THREE.Group(); body.name = 'employee-body'; root.add(body);
  for (const x of [-0.067, 0.067]) {
    const collar = box(resources, body, cream, [0.11, 0.075, 0.035], [x, 0.46, -0.15]);
    collar.rotation.z = x < 0 ? -0.32 : 0.32;
  }
  box(resources, body, cream, [0.067, 0.087, 0.012], [0.11, 0.31, -0.187]);
  box(resources, body, markings, [0.042, 0.015, 0.014], [0.11, 0.329, -0.197], false);
  const head = new THREE.Group(); head.name = 'employee-head'; head.position.set(0, 0.79, 0);
  head.userData.species = species;
  body.add(head);
  const faceGeometry = resources.geometry(`character-head:${species}:${appearance?.skinColor}:${appearance?.hairColor}`, () => {
    const geometry = createCharacterHeadGeometry(species);
    const blend = geometry.getAttribute('muzzleMix'), positions = geometry.getAttribute('position');
    const colors = new Float32Array(positions.count * 3);
    const tone = new THREE.Color(), blush = new THREE.Color(0xdba69a);
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      tone.copy(fur.color).lerp(cream.color, blend.getX(i));
      if (z < -.12) {
        const cheek = Math.exp(-(((Math.abs(x) - .21) / .038) ** 2 + ((y + .073) / .026) ** 2)) * .38;
        tone.lerp(blush, cheek);
        if (species === 'cat' && y > .12 && y < .26) {
          const distance = Math.min(...[-.065, 0, .065].map(center => Math.abs(x - center)));
          const stripe = (1 - THREE.MathUtils.smoothstep(distance, .008, .019)) * Math.sin((y - .12) / .14 * Math.PI) * .72;
          tone.lerp(markings.color, stripe);
        }
      }
      tone.toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geometry;
  });
  const face = mesh(head, faceGeometry, resources.material('character-face-surface', { color: 0xffffff, vertexColors: true, roughness: .72 }), 0, 0, 0);
  face.name = 'animal-face';
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
        return new THREE.ExtrudeGeometry(shape, { depth: 0.085, bevelEnabled: true, bevelSegments: 5, steps: 1, bevelSize: 0.025, bevelThickness: 0.025 });
      });
      mesh(ear, geometry, species === 'fox' ? markings : fur, 0, 0, -0.04);
      const inset = mesh(ear, geometry, species === 'fox' ? fur : markings, 0, 0.025, -0.063);
      inset.scale.set(0.55, 0.65, 0.3);
      ear.rotation.z = x < 0 ? 0.15 : -0.15;
    }
  }
  const muzzle = new THREE.Group(); muzzle.name = 'animal-muzzle'; head.add(muzzle);
  const nose = sphere(resources, muzzle, ink, 0.03, 0, -0.057, characterFaceSurface(species, 0, -.057) - .008, 20);
  nose.name = 'animal-nose'; nose.scale.set(1.2, 0.75, 0.7);
  const eyes = new THREE.Group(); eyes.name = 'animal-eyes'; eyes.position.y = 0.033; head.add(eyes);
  for (const x of [-0.116, 0.116]) {
    const eyeZ = characterFaceSurface(species, x, .033) - .006;
    sphere(resources, eyes, ink, 0.032, x, 0, eyeZ, 20).scale.set(0.78, 1.07, 0.56);
    sphere(resources, eyes, cream, 0.009, x - 0.008, 0.012, eyeZ - .018, 12);
  }
  if (appearance?.accessory === 'glasses') {
    const frameZ = Math.min(characterFaceSurface(species, .044, .03), characterFaceSurface(species, .19, .03)) - .02;
    for (const x of [-0.119, 0.119]) mesh(head, resources.geometry('animal-glasses', () => new THREE.TorusGeometry(0.075, 0.009, 8, 32)), ink, x, 0.027, frameZ);
    box(resources, head, ink, [0.084, 0.012, 0.012], [0, 0.03, frameZ], false);
  }
  if (appearance?.accessory === 'headset') {
    for (const x of [-0.302, 0.302]) box(resources, head, ink, [0.052, 0.15, 0.12], [x, 0.015, 0]);
    const band = mesh(head, resources.geometry('animal-headset-band', () => new THREE.TorusGeometry(0.32, 0.018, 6, 22, Math.PI)), ink, 0, 0.015, 0.04);
    box(resources, head, ink, [0.015, 0.015, 0.24], [-0.305, -0.06, -0.1], false);
    band.name = 'animal-headset';
  }
  const tail = new THREE.Group(); tail.name = 'animal-tail'; tail.position.set(0.16, 0.02, 0.14); root.add(tail);
  if (species === 'cat') {
    const geometry = resources.geometry('continuous-cat-tail', () => {
      const curve = new THREE.CatmullRomCurve3(Array.from({ length: 17 }, (_, i) => {
        const angle = i / 16 * Math.PI * 1.2;
        return new THREE.Vector3(Math.sin(angle) * .22, (1 - Math.cos(angle)) * .13, .06 + i * .007);
      }));
      const tube = new THREE.TubeGeometry(curve, 32, .05, 16, false);
      const source = tube.getAttribute('position'), points = Array.from(source.array);
      const indices = Array.from(tube.index!.array);
      for (let ring = 0; ring <= 32; ring++) {
        const center = curve.getPointAt(ring / 32);
        const taper = ring < 28 ? 1 - ring / 100 : .72 * Math.sqrt(1 - ((ring - 28) / 5) ** 2);
        for (let side = 0; side <= 16; side++) {
          const offset = (ring * 17 + side) * 3;
          points[offset] = center.x + (points[offset] - center.x) * taper;
          points[offset + 1] = center.y + (points[offset + 1] - center.y) * taper;
          points[offset + 2] = center.z + (points[offset + 2] - center.z) * taper;
        }
      }
      for (const ring of [0, 32]) {
        const centerIndex = points.length / 3, point = curve.getPointAt(ring / 32);
        points.push(point.x, point.y, point.z);
        for (let side = 0; side < 16; side++) {
          const a = ring * 17 + side, b = a + 1;
          indices.push(centerIndex, ring ? a : b, ring ? b : a);
        }
      }
      tube.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      tube.deleteAttribute('normal'); tube.deleteAttribute('uv'); tube.setIndex(indices); tube.computeVertexNormals();
      const normals = tube.getAttribute('normal'), normal = new THREE.Vector3();
      for (let ring = 0; ring <= 32; ring++) {
        const a = ring * 17, b = a + 16;
        normal.set(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b), normals.getZ(a) + normals.getZ(b)).normalize();
        normals.setXYZ(a, normal.x, normal.y, normal.z); normals.setXYZ(b, normal.x, normal.y, normal.z);
      }
      tube.computeBoundingBox(); tube.computeBoundingSphere();
      return tube;
    });
    mesh(tail, geometry, fur, 0, 0, 0);
  } else if (species === 'fox') {
    const brush = sphere(resources, tail, fur, 0.17, 0.17, 0.08, 0.09, 16); brush.scale.set(1.8, 0.9, 0.9); brush.rotation.z = 0.45;
    sphere(resources, tail, cream, 0.11, 0.38, 0.18, 0.09, 14).scale.set(1.2, 0.9, 0.85);
  } else sphere(resources, tail, species === 'rabbit' ? cream : fur, 0.12, 0.06, 0.06, 0.11, 16);
  // IK controls remain fixed-length; one continuous skinned surface follows
  // each shoulder → elbow → wrist chain without visible primitive joints.
  const arms = [-0.245, 0.245].map(x => {
    const side = x < 0 ? 'left' : 'right';
    const arm = new THREE.Group(); arm.name = `${side}-arm`;
    arm.position.set(x, 0.44, 0); body.add(arm);
    const elbow = new THREE.Group(); elbow.name = `${side}-elbow`; elbow.position.z = -0.25; arm.add(elbow);
    const wrist = new THREE.Group(); wrist.name = `${side}-wrist`; wrist.position.z = -0.27; elbow.add(wrist);
    const hand = createOfficeHand(resources, wrist, [fur, cream], species, side);
    return { arm, elbow, wrist, hand };
  });
  const bodySkin = createOfficeBodySkin(resources, body, {
    left: [arms[0].arm, arms[0].elbow, arms[0].wrist],
    right: [arms[1].arm, arms[1].elbow, arms[1].wrist],
  }, [shirt, fur], species);
  bodySkin.mesh.name = 'employee-shirt';
  const legHabits: Record<OfficeWorkstationRole, [number, number, number]> = {
    coordinator: [-.02, .035, .13], researcher: [.045, -.025, -.10],
    designer: [-.045, .02, .06], writer: [.02, -.045, -.06],
    tester: [-.03, .04, .10], reviewer: [.045, .055, .18], generic: [0, .025, .04],
  };
  const legHabit = legHabits[desk.workstationRole];
  const legGeometry = resources.geometry(`character-leg:${appearance?.skinColor}`, () => {
    const geometry = createCharacterLegGeometry();
    const mix = geometry.getAttribute('trousersMix');
    const colors = new Float32Array(mix.count * 3);
    const tone = new THREE.Color(), trousers = new THREE.Color(0x596970);
    for (let i = 0; i < mix.count; i++) tone.copy(fur.color).lerp(trousers, mix.getX(i)).toArray(colors, i * 3);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geometry;
  });
  const legMaterial = resources.material('character-leg-surface', { color: 0xffffff, vertexColors: true, roughness: .78 });
  for (const [index, x] of [-0.115, 0.115].entries()) {
    const leg = new THREE.Group(); leg.name = index ? 'employee-leg-right' : 'employee-leg-left';
    leg.position.set(x, 0, legHabit[index]);
    leg.rotation.y = (index ? -1 : 1) * legHabit[2];
    root.add(leg);
    mesh(leg, legGeometry, legMaterial, 0, 0, 0).name = 'continuous-leg-and-paw';
  }
  // Small characters need a support at their actual sole height; feet no longer
  // float above the floor, and asymmetric leg placements share the same support.
  const footrest = box(resources, root, resources.color(0x8b9890), [.72, .08, .58], [0, -.425, -.235]);
  footrest.name = 'employee-footrest';
  for (const x of [-.28, .28]) box(resources, root, resources.color(0x687173), [.04, .15, .40], [x, -.535, -.235]);
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
  const pen = mesh(arms[1].wrist, resources.geometry('office-pen-profile', createOfficePenGeometry),
    resources.material('office-pen-finish', { color: 0xffffff, vertexColors: true, roughness: .46, metalness: .18 }), .034, .06, 0);
  pen.name = 'drawing-stylus';
  const penStand = mesh(root, resources.geometry('office-pen-stand', () => new THREE.LatheGeometry([
    new THREE.Vector2(0,0), new THREE.Vector2(.027,0), new THREE.Vector2(.029,.005),
    new THREE.Vector2(.025,.039), new THREE.Vector2(.023,.045), new THREE.Vector2(.018,.045),
    new THREE.Vector2(.016,.009), new THREE.Vector2(0,.009),
  ], 24)), resources.color(0x6e8178), OFFICE_PEN_DOCK.x, .345, OFFICE_PEN_DOCK.z);
  penStand.name = 'office-pen-stand';
  const statusMaterial = resources.material(`status:${desk.slot.index}`, { color: 0x99a2aa, emissive: 0x99a2aa, emissiveIntensity: 0.24 });
  const beacon = sphere(resources, root, statusMaterial, 0.055, 0.28, 1.07, 0.04, 8);
  const selection = mesh(root, resources.geometry('selected-ring', () => new THREE.TorusGeometry(0.42, 0.022, 5, 28)),
    resources.color(0x619a84), 0, -0.55, 0.08);
  selection.rotation.x = -Math.PI / 2; selection.visible = false;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  document.visible = tablet.visible = pen.visible = false;
  return { root, body, head, ears, eyes, tail, leftArm: arms[0].arm, rightArm: arms[1].arm,
    bodySkin, leftHand: arms[0].hand, rightHand: arms[1].hand,
    leftElbow: arms[0].elbow, rightElbow: arms[1].elbow, leftWrist: arms[0].wrist, rightWrist: arms[1].wrist, document, tablet, pen, beacon, selection,
    statusMaterial, screen: desk.screen, label: new THREE.Vector3(root.position.x, species === 'rabbit' ? 2.18 : 2.04, root.position.z), phase: (hash % 1000) / 100,
    workstationRole: desk.workstationRole, postureVariation: id ? (hash % 997) / 996 - .5 : 0 };
}

export function poseOfficeAvatar(avatar: OfficeAvatar, state: AgentState, time: number, selected: boolean, action: NonNullable<OfficeAgent['action']>['kind'] = 'unreported', blend?: OfficeMotionBlend) {
  const color = OFFICE_STATE_COLORS[state];
  avatar.statusMaterial.color.setHex(color); avatar.statusMaterial.emissive.setHex(color);
  avatar.screen.color.setHex(avatar.screen.map ? 0xffffff : state === 'error' ? 0xd9a59d : ['waiting', 'stopped', 'unknown'].includes(state) ? 0xb8c3bd : 0xb4d1c6);
  avatar.screen.emissiveIntensity = avatar.screen.map ? 0.08 : state === 'working' ? 0.46 : state === 'thinking' ? 0.29 : 0.08;
  applyOfficeAvatarMotion(avatar, state, time, action, blend);
  avatar.beacon.scale.setScalar(1);
  avatar.selection.visible = selected;
}
