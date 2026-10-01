import * as THREE from 'three';

export type OfficeCharacterSpecies = 'cat' | 'rabbit' | 'fox' | 'bear';

/** y, half-width, forward depth (-Z), rear depth (+Z). Dimensions are in office units. */
type Section = readonly [number, number, number, number];

// Each animal has an authored skull and jaw profile. Head/ear pivots stay
// compatible with the scene, while facial landmarks follow the species anatomy.
const HEAD_PROFILES: Record<OfficeCharacterSpecies, readonly Section[]> = {
  cat: [
    [-.255, 0, 0, 0], [-.219, .122, .090, .098], [-.150, .251, .181, .163],
    [-.064, .300, .218, .207], [.031, .290, .235, .224], [.135, .253, .212, .211],
    [.213, .182, .153, .165], [.250, .086, .070, .076], [.267, 0, 0, 0],
  ],
  rabbit: [
    [-.308, 0, 0, 0], [-.264, .078, .087, .088], [-.167, .170, .174, .166],
    [-.045, .225, .228, .218], [.063, .234, .238, .237], [.183, .199, .205, .215],
    [.269, .133, .139, .147], [.313, .060, .058, .065], [.330, 0, 0, 0],
  ],
  fox: [
    [-.265, 0, 0, 0], [-.230, .082, .082, .078], [-.158, .214, .169, .139],
    [-.085, .324, .220, .188], [.019, .261, .229, .208], [.134, .200, .192, .188],
    [.216, .150, .126, .137], [.267, .069, .056, .062], [.283, 0, 0, 0],
  ],
  bear: [
    [-.288, 0, 0, 0], [-.241, .178, .113, .133], [-.154, .303, .207, .224],
    [-.045, .332, .243, .263], [.042, .326, .244, .267], [.140, .292, .215, .236],
    [.204, .220, .145, .171], [.236, .118, .068, .083], [.252, 0, 0, 0],
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
  padWidth: number;
  padProjection: number;
}

// These volumes deform the skull's own front surface; there are no attached
// muzzle spheres, overlapping patches or extra material-boundary geometry.
const MUZZLES: Record<OfficeCharacterSpecies, MuzzleProfile> = {
  cat: { projection: .033, width: .155, height: .082, centerY: -.078, bridge: .002, creamWidth: .199, creamHeight: .115, creamY: -.109, padWidth: .055, padProjection: .022 },
  rabbit: { projection: .039, width: .085, height: .079, centerY: -.101, bridge: .002, creamWidth: .127, creamHeight: .115, creamY: -.128, padWidth: .032, padProjection: .014 },
  fox: { projection: .177, width: .108, height: .091, centerY: -.067, bridge: .019, creamWidth: .278, creamHeight: .123, creamY: -.119, padWidth: .050, padProjection: 0 },
  bear: { projection: .083, width: .167, height: .103, centerY: -.091, bridge: .002, creamWidth: .202, creamHeight: .134, creamY: -.117, padWidth: .050, padProjection: .005 },
};

function muzzleAt(species: OfficeCharacterSpecies, x: number, y: number, frontness: number) {
  if (frontness <= 0) return { projection: 0, mix: 0 };
  const shape = MUZZLES[species];
  const oval = (x / shape.width) ** (species === 'bear' ? 4 : 2) + ((y - shape.centerY) / shape.height) ** 2;
  const bridge = Math.exp(-2.2 * ((x / .075) ** 2 + ((y + .006) / .105) ** 2));
  // The squared angular falloff gives the original side silhouette a continuous
  // derivative while integrating the nose bridge and mouth into one surface.
  const pads = [-1, 1].reduce((sum, side) => sum + Math.exp(-1.8 * (((x - side * shape.padWidth) / (shape.padWidth * 1.3)) ** 2
    + ((y - shape.centerY + .014) / (shape.height * .72)) ** 2)), 0);
  const projection = (shape.projection * Math.exp(-1.6 * oval) + shape.bridge * bridge + pads * shape.padProjection) * frontness ** 2;
  const creamCenter = shape.creamY + (species === 'fox' ? .14 * (Math.abs(x) / shape.creamWidth) ** 1.5 : 0);
  const creamOval = (x / shape.creamWidth) ** 2 + ((y - creamCenter) / shape.creamHeight) ** 2;
  const mix = (1 - THREE.MathUtils.smoothstep(creamOval, .42, 1.26)) * THREE.MathUtils.smoothstep(frontness, .25, .86);
  return { projection, mix };
}

/** Face landmarks are authored per species; expression animation keeps one eye Group. */
export const CHARACTER_FACE_FEATURES = {
  cat: { eyeX: .119, eyeY: .032, eyeScale: [.91, 1.06, .58], eyeTilt: .06, noseY: -.070, noseScale: [.87, .57, .53], mouthWidth: .054, mouthDrop: .038, cheekX: .216, cheekY: -.065 },
  rabbit: { eyeX: .098, eyeY: .047, eyeScale: [.76, 1.23, .57], eyeTilt: -.035, noseY: -.099, noseScale: [.64, .50, .45], mouthWidth: .035, mouthDrop: .032, cheekX: .166, cheekY: -.090 },
  fox: { eyeX: .119, eyeY: .043, eyeScale: [1.02, .71, .49], eyeTilt: -.15, noseY: -.063, noseScale: [1.00, .64, .73], mouthWidth: .065, mouthDrop: .034, cheekX: .237, cheekY: -.078 },
  bear: { eyeX: .132, eyeY: .020, eyeScale: [.74, .80, .58], eyeTilt: 0, noseY: -.083, noseScale: [1.47, .87, .69], mouthWidth: .047, mouthDrop: .048, cheekX: .246, cheekY: -.064 },
} as const;

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

// Ear-local surfaces attach to the existing pivot at head (±.2, .22, 0).
// Roots extend into the skull; each species has its own silhouette and thickness.
const EAR_PROFILES: Record<OfficeCharacterSpecies, readonly Section[]> = {
  cat: [
    [-.064, 0, 0, 0], [-.041, .074, .041, .056], [0, .113, .065, .075],
    [.050, .116, .074, .066], [.109, .090, .059, .047], [.180, .055, .037, .029],
    [.243, .020, .016, .013], [.280, 0, 0, 0],
  ],
  rabbit: [
    [-.082, 0, 0, 0], [-.048, .046, .039, .048], [.012, .066, .056, .060],
    [.112, .085, .063, .055], [.237, .083, .057, .045], [.342, .067, .042, .033],
    [.417, .039, .021, .020], [.467, 0, 0, 0],
  ],
  fox: [
    [-.065, 0, 0, 0], [-.038, .080, .045, .059], [.010, .130, .073, .078],
    [.068, .119, .080, .063], [.147, .086, .060, .046], [.227, .047, .034, .026],
    [.285, .017, .013, .011], [.316, 0, 0, 0],
  ],
  bear: [
    [-.108, 0, 0, 0], [-.082, .070, .045, .061], [-.038, .109, .075, .086],
    [.021, .126, .082, .086], [.078, .112, .065, .063], [.128, .071, .036, .037],
    [.159, 0, 0, 0],
  ],
};

// Curved fox brush radius: narrow at the pelvis, full at mid-length, then a
// continuously tapering tip. The curve itself is authored below in tail-local space.
const FOX_TAIL_RADII: readonly Section[] = [
  [0, 0, 0, 0], [.045, .045, .045, .045], [.14, .082, .082, .082],
  [.31, .130, .130, .130], [.47, .148, .148, .148], [.63, .131, .131, .131],
  [.77, .093, .093, .093], [.90, .046, .046, .046], [1, 0, 0, 0],
];

// Body-local short neck: lower rings bury into the actual shirt neckline, while
// upper rings stay inside the skull throughout the supported head rotation range.
const NECK_PROFILE: readonly Section[] = [
  [.453, 0, 0, 0], [.477, .063, .040, .046], [.501, .083, .058, .065],
  [.534, .091, .069, .077], [.578, .094, .076, .083], [.625, .106, .089, .097],
  [.675, .117, .096, .103], [.724, 0, 0, 0],
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
 * One 816-triangle closed short neck at the body origin, not on the head pivot.
 * Hidden ends overlap clothing and skull; the visible middle bridges the seam
 * when looking down or sideways. `neckFurMix` softly joins shirt and fur colors.
 * Caller caches and owns this geometry, as with the other authored surfaces.
 */
export function createCharacterNeckGeometry(species: OfficeCharacterSpecies = 'cat'): THREE.BufferGeometry {
  const width = { cat: 1, rabbit: .83, fox: .93, bear: 1.17 }[species];
  const sections = NECK_PROFILE.map(([y, x, front, back]): Section => [y, x * width, front * width, back * width]);
  const geometry = buildForm(sections, 18, 24, `office-${species}-neck`);
  const position = geometry.getAttribute('position'), mix: number[] = [];
  for (let vertex = 0; vertex < position.count; vertex++) mix.push(THREE.MathUtils.smoothstep(position.getY(vertex), .493, .531));
  geometry.setAttribute('neckFurMix', new THREE.Float32BufferAttribute(mix, 1));
  return geometry;
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

/**
 * One closed, cupped ear with a thick root and a thin rounded tip. Faces -Z.
 * `earInnerMix` colors the recessed front only; `earTipMix` gives fox ears their
 * darker tips. Both are smooth 0..1 fields and need one mesh/material per ear.
 * Already sized for the existing ear Group; caller owns/caches the geometry.
 */
export function createCharacterEarGeometry(species: OfficeCharacterSpecies = 'cat'): THREE.BufferGeometry {
  const sections = EAR_PROFILES[species], rings = species === 'rabbit' ? 32 : 24, segments = 32;
  const geometry = buildForm(sections, rings, segments, `office-${species}-ear-shell`);
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
  const innerMix: number[] = [], tipMix: number[] = [];
  for (let vertex = 0; vertex < position.count; vertex++) {
    const y = position.getY(vertex), v = uv.getY(vertex);
    const frontness = Math.max(0, -Math.cos(uv.getX(vertex) * Math.PI * 2));
    const frontDepth = profileAt(sections, y)[1];
    const bowl = THREE.MathUtils.smoothstep(v, .12, .36) * (1 - THREE.MathUtils.smoothstep(v, .77, .97));
    // Recess the center of the front, keeping a full rim and an uninterrupted back.
    // The bowl never crosses the back: at its deepest it retains 22% front depth.
    const cup = frontDepth * .78 * frontness ** 3 * bowl;
    const bend = (species === 'rabbit' ? .056 : species === 'bear' ? .013 : .032) * v ** 2;
    position.setZ(vertex, position.getZ(vertex) + cup + bend);
    innerMix.push(THREE.MathUtils.smoothstep(frontness, .50, .88)
      * THREE.MathUtils.smoothstep(v, .17, .36) * (1 - THREE.MathUtils.smoothstep(v, .73, .91)));
    tipMix.push(species === 'fox' ? THREE.MathUtils.smoothstep(v, .57, .88) : 0);
  }
  geometry.setAttribute('earInnerMix', new THREE.Float32BufferAttribute(innerMix, 1));
  geometry.setAttribute('earTipMix', new THREE.Float32BufferAttribute(tipMix, 1));
  smoothFormNormals(geometry, rings, segments);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A single closed curved fox brush attached at the existing tail Group origin.
 * `tailTipMix` blends fur into cream along the same surface, avoiding a seam or
 * overlapping white cap. 1,488 triangles; caller owns/caches this geometry.
 */
export function createCharacterFoxTailGeometry(): THREE.BufferGeometry {
  const rings = 32, segments = 24;
  const geometry = buildForm(FOX_TAIL_RADII, rings, segments, 'office-fox-tail-shell');
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -.025, .005), new THREE.Vector3(.100, -.014, .074),
    new THREE.Vector3(.243, .040, .121), new THREE.Vector3(.382, .133, .133),
    new THREE.Vector3(.480, .239, .106),
  ]);
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv'), tipMix: number[] = [];
  const across = new THREE.Vector3(), binormal = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (let vertex = 0; vertex < position.count; vertex++) {
    const t = uv.getY(vertex), center = curve.getPoint(t), tangent = curve.getTangent(t).normalize();
    // A stable frame: the authored curve never runs parallel to the Y axis.
    // across × binormal = -tangent, matching the outward winding of buildForm.
    across.crossVectors(up, tangent).normalize(); binormal.crossVectors(across, tangent).normalize();
    const x = position.getX(vertex), z = position.getZ(vertex) * .91;
    position.setXYZ(vertex, center.x + across.x * x + binormal.x * z,
      center.y + across.y * x + binormal.y * z, center.z + across.z * x + binormal.z * z);
    tipMix.push(THREE.MathUtils.smoothstep(t, .67, .86));
  }
  geometry.setAttribute('tailTipMix', new THREE.Float32BufferAttribute(tipMix, 1));
  smoothFormNormals(geometry, rings, segments);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}
