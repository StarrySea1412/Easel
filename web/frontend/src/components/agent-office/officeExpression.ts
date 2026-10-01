import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { OfficeActionKind, OfficeAgentState } from '../../lib/agentOffice';
import type { OfficeResources } from './officeGeometry';
import { CHARACTER_FACE_FEATURES, characterFaceSurface, type OfficeCharacterSpecies } from './officeCharacterForms';

export type OfficeExpressionKind = 'neutral' | 'focused' | 'thinking' | 'waiting' | 'complete' | 'concerned';
const KINDS: readonly OfficeExpressionKind[] = ['neutral', 'focused', 'thinking', 'waiting', 'complete', 'concerned'];

// Visual status cues only: these do not claim an agent has feelings or intent.
// All shapes are authored ahead of time; updates never create or rewrite geometry.
const SHAPES: Record<OfficeExpressionKind, {
  openness: readonly [number, number]; browLift: number; browSlope: number; browArch: number;
  mouthWidth: number; mouthCorner: number; mouthDip: number;
}> = {
  neutral: { openness: [1, 1], browLift: 0, browSlope: 0, browArch: .004, mouthWidth: 1, mouthCorner: -.004, mouthDip: .004 },
  focused: { openness: [.88, .88], browLift: -.010, browSlope: -.008, browArch: .002, mouthWidth: .76, mouthCorner: -.002, mouthDip: .004 },
  thinking: { openness: [.96, 1.03], browLift: .005, browSlope: .002, browArch: .008, mouthWidth: .76, mouthCorner: -.004, mouthDip: .005 },
  waiting: { openness: [.83, .83], browLift: -.004, browSlope: 0, browArch: .003, mouthWidth: .88, mouthCorner: -.005, mouthDip: .004 },
  complete: { openness: [.88, .88], browLift: .003, browSlope: 0, browArch: .009, mouthWidth: 1.06, mouthCorner: .017, mouthDip: .010 },
  concerned: { openness: [1.07, 1.07], browLift: .007, browSlope: .015, browArch: .002, mouthWidth: .88, mouthCorner: -.020, mouthDip: .005 },
};

export interface OfficeExpressionRig {
  mouth: THREE.Mesh;
  brows: THREE.Mesh;
  eyes: readonly [THREE.Mesh, THREE.Mesh];
  species: OfficeCharacterSpecies;
  current: OfficeExpressionKind;
}

/** Unknown/unreported work stays neutral, even when a caller has a working state. */
export function officeExpressionKind(state: OfficeAgentState, action: OfficeActionKind = 'unreported'): OfficeExpressionKind {
  if (state === 'error') return 'concerned';
  if (state === 'done') return 'complete';
  if (state === 'thinking') return 'thinking';
  if (state === 'waiting' || state === 'stopped') return 'waiting';
  if (state === 'working' && ['executing', 'reading', 'writing', 'designing', 'delegating'].includes(action)) return 'focused';
  return 'neutral';
}

class FaceLine extends THREE.Curve<THREE.Vector3> {
  private species: OfficeCharacterSpecies;
  private xy: THREE.CatmullRomCurve3;

  constructor(species: OfficeCharacterSpecies, xy: THREE.CatmullRomCurve3) {
    super(); this.species = species; this.xy = xy;
  }

  // Sample XY first and then project onto the authored face. Interpolating Z
  // between a few anchors would cut through the fox's strongly curved muzzle.
  override getPoint(t: number, target = new THREE.Vector3()) {
    this.xy.getPoint(t, target);
    target.z = characterFaceSurface(this.species, target.x, target.y) - .005;
    return target;
  }
}

function surfaceLine(species: OfficeCharacterSpecies, points: readonly (readonly [number, number])[], radius: number) {
  const line = new FaceLine(species, new THREE.CatmullRomCurve3(points.map(([x, y]) => new THREE.Vector3(x, y, 0))));
  return new THREE.TubeGeometry(line, 16, radius, 5, false);
}

function expressionGeometry(species: OfficeCharacterSpecies, kind: OfficeExpressionKind, part: 'mouth' | 'brows') {
  const features = CHARACTER_FACE_FEATURES[species], shape = SHAPES[kind], pieces: THREE.BufferGeometry[] = [];
  if (part === 'mouth') {
    const forkY = features.noseY - features.mouthDrop * .65;
    pieces.push(surfaceLine(species, [[0, features.noseY - .01], [0, forkY]], .0028));
    for (const side of [-1, 1]) {
      const width = features.mouthWidth * shape.mouthWidth;
      const asymmetricCorner = kind === 'thinking' ? side * .006 : 0;
      pieces.push(surfaceLine(species, [[0, forkY], [side * width * .48, forkY - shape.mouthDip],
        [side * width, forkY + shape.mouthCorner + asymmetricCorner]], species === 'rabbit' ? .0026 : .0031));
    }
  } else {
    for (const side of [-1, 1]) {
      const centerX = features.eyeX * side, centerY = features.eyeY + .083 + shape.browLift;
      const raised = kind === 'thinking' && side === 1 ? .010 : 0;
      // Inner eyebrow ends rise for an error cue and lower slightly for focus.
      pieces.push(surfaceLine(species, Array.from({ length: 5 }, (_, index) => {
        const u = index / 4, x = centerX + side * (u - .5) * .064;
        return [x, centerY + raised + (1 - 2 * u) * shape.browSlope + Math.sin(u * Math.PI) * shape.browArch] as const;
      }), .0034));
    }
  }
  const geometry = mergeGeometries(pieces)!; pieces.forEach(piece => piece.dispose());
  return geometry;
}

function morphGeometry(species: OfficeCharacterSpecies, part: 'mouth' | 'brows') {
  const geometry = expressionGeometry(species, 'neutral', part);
  geometry.name = `office-${species}-expression-${part}`;
  geometry.morphAttributes.position = [];
  geometry.morphAttributes.normal = [];
  for (const kind of KINDS) {
    const target = expressionGeometry(species, kind, part);
    geometry.morphAttributes.position.push(target.getAttribute('position'));
    geometry.morphAttributes.normal.push(target.getAttribute('normal'));
    target.dispose();
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export function createOfficeExpression(resources: Pick<OfficeResources, 'geometry' | 'material'>,
  head: THREE.Group, muzzle: THREE.Group, eyes: THREE.Group, species: OfficeCharacterSpecies): OfficeExpressionRig {
  const material = resources.material('character-expression-lines', { color: 0x66554b, roughness: .85 });
  const mouth = new THREE.Mesh(resources.geometry(`character-expression-mouth:${species}`, () => morphGeometry(species, 'mouth')), material);
  mouth.name = 'animal-mouth'; mouth.receiveShadow = true; muzzle.add(mouth);
  const brows = new THREE.Mesh(resources.geometry(`character-expression-brows:${species}`, () => morphGeometry(species, 'brows')), material);
  brows.name = 'animal-brows'; brows.receiveShadow = true; head.add(brows);
  const rig: OfficeExpressionRig = { mouth, brows, species, current: 'neutral',
    eyes: [eyes.getObjectByName('animal-eye-left') as THREE.Mesh, eyes.getObjectByName('animal-eye-right') as THREE.Mesh] };
  applyOfficeExpression(rig, 'unknown');
  return rig;
}

/** Call after motion: per-eye openness composes with the existing eye Group blink. */
export function applyOfficeExpression(rig: OfficeExpressionRig, state: OfficeAgentState, action: OfficeActionKind = 'unreported') {
  const kind = officeExpressionKind(state, action), target = KINDS.indexOf(kind), shape = SHAPES[kind];
  rig.mouth.morphTargetInfluences!.fill(0); rig.mouth.morphTargetInfluences![target] = 1;
  rig.brows.morphTargetInfluences!.fill(0); rig.brows.morphTargetInfluences![target] = 1;
  for (let index = 0; index < 2; index++) {
    rig.eyes[index].scale.y = CHARACTER_FACE_FEATURES[rig.species].eyeScale[1] * shape.openness[index];
  }
  rig.current = kind;
}
