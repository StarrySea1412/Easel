import * as THREE from 'three';

export type OfficeCharacterSpecies = 'cat' | 'rabbit' | 'fox' | 'bear';

/** y, half-width, forward depth (-Z), rear depth (+Z). Dimensions are in office units. */
type Section = readonly [number, number, number, number];

// Each animal has an authored skull and jaw profile. Eye and ear attachment
// locations stay compatible with the existing scene; species do not share a skull.
const HEAD_PROFILES: Record<OfficeCharacterSpecies, readonly Section[]> = {
  cat: [
    [-.286, 0, 0, 0], [-.250, .120, .095, .104], [-.180, .245, .190, .180],
    [-.078, .309, .253, .237], [.034, .317, .267, .270], [.147, .282, .239, .254],
    [.237, .204, .169, .198], [.287, .104, .081, .098], [.308, 0, 0, 0],
  ],
  rabbit: [
    [-.307, 0, 0, 0], [-.263, .105, .093, .101], [-.165, .217, .207, .199],
    [-.043, .264, .270, .257], [.047, .266, .273, .268], [.163, .236, .232, .244],
    [.253, .171, .155, .179], [.309, .075, .063, .079], [.332, 0, 0, 0],
  ],
  fox: [
    [-.275, 0, 0, 0], [-.238, .101, .099, .090], [-.171, .216, .189, .164],
    [-.077, .329, .253, .226], [.032, .291, .269, .251], [.147, .241, .224, .234],
    [.235, .178, .151, .177], [.284, .086, .069, .085], [.307, 0, 0, 0],
  ],
  bear: [
    [-.268, 0, 0, 0], [-.228, .169, .117, .130], [-.143, .284, .209, .218],
    [-.037, .334, .260, .278], [.052, .336, .266, .286], [.154, .291, .230, .255],
    [.229, .209, .151, .184], [.270, .111, .071, .088], [.291, 0, 0, 0],
  ],
};

interface MuzzleProfile {
  projection: number;
  width: number;
  height: number;
  centerY: number;
  bridge: number;
  creamWidth: number;
  creamHeight: number;
  creamY: number;
}

// These volumes deform the skull's own front surface; there are no attached
// muzzle spheres, overlapping patches or extra material-boundary geometry.
const MUZZLES: Record<OfficeCharacterSpecies, MuzzleProfile> = {
  cat: { projection: .066, width: .166, height: .091, centerY: -.082, bridge: .004, creamWidth: .226, creamHeight: .143, creamY: -.113 },
  rabbit: { projection: .049, width: .104, height: .083, centerY: -.075, bridge: .003, creamWidth: .164, creamHeight: .134, creamY: -.106 },
  fox: { projection: .140, width: .119, height: .101, centerY: -.067, bridge: .013, creamWidth: .269, creamHeight: .153, creamY: -.116 },
  bear: { projection: .071, width: .178, height: .105, centerY: -.078, bridge: .003, creamWidth: .215, creamHeight: .140, creamY: -.100 },
};

function muzzleAt(species: OfficeCharacterSpecies, x: number, y: number, frontness: number) {
  if (frontness <= 0) return { projection: 0, mix: 0 };
  const shape = MUZZLES[species];
  const oval = (x / shape.width) ** 2 + ((y - shape.centerY) / shape.height) ** 2;
  const bridge = Math.exp(-2.2 * ((x / .075) ** 2 + ((y + .006) / .105) ** 2));
  // The squared angular falloff gives the original side silhouette a continuous
  // derivative while integrating the nose bridge and mouth into one surface.
  const projection = (shape.projection * Math.exp(-1.6 * oval) + shape.bridge * bridge) * frontness ** 2;
  const creamOval = (x / shape.creamWidth) ** 2 + ((y - shape.creamY) / shape.creamHeight) ** 2;
  const mix = (1 - THREE.MathUtils.smoothstep(creamOval, .42, 1.26)) * THREE.MathUtils.smoothstep(frontness, .25, .86);
  return { projection, mix };
}

// Tailored silhouette: broad shoulder, natural chest/abdomen, defined waist and
// closed hem. Forearm contacts and shoulder joint positions are not moved.
const TORSO_PROFILES: Record<OfficeCharacterSpecies, readonly Section[]> = {
  cat: [
    [0, 0, 0, 0], [.019, .161, .112, .119], [.043, .226, .153, .156],
    [.082, .239, .166, .176], [.192, .253, .191, .195], [.309, .242, .193, .181],
    [.392, .239, .170, .158], [.432, .246, .142, .142], [.469, .191, .111, .110],
    [.510, .096, .056, .062], [.532, 0, 0, 0],
  ],
  rabbit: [
    [0, 0, 0, 0], [.020, .141, .100, .107], [.044, .205, .142, .145],
    [.090, .219, .151, .162], [.195, .228, .175, .180], [.308, .222, .189, .169],
    [.394, .227, .166, .147], [.435, .242, .139, .133], [.476, .175, .100, .099],
    [.516, .081, .050, .052], [.540, 0, 0, 0],
  ],
  fox: [
    [0, 0, 0, 0], [.020, .134, .098, .108], [.045, .207, .138, .146],
    [.086, .216, .151, .167], [.190, .216, .172, .180], [.309, .227, .190, .170],
    [.397, .239, .168, .152], [.435, .245, .139, .137], [.473, .178, .105, .101],
    [.512, .084, .051, .057], [.534, 0, 0, 0],
  ],
  bear: [
    [0, 0, 0, 0], [.020, .180, .120, .128], [.045, .242, .161, .166],
    [.085, .253, .179, .188], [.193, .265, .198, .206], [.308, .254, .195, .188],
    [.385, .255, .173, .163], [.428, .260, .147, .148], [.466, .204, .117, .115],
    [.503, .108, .063, .068], [.526, 0, 0, 0],
  ],
};

// One seated limb: hem-hidden thigh → bent knee → ankle → extended forefoot.
// The front/rear depths describe an asymmetric shoe/paw section, not two balls.
const LEG_PROFILES: readonly Section[] = [
  [-.384, 0, 0, 0], [-.375, .091, .154, .100], [-.354, .103, .159, .104],
  [-.321, .106, .157, .102], [-.287, .095, .118, .089], [-.253, .079, .068, .073],
  [-.191, .086, .078, .091], [-.122, .107, .123, .128], [-.061, .111, .143, .146],
  [.023, .107, .104, .105], [.060, .071, .060, .068], [.080, 0, 0, 0],
];

// Positive depth below is subtracted from Z after creating the ring surface.
const LEG_CENTER_DEPTH: readonly Section[] = [
  [-.384, .255, .255, .255], [-.340, .255, .255, .255], [-.290, .235, .235, .235],
  [-.240, .205, .205, .205], [-.160, .158, .158, .158], [-.085, .115, .115, .115],
  [0, .064, .064, .064], [.080, 0, 0, 0],
];

/** Shape-preserving Hermite interpolation: it cannot bulge beyond authored sections. */
function profileAt(sections: readonly Section[], y: number): [number, number, number] {
  let i = 0;
  while (i < sections.length - 2 && y > sections[i + 1][0]) i++;
  const left = sections[i], right = sections[i + 1], span = right[0] - left[0];
  const t = THREE.MathUtils.clamp((y - left[0]) / span, 0, 1);
  const result: number[] = [];
  for (let axis = 1; axis < 4; axis++) {
    const secant = (right[axis] - left[axis]) / span;
    const previous = i > 0 ? (left[axis] - sections[i - 1][axis]) / (left[0] - sections[i - 1][0]) : secant;
    const next = i + 2 < sections.length ? (sections[i + 2][axis] - right[axis]) / (sections[i + 2][0] - right[0]) : secant;
    const tangent = (a: number, b: number) => a * b <= 0 ? 0 : 2 * a * b / (a + b);
    const m0 = tangent(previous, secant) * span, m1 = tangent(secant, next) * span;
    const value = (2 * t ** 3 - 3 * t ** 2 + 1) * left[axis] + (t ** 3 - 2 * t ** 2 + t) * m0
      + (-2 * t ** 3 + 3 * t ** 2) * right[axis] + (t ** 3 - t ** 2) * m1;
    result.push(Math.max(0, value));
  }
  return result as [number, number, number];
}

/** Closed ring surface with shared poles and duplicated UV seam, no degenerate caps. */
function buildForm(sections: readonly Section[], ringCount: number, segments: number, name: string, faceSpecies?: OfficeCharacterSpecies) {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [], muzzleMix: number[] = [];
  const minY = sections[0][0], maxY = sections[sections.length - 1][0];
  positions.push(0, minY, 0); uvs.push(.5, 0); muzzleMix.push(0);
  for (let ring = 1; ring < ringCount; ring++) {
    const v = ring / ringCount, y = THREE.MathUtils.lerp(minY, maxY, v);
    const [radiusX, forward, rear] = profileAt(sections, y);
    for (let side = 0; side <= segments; side++) {
      const u = side / segments, angle = u * Math.PI * 2, cosine = Math.cos(angle);
      const x = radiusX * Math.sin(angle);
      const muzzle = faceSpecies ? muzzleAt(faceSpecies, x, y, Math.max(0, -cosine)) : { projection: 0, mix: 0 };
      positions.push(x, y, (cosine < 0 ? forward : rear) * cosine - muzzle.projection);
      muzzleMix.push(muzzle.mix);
      uvs.push(u, v);
    }
  }
  const top = positions.length / 3;
  positions.push(0, maxY, 0); uvs.push(.5, 1); muzzleMix.push(0);
  for (let side = 0; side < segments; side++) indices.push(0, 1 + side + 1, 1 + side);
  for (let ring = 0; ring < ringCount - 2; ring++) for (let side = 0; side < segments; side++) {
    const a = 1 + ring * (segments + 1) + side, b = a + 1, c = a + segments + 1, d = c + 1;
    indices.push(a, b, c, b, d, c);
  }
  const lastRing = 1 + (ringCount - 2) * (segments + 1);
  for (let side = 0; side < segments; side++) indices.push(lastRing + side, lastRing + side + 1, top);
  const geometry = new THREE.BufferGeometry();
  geometry.name = name;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (faceSpecies) geometry.setAttribute('muzzleMix', new THREE.Float32BufferAttribute(muzzleMix, 1));
  geometry.setIndex(indices);
  smoothFormNormals(geometry, ringCount, segments);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

function smoothFormNormals(geometry: THREE.BufferGeometry, ringCount: number, segments: number) {
  geometry.computeVertexNormals();
  // Averaging the duplicated UV seam prevents a visible line in smooth lighting.
  const normals = geometry.getAttribute('normal');
  const seam = new THREE.Vector3();
  for (let ring = 0; ring < ringCount - 1; ring++) {
    const first = 1 + ring * (segments + 1), last = first + segments;
    seam.set(normals.getX(first) + normals.getX(last), normals.getY(first) + normals.getY(last), normals.getZ(first) + normals.getZ(last)).normalize();
    normals.setXYZ(first, seam.x, seam.y, seam.z); normals.setXYZ(last, seam.x, seam.y, seam.z);
  }
}

/**
 * Original skull, centered at the existing head origin and facing -Z.
 * 3,744 triangles. Already sized; do not apply the old ellipsoid scale again.
 * The mouth and muzzle are part of this single closed surface. `muzzleMix` is a
 * smooth 0..1 color weight: caller may lerp fur/cream into a vertex `color` attribute.
 * Use characterFaceSurface to attach eyes/nose/blush instead of fixed Z constants.
 * Ownership: caller caches and disposes this newly allocated geometry.
 */
export function createCharacterHeadGeometry(species: OfficeCharacterSpecies = 'cat'): THREE.BufferGeometry {
  return buildForm(HEAD_PROFILES[species], 40, 48, `office-${species}-head`, species);
}

/**
 * Continuous front surface Z in head-local space, facing -Z. Subtract a small
 * clearance from the returned Z to place an eye/nose/decal ahead of the face.
 * This samples the authored surface; polygon interpolation differs by <.003
 * around the intended eye, nose and cheek anchors at the current tessellation.
 * Out-of-silhouette/non-finite coordinates throw instead of hiding a bad anchor.
 */
export function characterFaceSurface(species: OfficeCharacterSpecies, x: number, y: number): number {
  const sections = HEAD_PROFILES[species];
  if (!sections || !Number.isFinite(x) || !Number.isFinite(y) || y < sections[0][0] || y > sections[sections.length - 1][0]) {
    throw new RangeError('Face anchor must be finite and inside the authored head silhouette.');
  }
  const [radiusX, forward] = profileAt(sections, y);
  if (Math.abs(x) > radiusX + 1e-9) throw new RangeError('Face anchor lies outside this species’ head silhouette.');
  if (radiusX < 1e-9) return 0;
  const frontness = Math.sqrt(Math.max(0, 1 - (x / radiusX) ** 2));
  return -forward * frontness - muzzleAt(species, x, y, frontness).projection;
}

/**
 * Closed clothing surface, authored around (0, .26, 0) in body-local space.
 * 720 triangles. Attach at body origin, not again at y=.26; no additional scale.
 * The original shoulder, collar and badge anchors are kept compatible.
 * Ownership: caller caches and disposes this newly allocated geometry.
 */
export function createCharacterTorsoGeometry(species: OfficeCharacterSpecies = 'cat'): THREE.BufferGeometry {
  return buildForm(TORSO_PROFILES[species], 16, 24, `office-${species}-torso`);
}

/**
 * One continuous seated leg/paw, centered at local X=0; attach at the existing
 * left/right hip X offset. Top y=.08 is hidden inside the torso, foot sole y=-.384
 * rests on the existing foot support at -.385, toe reaches approximately z=-.415.
 * 1,400 triangles, one closed shell, static (no skinning required).
 * `trousersMix` is 1 on the upper leg, smoothly becoming 0 on the lower paw;
 * caller can create vertex colors from trousers/fur without a separate cuff mesh.
 * Ownership: caller caches and disposes this newly allocated geometry.
 */
export function createCharacterLegGeometry(): THREE.BufferGeometry {
  const rings = 26, segments = 28;
  const geometry = buildForm(LEG_PROFILES, rings, segments, 'office-continuous-seated-leg');
  const position = geometry.getAttribute('position'), trousersMix: number[] = [];
  for (let vertex = 0; vertex < position.count; vertex++) {
    const sourceY = position.getY(vertex);
    const depth = profileAt(LEG_CENTER_DEPTH, sourceY)[0];
    // The pole and its first ring share one Y plane, creating a closed, flat sole.
    // Side rings remain distinct: no stacked internal surfaces or degenerate faces.
    const y = vertex > 0 && vertex <= segments + 1 ? -.384 : sourceY;
    position.setXYZ(vertex, position.getX(vertex), y, position.getZ(vertex) - depth);
    trousersMix.push(THREE.MathUtils.smoothstep(y, -.260, -.208));
  }
  geometry.setAttribute('trousersMix', new THREE.Float32BufferAttribute(trousersMix, 1));
  smoothFormNormals(geometry, rings, segments);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}
