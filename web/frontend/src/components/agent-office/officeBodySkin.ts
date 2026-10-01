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

/** Height, half-width, front depth (-Z), back depth (+Z), in body-local units. */
type TorsoSection = readonly [number, number, number, number];

// Seated clothing needs a hem, waist, chest and sloping shoulders. These are
// the profiles of the visible skinned surface, not a second hidden torso mesh.
// The back is flatter than the chest; collar, badge and hip anchors stay fixed.
const torsoProfiles: Record<OfficeCharacterSpecies, readonly TorsoSection[]> = {
  cat: [
    [0, .125, .081, .088], [.024, .194, .129, .137], [.055, .236, .160, .168],
    [.110, .230, .169, .175], [.195, .213, .175, .165], [.290, .230, .189, .173],
    [.370, .244, .171, .154], [.432, .242, .135, .130], [.477, .177, .101, .099],
    [.512, .100, .060, .062], [.530, .060, .039, .041],
  ],
  rabbit: [
    [0, .113, .075, .081], [.024, .174, .119, .128], [.055, .216, .151, .160],
    [.110, .205, .156, .164], [.195, .186, .161, .153], [.290, .211, .182, .162],
    [.370, .228, .161, .143], [.435, .238, .128, .122], [.480, .160, .091, .092],
    [.518, .087, .054, .054], [.538, .052, .035, .037],
  ],
  fox: [
    [0, .110, .072, .080], [.024, .170, .111, .121], [.055, .207, .144, .152],
    [.110, .197, .151, .157], [.195, .180, .159, .146], [.290, .211, .181, .157],
    [.370, .239, .162, .141], [.433, .244, .130, .123], [.478, .164, .096, .093],
    [.514, .088, .055, .057], [.534, .053, .036, .039],
  ],
  bear: [
    [0, .145, .091, .101], [.024, .207, .140, .151], [.055, .253, .176, .185],
    [.110, .248, .187, .193], [.195, .237, .194, .187], [.290, .256, .197, .186],
    [.370, .262, .182, .166], [.429, .256, .146, .141], [.473, .190, .110, .108],
    [.510, .110, .067, .068], [.527, .066, .043, .045],
  ],
};

/** Monotone Hermite sections keep the authored waist without interpolation bulges. */
function torsoSectionAt(sections: readonly TorsoSection[], y: number): [number, number, number] {
  let index = 0;
  while (index < sections.length - 2 && y > sections[index + 1][0]) index++;
  const left = sections[index], right = sections[index + 1], span = right[0] - left[0];
  const t = THREE.MathUtils.clamp((y - left[0]) / span, 0, 1);
  const result: [number, number, number] = [0, 0, 0];
  for (let axis = 1; axis < 4; axis++) {
    const slope = (right[axis] - left[axis]) / span;
    const before = index > 0 ? (left[axis] - sections[index - 1][axis]) / (left[0] - sections[index - 1][0]) : slope;
    const after = index + 2 < sections.length ? (sections[index + 2][axis] - right[axis]) / (sections[index + 2][0] - right[0]) : slope;
    const tangent = (a: number, b: number) => a * b <= 0 ? 0 : 2 * a * b / (a + b);
    result[axis - 1] = (2 * t ** 3 - 3 * t ** 2 + 1) * left[axis]
      + (t ** 3 - 2 * t ** 2 + t) * tangent(before, slope) * span
      + (-2 * t ** 3 + 3 * t ** 2) * right[axis]
      + (t ** 3 - t ** 2) * tangent(slope, after) * span;
  }
  return result;
}

function torsoDistance(x: number, y: number, z: number, sections: readonly TorsoSection[], section = torsoSectionAt(sections, y)) {
  const [width, front, back] = section, depth = z < 0 ? front : back;
  const k0 = Math.hypot(x / width, z / depth);
  const k1 = Math.hypot(x / (width * width), z / (depth * depth));
  const radial = k1 > 1e-8 ? k0 * (k0 - 1) / k1 : -Math.min(width, depth);
  const cap = Math.max(sections[0][0] - y, y - sections.at(-1)![0]);
  return Math.hypot(Math.max(radial, 0), Math.max(cap, 0)) + Math.min(Math.max(radial, cap), 0);
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
    const sections = torsoProfiles[species];
    // The static field samples only 52 distinct heights; evaluate the authored
    // curve once per row instead of repeating interpolation for every voxel.
    const sectionRows = Array.from({ length: resolution }, (_, iy) => torsoSectionAt(sections, bounds.min[1] + iy / resolution * bounds.size[1]));
    for (let iz = 0; iz < resolution; iz++) for (let iy = 0; iy < resolution; iy++) for (let ix = 0; ix < resolution; ix++) {
      const x = bounds.min[0] + ix / resolution * bounds.size[0];
      const y = bounds.min[1] + iy / resolution * bounds.size[1];
      const z = bounds.min[2] + iz / resolution * bounds.size[2];
      const torso = torsoDistance(x, y, z, sections, sectionRows[iy]);
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
      const torso = torsoDistance(x, y, z, sections), arm = armDistance(x, y, z, side);
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
