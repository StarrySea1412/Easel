import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import type { OfficeCharacterSpecies } from './officeCharacterForms';

interface BodyResources {
  geometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry;
  ownDisposable<T extends { dispose(): void }>(value: T): T;
}
type ArmControls = [THREE.Group, THREE.Group, THREE.Group];
export interface OfficeBodyControls { left: ArmControls; right: ArmControls }
export interface OfficeBodySkin {
  mesh: THREE.SkinnedMesh;
  /** Body, left shoulder/elbow/wrist, right shoulder/elbow/wrist. */
  bones: [THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone];
  controls: OfficeBodyControls;
}

const resolution = 52;
const smoothShoulder = .075;
const bounds = { min: [-.46, -.095, -.735], size: [.92, .75, 1.035] };
const shoulderX = .245, shoulderY = .44;
const radii: ReadonlyArray<readonly [number, number, number]> = [
  [.065, .084, .084], [-.045, .095, .087], [-.13, .089, .079],
  [-.195, .079, .070], [-.245, .065, .061], [-.355, .060, .056],
  [-.425, .057, .050], [-.48, .062, .047], [-.525, .077, .050],
  [-.555, .079, .049], [-.59, .058, .036],
];

function ellipseDistance(x: number, y: number, z: number, rx: number, ry: number, rz: number) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 > 1e-8 ? k0 * (k0 - 1) / k1 : -Math.min(rx, ry, rz);
}

function torsoDistance(x: number, y: number, z: number, species: OfficeCharacterSpecies) {
  const width = species === 'bear' ? .263 : species === 'rabbit' ? .231 : species === 'fox' ? .238 : .25;
  const depth = species === 'bear' ? .199 : species === 'rabbit' ? .181 : .19;
  return ellipseDistance(x, y - .263, z, width, .263, depth);
}

function armDistance(x: number, y: number, z: number, side: number) {
  const clamped = THREE.MathUtils.clamp(z, radii.at(-1)![0], radii[0][0]);
  let index = 0;
  while (index < radii.length - 2 && clamped < radii[index + 1][0]) index++;
  const from = radii[index], to = radii[index + 1];
  const t = THREE.MathUtils.smoothstep((from[0] - clamped) / (from[0] - to[0]), 0, 1);
  const rx = THREE.MathUtils.lerp(from[1], to[1], t), ry = THREE.MathUtils.lerp(from[2], to[2], t);
  // Rounded axial caps close the paw and back shoulder within this same field.
  const cap = z < radii.at(-1)![0] ? .037 : .072;
  const q = Math.hypot((x - side * shoulderX) / rx, (y - shoulderY) / ry, (z - clamped) / cap);
  return (q - 1) * Math.min(rx, ry);
}

function smoothUnion(a: number, b: number) {
  const h = THREE.MathUtils.clamp(.5 + .5 * (b - a) / smoothShoulder, 0, 1);
  return THREE.MathUtils.lerp(b, a, h) - smoothShoulder * h * (1 - h);
}

/**
 * Static, welded, watertight torso + both arms. Built once per species, never
 * updated by the motion loop. `furMix` is a 0..1 shader/color attribute; the two
 * groups also support [shirtMaterial, furMaterial] without geometry seams.
 * Skin indices: body=0, left=1/2/3, right=4/5/6.
 */
function buildOfficeBodyGeometry(species: OfficeCharacterSpecies): THREE.BufferGeometry {
  const temporaryMaterial = new THREE.MeshBasicMaterial();
  const marching = new MarchingCubes(resolution, temporaryMaterial, false, false, 25000);
  marching.isolation = 0;
  try {
    for (let iz = 0; iz < resolution; iz++) for (let iy = 0; iy < resolution; iy++) for (let ix = 0; ix < resolution; ix++) {
      const x = bounds.min[0] + ix / resolution * bounds.size[0];
      const y = bounds.min[1] + iy / resolution * bounds.size[1];
      const z = bounds.min[2] + iz / resolution * bounds.size[2];
      const torso = torsoDistance(x, y, z, species);
      marching.field[ix + iy * resolution + iz * resolution * resolution] = -smoothUnion(smoothUnion(torso, armDistance(x, y, z, -1)), armDistance(x, y, z, 1));
    }
    marching.update();
    if (marching.count >= 75000) throw new Error('Continuous office body exceeded its static geometry budget.');
    // Marching cubes emits triangle soup. Weld by position before calculating
    // normals and weights so shoulder/cuff triangles truly share their vertices.
    const positions: number[] = [], indices: number[] = [];
    const welded = new Map<string, number>();
    for (let offset = 0; offset < marching.count * 3; offset += 3) {
      const p = [0, 1, 2].map(axis => bounds.min[axis] + (marching.positionArray[offset + axis] + 1) / 2 * bounds.size[axis]);
      const key = p.map(value => Math.round(value * 1e6)).join(':');
      let index = welded.get(key);
      if (index === undefined) { index = positions.length / 3; positions.push(...p); welded.set(key, index); }
      indices.push(index);
    }
    const skinIndices: number[] = [], skinWeights: number[] = [], furMix: number[] = [];
    for (let offset = 0; offset < positions.length; offset += 3) {
      const [x, y, z] = positions.slice(offset, offset + 3);
      const side = x < 0 ? -1 : 1, firstBone = side < 0 ? 1 : 4;
      const torso = torsoDistance(x, y, z, species), arm = armDistance(x, y, z, side);
      // Same blend interval as the SDF union: the shoulder is a gradual
      // deformation of the shirt surface, with no rigid socket or open edge.
      const bodyWeight = THREE.MathUtils.clamp(.5 + .5 * (arm - torso) / smoothShoulder, 0, 1);
      const armWeight = 1 - bodyWeight;
      const elbow = THREE.MathUtils.smoothstep(-z, .16, .34), wrist = THREE.MathUtils.smoothstep(-z, .405, .505);
      skinIndices.push(0, firstBone, firstBone + 1, firstBone + 2);
      skinWeights.push(bodyWeight, armWeight * (1 - elbow), armWeight * elbow * (1 - wrist), armWeight * wrist);
      furMix.push(armWeight * THREE.MathUtils.smoothstep(-z, .198, .229));
    }
    const groups: number[][] = [[], []];
    for (let offset = 0; offset < indices.length; offset += 3) {
      const [a, b, c] = indices.slice(offset, offset + 3);
      if (a === b || b === c || c === a) continue;
      const material = (furMix[a] + furMix[b] + furMix[c]) / 3 > .5 ? 1 : 0;
      groups[material].push(a, b, c);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.name = `continuous-office-body-${species}`;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    geometry.setAttribute('furMix', new THREE.Float32BufferAttribute(furMix, 1));
    geometry.setIndex([...groups[0], ...groups[1]]);
    geometry.addGroup(0, groups[0].length, 0); geometry.addGroup(groups[0].length, groups[1].length, 1);
    geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    return geometry;
  } finally {
    marching.geometry.dispose(); temporaryMaterial.dispose();
  }
}

// CPU templates are bounded to the four built-in species. Palette editing can
// recreate renderer-owned resources without repeating the static field solve.
// Templates never reach a renderer; each caller owns and disposes its clone.
const bodyTemplates = new Map<OfficeCharacterSpecies, THREE.BufferGeometry>();
export function createOfficeBodyGeometry(species: OfficeCharacterSpecies = 'cat'): THREE.BufferGeometry {
  const key = ['cat', 'rabbit', 'fox', 'bear'].includes(species) ? species : 'cat';
  let template = bodyTemplates.get(key);
  if (!template) { template = buildOfficeBodyGeometry(key); bodyTemplates.set(key, template); }
  return template.clone();
}

export function createOfficeBodySkin(resources: BodyResources, parent: THREE.Group, controls: OfficeBodyControls, materials: THREE.Material[], species: OfficeCharacterSpecies = 'cat'): OfficeBodySkin {
  const mesh = new THREE.SkinnedMesh(resources.geometry(`continuous-office-body-v1:${species}`, () => createOfficeBodyGeometry(species)), materials);
  mesh.name = 'employee-shirt'; mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false;
  const bones: OfficeBodySkin['bones'] = [new THREE.Bone(), new THREE.Bone(), new THREE.Bone(), new THREE.Bone(), new THREE.Bone(), new THREE.Bone(), new THREE.Bone()];
  bones[0].name = 'shirt-body-skin'; mesh.add(bones[0]);
  for (const [side, start] of [['left', 1], ['right', 4]] as const) {
    const arm = controls[side];
    for (let joint = 0; joint < 3; joint++) {
      const bone = bones[start + joint]; bone.name = `${side}-${['shoulder', 'elbow', 'wrist'][joint]}-skin`;
      bone.position.copy(arm[joint].position);
      bones[joint === 0 ? 0 : start + joint - 1].add(bone);
    }
  }
  parent.add(mesh); parent.updateWorldMatrix(true, true);
  mesh.bind(resources.ownDisposable(new THREE.Skeleton(bones)));
  return { mesh, bones, controls };
}

export function syncOfficeBodySkin(skin: OfficeBodySkin) {
  for (let side = 0; side < 2; side++) {
    const start = side ? 4 : 1, controls = side ? skin.controls.right : skin.controls.left;
    for (let joint = 0; joint < 3; joint++) {
      const bone = skin.bones[start + joint], control = controls[joint];
      bone.position.copy(control.position); bone.quaternion.copy(control.quaternion); bone.scale.copy(control.scale);
    }
  }
}
