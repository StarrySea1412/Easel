import * as THREE from 'three';
import type { OfficeCharacterSpecies } from './officeCharacterForms';

interface HandResources {
  geometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry;
}
export type OfficeHandPose = 'flat' | 'pen' | 'paper';
export interface OfficeHandWeights { pen?: number; paper?: number }
export interface OfficeHandRig {
  mesh: THREE.Mesh;
  side: 'left' | 'right';
}

/** Wrist-local: +Y is the back of the paw, fingers point toward -Z. */
export const OFFICE_HAND_PEN_AXIS = new THREE.Vector2(.105, 0);
/** Page contact under the finger pads, before applying the wrist's orientation. */
export const OFFICE_HAND_PAPER_CONTACT = new THREE.Vector3(0, -.025, -.08);

type Point = readonly [number, number, number];
type DigitPath = readonly [Point, Point, Point, Point];
const paths: Record<OfficeHandPose, readonly DigitPath[]> = {
  flat: [
    [[.037,0,-.043], [.043,0,-.076], [.043,-.003,-.117], [.04,-.006,-.143]],
    [[-.004,0,-.052], [-.003,0,-.088], [-.004,-.003,-.133], [-.005,-.007,-.158]],
    [[-.042,0,-.043], [-.044,-.002,-.077], [-.041,-.005,-.114], [-.039,-.009,-.137]],
    [[.052,0,.013], [.079,-.001,.033], [.103,-.004,.037], [.119,-.007,.039]],
  ],
  pen: [
    [[.037,0,-.043], [.058,.01,-.063], [.091,.018,-.051], [.111,.019,-.026]],
    [[-.004,0,-.052], [.026,-.017,-.071], [.075,-.019,-.06], [.106,-.02,-.028]],
    [[-.042,0,-.043], [-.024,-.022,-.069], [.018,-.031,-.071], [.049,-.034,-.049]],
    [[.052,0,.013], [.073,.02,.048], [.095,.025,.051], [.106,.023,.027]],
  ],
  paper: [
    [[.037,0,-.043], [.043,-.009,-.077], [.04,-.008,-.104], [.037,.006,-.12]],
    [[-.004,0,-.052], [-.003,-.007,-.083], [-.004,-.008,-.115], [-.005,.006,-.133]],
    [[-.042,0,-.043], [-.044,-.009,-.076], [-.043,-.008,-.099], [-.04,.004,-.115]],
    [[.052,0,.013], [.077,-.007,.031], [.097,-.012,.04], [.108,-.011,.04]],
  ],
};
const radii = [.019, .021, .019, .02];
const rings = 16, sides = 12;

/** Four closed tapered digits; the embedded roots overlap the existing palm. */
export function createOfficeHandGeometry(species: OfficeCharacterSpecies = 'cat', side: 'left' | 'right' = 'right') {
  const width = species === 'bear' ? 1.08 : species === 'rabbit' ? .9 : species === 'fox' ? .94 : 1;
  const length = species === 'rabbit' ? 1.09 : species === 'fox' ? 1.04 : species === 'bear' ? .96 : 1;
  const mirror = side === 'left' ? -1 : 1;
  const indices: number[] = [], clawIndices: number[] = [];
  const positions: Record<OfficeHandPose, number[]> = { flat: [], pen: [], paper: [] };
  const tangent = new THREE.Vector3(), across = new THREE.Vector3(), normal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (const pose of ['flat', 'pen', 'paper'] as const) {
    const output = positions[pose];
    for (let digit = 0; digit < 4; digit++) {
      const curve = new THREE.CatmullRomCurve3(paths[pose][digit].map((point, index) => {
        const p = new THREE.Vector3(...point);
        // Grip and attachment positions are identical for all species. Only
        // free fingertips change length, so wider bear paws still fit the pen.
        if (pose !== 'pen' && digit < 3 && index > 0) p.z = -.043 + (p.z + .043) * length;
        return p;
      }));
      const sample = (t: number, angle: number, relief = 0) => {
        const point = curve.getPoint(t);
        curve.getTangent(t, tangent).normalize();
        across.crossVectors(tangent, up).normalize();
        normal.crossVectors(across, tangent).normalize();
        const cap = t < .72 ? 1 : Math.sqrt(Math.max(0, 1 - ((t - .72) / .28) ** 2));
        const radius = radii[digit] * width * (1 - t * .17) * cap + relief;
        point.addScaledVector(across, Math.sin(angle) * radius);
        point.addScaledVector(normal, Math.cos(angle) * radius * .81);
        output.push(point.x * mirror, point.y, point.z);
      };
      const base = output.length / 3;
      for (let ring = 0; ring < rings; ring++) for (let sector = 0; sector < sides; sector++) {
        sample(ring / rings, sector / sides * Math.PI * 2);
      }
      const tip = output.length / 3; sample(1, 0);
      const cap = output.length / 3;
      const root = curve.getPoint(0); output.push(root.x * mirror, root.y, root.z);
      if (pose === 'flat') {
        for (let ring = 0; ring < rings - 1; ring++) for (let sector = 0; sector < sides; sector++) {
          const a = base + ring * sides + sector, b = base + ring * sides + (sector + 1) % sides;
          indices.push(a, b, a + sides, b, b + sides, a + sides);
        }
        for (let sector = 0; sector < sides; sector++) {
          const next = (sector + 1) % sides, last = base + (rings - 1) * sides;
          indices.push(cap, base + next, base + sector, last + sector, last + next, tip);
        }
      }
      // A shallow nail follows the distal skin instead of a floating sphere.
      // Its small warm tip reads as a paw claw without oversized human nails.
      const claw = output.length / 3;
      for (const t of [.79, .87, .94]) for (const angle of [-.39, 0, .39]) sample(t, angle, .0009);
      if (pose === 'flat') for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
        const a = claw + row * 3 + col;
        clawIndices.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
      }
    }
  }
  if (mirror < 0) for (const list of [indices, clawIndices]) for (let i = 0; i < list.length; i += 3) {
    [list[i + 1], list[i + 2]] = [list[i + 2], list[i + 1]];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.name = `office-fingers-${species}-${side}`;
  geometry.setIndex([...indices, ...clawIndices]);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat, 3));
  geometry.addGroup(0, indices.length, 0); geometry.addGroup(indices.length, clawIndices.length, 1);
  geometry.computeVertexNormals();
  for (const pose of ['pen', 'paper'] as const) {
    const target = new THREE.BufferGeometry();
    target.setIndex(geometry.index); target.setAttribute('position', new THREE.Float32BufferAttribute(positions[pose], 3));
    target.computeVertexNormals();
    const position = target.getAttribute('position'); position.name = pose;
    (geometry.morphAttributes.position ||= []).push(position);
    (geometry.morphAttributes.normal ||= []).push(target.getAttribute('normal'));
    target.dispose();
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export function createOfficeHand(resources: HandResources, wrist: THREE.Group, materials: THREE.Material[], species: OfficeCharacterSpecies, side: 'left' | 'right'): OfficeHandRig {
  const mesh = new THREE.Mesh(resources.geometry(`office-fingers-v1:${species}:${side}`, () => createOfficeHandGeometry(species, side)), materials);
  mesh.name = `animal-paw-${side}`;
  mesh.castShadow = mesh.receiveShadow = true;
  wrist.add(mesh);
  return { mesh, side };
}

/** Absolute blend weights: remainder is the relaxed flat paw, without allocations. */
export function updateOfficeHandPose(hand: OfficeHandRig, pose: OfficeHandPose | OfficeHandWeights) {
  let pen = typeof pose === 'string' ? Number(pose === 'pen') : pose.pen ?? 0;
  let paper = typeof pose === 'string' ? Number(pose === 'paper') : pose.paper ?? 0;
  pen = Number.isFinite(pen) ? THREE.MathUtils.clamp(pen, 0, 1) : 0;
  paper = Number.isFinite(paper) ? THREE.MathUtils.clamp(paper, 0, 1) : 0;
  const total = Math.max(1, pen + paper);
  hand.mesh.morphTargetInfluences![0] = pen / total;
  hand.mesh.morphTargetInfluences![1] = paper / total;
}
