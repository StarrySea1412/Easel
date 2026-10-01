/**
 * Original Easel character study, authored as editable surface profiles.
 * Run: node web/frontend/src/assets/office-character/make-character.mjs
 * No downloaded models or textures. All deformable surfaces carry real skin weights.
 */
import * as THREE from '../../../node_modules/three/build/three.module.js';
import { GLTFExporter } from '../../../node_modules/three/examples/jsm/exporters/GLTFExporter.js';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((result) => { this.result = result; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((result) => { this.result = `data:${blob.type};base64,${Buffer.from(result).toString('base64')}`; this.onloadend?.(); }); }
};

const root = new THREE.Group();
root.name = 'Easel_Studio_Cat_v1';
const bones = [], indices = {}, positions = {};
function joint(name, parent, position) {
  const bone = new THREE.Bone(); bone.name = name;
  positions[name] = new THREE.Vector3(...position);
  bone.position.copy(positions[name]);
  if (parent) { bone.position.sub(positions[parent]); bones[indices[parent]].add(bone); }
  else root.add(bone);
  indices[name] = bones.length; bones.push(bone); return bone;
}
joint('Root', null, [0, 0, 0]);
joint('Hips', 'Root', [0, .66, 0]);
joint('Spine', 'Hips', [0, 1.02, .005]);
joint('Chest', 'Spine', [0, 1.27, .025]);
joint('Head', 'Chest', [0, 1.50, .015]);
joint('Ear_L', 'Head', [-.23, 1.96, -.025]);
joint('Ear_R', 'Head', [.23, 1.96, -.025]);
for (const [side, sign] of [['L', -1], ['R', 1]]) {
  joint(`UpperArm_${side}`, 'Chest', [sign * .245, 1.245, .03]);
  joint(`Forearm_${side}`, `UpperArm_${side}`, [sign * .35, 1.03, .26]);
  joint(`Hand_${side}`, `Forearm_${side}`, [sign * .245, 1.025, .515]);
  for (let f = 0; f < 3; f++) joint(`Finger_${side}_${f}`, `Hand_${side}`, [sign * .245 + (f - 1) * .047, 1.013, .62]);
  joint(`Thumb_${side}`, `Hand_${side}`, [sign * .245 - sign * .071, 1.015, .565]);
  joint(`Thigh_${side}`, 'Hips', [sign * .13, .65, .02]);
  joint(`Shin_${side}`, `Thigh_${side}`, [sign * .15, .53, .335]);
  joint(`Foot_${side}`, `Shin_${side}`, [sign * .17, .20, .40]);
}
joint('TailBase', 'Hips', [0, .68, -.17]);
joint('TailTip', 'TailBase', [-.44, .40, -.14]);
root.updateMatrixWorld(true);
const skeleton = new THREE.Skeleton(bones);
const materials = {
  fur: new THREE.MeshStandardMaterial({ name: 'Fur', color: '#c48a54', roughness: .94 }),
  cream: new THREE.MeshStandardMaterial({ name: 'Face_cream', color: '#f4e5cc', roughness: .96 }),
  cloth: new THREE.MeshStandardMaterial({ name: 'Sweater', color: '#66847a', roughness: 1 }),
  trim: new THREE.MeshStandardMaterial({ name: 'Knit_trim', color: '#d8dcca', roughness: 1 }),
  trousers: new THREE.MeshStandardMaterial({ name: 'Trousers', color: '#404b50', roughness: .94 }),
  sole: new THREE.MeshStandardMaterial({ name: 'Shoe_sole', color: '#d9cbb4', roughness: .98 }),
  shoes: new THREE.MeshStandardMaterial({ name: 'Shoes', color: '#a97e59', roughness: .84 }),
  dark: new THREE.MeshStandardMaterial({ name: 'Eyes', color: '#28312f', roughness: .28 }),
  nose: new THREE.MeshStandardMaterial({ name: 'Nose', color: '#7e5750', roughness: .63 }),
  ear: new THREE.MeshStandardMaterial({ name: 'Inner_ears', color: '#c98b7c', roughness: .97, side: THREE.DoubleSide }),
  stripe: new THREE.MeshStandardMaterial({ name: 'Fur_markings', color: '#9c693e', roughness: 1 }),
  stitch: new THREE.MeshStandardMaterial({ name: 'Stitches', color: '#90a99b', roughness: 1 }),
};

function weighted(names, t = 0) {
  if (names.length === 1) return [[indices[names[0]], 1]];
  const span = Math.min(names.length - 1.000001, Math.max(0, t) * (names.length - 1));
  const index = Math.floor(span), fraction = span - index;
  return [[indices[names[index]], 1 - fraction], [indices[names[index + 1]], fraction]];
}

/** Parametric patch: each row follows an authored cross-section; never a sphere primitive. */
function surface(name, material, rows, columns, sample, skin, blink = false) {
  const vertices = [], uv = [], skinIndices = [], skinWeights = [], faces = [], blinkVertices = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= columns; c++) {
    const u = r / rows, v = c / columns, p = sample(u, v);
    vertices.push(...p); uv.push(v, u);
    const weights = skin(u, v, p);
    skinIndices.push(...Array.from({ length: 4 }, (_, i) => weights[i]?.[0] ?? 0));
    skinWeights.push(...Array.from({ length: 4 }, (_, i) => weights[i]?.[1] ?? 0));
    if (blink) blinkVertices.push(p[0], 1.805 + (p[1] - 1.805) * .075, p[2]);
    if (r < rows && c < columns) {
      const a = r * (columns + 1) + c, b = a + 1, d = a + columns + 1, e = d + 1;
      faces.push(a, b, d, b, e, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(faces); geometry.computeVertexNormals();
  if (blink) {
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(blinkVertices, 3)];
    geometry.morphAttributes.position[0].name = 'Blink';
  }
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true;
  root.add(mesh); mesh.bind(skeleton); return mesh;
}

function profile(name, material, points, jointNames, rows = 36, columns = 48) {
  const curve = new THREE.CatmullRomCurve3(points.map(([y, x, z]) => new THREE.Vector3(x, y, z)));
  return surface(name, material, rows, columns, (u, v) => {
    const p = curve.getPoint(u), a = v * Math.PI * 2;
    return [Math.max(.001, p.x) * Math.sin(a), p.y, Math.max(.001, p.z) * Math.cos(a) + .02];
  }, (u) => weighted(jointNames, u));
}

function tube(name, material, points, radii, jointNames, segments = 24, sides = 16, secondaryScale = 1) {
  const path = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return surface(name, material, segments, sides, (u, v) => {
    const center = path.getPoint(u), tangent = path.getTangent(u).normalize();
    const seed = Math.abs(tangent.dot(new THREE.Vector3(0, 0, 1))) > .94 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const x = new THREE.Vector3().crossVectors(seed, tangent).normalize();
    const z = new THREE.Vector3().crossVectors(tangent, x).normalize();
    const ri = Math.min(radii.length - 1.000001, u * (radii.length - 1)), ix = Math.floor(ri);
    const radius = THREE.MathUtils.lerp(radii[ix], radii[ix + 1], ri - ix);
    center.addScaledVector(x, Math.cos(v * Math.PI * 2) * radius).addScaledVector(z, Math.sin(v * Math.PI * 2) * radius * secondaryScale);
    return center.toArray();
  }, (u) => weighted(jointNames, u));
}

// Torso and tailored sweater use a continuous waist–chest–neck contour.
profile('Sweater_body', materials.cloth, [[.65, .10, .07], [.69, .23, .17], [.78, .265, .19], [1.0, .25, .185], [1.2, .25, .17], [1.31, .20, .13], [1.36, .115, .092]], ['Hips', 'Spine', 'Chest']);
profile('Ribbed_hem', materials.trim, [[.66, .215, .164], [.675, .24, .175], [.72, .249, .18], [.733, .244, .178]], ['Hips'], 8);
profile('Crew_neck', materials.trim, [[1.318, .135, .105], [1.345, .132, .10], [1.363, .117, .091]], ['Chest'], 8);
profile('Neck_fur', materials.cream, [[1.345, .092, .077], [1.42, .12, .10], [1.50, .135, .11]], ['Chest', 'Head'], 14);

// Skull profile has authored chin, wide cheek, forehead and crown proportions.
const headProfile = new THREE.CatmullRomCurve3([
  new THREE.Vector3(.012, 1.435, .035), new THREE.Vector3(.17, 1.48, .14),
  new THREE.Vector3(.284, 1.59, .24), new THREE.Vector3(.319, 1.745, .265),
  new THREE.Vector3(.30, 1.88, .241), new THREE.Vector3(.235, 2.00, .174),
  new THREE.Vector3(.08, 2.055, .064), new THREE.Vector3(.001, 2.059, .001),
]);
function headPoint(u, v, offset = 0) {
  const p = headProfile.getPoint(u), a = v * Math.PI * 2;
  const front = Math.max(0, Math.cos(a));
  const muzzle = .053 * Math.exp(-Math.pow((p.y - 1.62) / .092, 2)) * Math.pow(front, 5);
  return [(p.x + offset) * Math.sin(a), p.y, (p.z + offset) * Math.cos(a) + muzzle + .022];
}
surface('Sculpted_cat_head', materials.fur, 56, 80, headPoint, () => weighted(['Head']));
// A conforming cream muzzle patch lies on the same cheek contour.
surface('Cream_cheek_patch', materials.cream, 28, 48, (u, v) => {
  const angle = (v - .5) * 1.64;
  const top = .40 - .065 * Math.cos(angle * 2.5);
  const bottom = .054 + .04 * Math.pow(Math.abs(angle), 2);
  return headPoint(bottom + u * (top - bottom), angle / (Math.PI * 2), .0026);
}, () => weighted(['Head']));

// Ears are curved triangular shells, skinned to individual ear joints.
for (const [side, sign] of [['L', -1], ['R', 1]]) {
  surface(`Ear_shell_${side}`, materials.fur, 24, 28, (u, v) => {
    const width = .097 * Math.pow(1 - u, .66) + .001;
    const theta = v * Math.PI * 2;
    return [sign * (.227 + .077 * u) + width * Math.sin(theta), 1.924 + .322 * u, -.013 + .056 * (1 - u) * Math.cos(theta)];
  }, (u) => weighted(['Head', `Ear_${side}`], Math.min(1, u * 1.6)));
  surface(`Inner_ear_${side}`, materials.ear, 18, 14, (u, v) => {
    const width = .063 * Math.pow(1 - u, .8);
    return [sign * (.236 + .06 * u) + (v * 2 - 1) * width, 1.973 + .215 * u, .043 - u * .038 - Math.pow(v * 2 - 1, 2) * .014];
  }, (u) => weighted(['Head', `Ear_${side}`], Math.min(1, u * 1.6)));
}

// Curved eyes with blink morphs; highlights are baked geometry, not external textures.
for (const sign of [-1, 1]) {
  const x0 = sign * .123;
  surface(`Eye_${sign < 0 ? 'L' : 'R'}`, materials.dark, 12, 30, (u, v) => {
    const a = -v * Math.PI * 2, radial = Math.sin(u * Math.PI / 2);
    const x = x0 + .039 * radial * Math.cos(a), y = 1.805 + .053 * radial * Math.sin(a);
    const z = .277 - Math.pow(x / .35, 2) * .102 + .006 * Math.cos(u * Math.PI / 2);
    return [x, y, z];
  }, () => weighted(['Head']), true);
  surface(`Eye_glint_${sign}`, materials.cream, 5, 12, (u, v) => {
    const a = -v * Math.PI * 2;
    return [x0 - .009 + .010 * u * Math.cos(a), 1.826 + .011 * u * Math.sin(a), .287 - Math.pow(x0 / .35, 2) * .102];
  }, () => weighted(['Head']), true);
  tube(`Brow_${sign}`, materials.stripe, [[x0 - .036, 1.883, .240], [x0, 1.891, .247], [x0 + .029, 1.884, .236]], [.001, .009, .001], ['Head'], 12, 8);
  for (let stripe = 0; stripe < 2; stripe++) {
    tube(`Cheek_mark_${sign}_${stripe}`, materials.stripe,
      [[sign * .270, 1.73 - stripe * .045, .151], [sign * .276, 1.718 - stripe * .045, .163], [sign * .262, 1.706 - stripe * .045, .181]], [.001, .010, .001], ['Head'], 12, 7);
  }
}
// Soft triangular nose and subtle philtrum/mouth, all head-skinned.
surface('Heart_nose', materials.nose, 12, 24, (u, v) => {
  const a = -v * Math.PI * 2, r = Math.sin(u * Math.PI / 2);
  return [.044 * r * Math.cos(a) * (1 + .20 * Math.sin(a)), 1.667 + .026 * r * Math.sin(a), .328 + .015 * Math.cos(u * Math.PI / 2)];
}, () => weighted(['Head']));
tube('Mouth_center', materials.nose, [[0, 1.650, .337], [0, 1.632, .333], [0, 1.622, .326]], [.0035, .004, .003], ['Head'], 8, 7);
for (const sign of [-1, 1]) tube(`Mouth_${sign}`, materials.nose, [[0, 1.624, .328], [sign * .028, 1.613, .322], [sign * .043, 1.628, .325]], [.003, .0035, .001], ['Head'], 12, 7);

for (const [side, sign] of [['L', -1], ['R', 1]]) {
  const upper = `UpperArm_${side}`, fore = `Forearm_${side}`, hand = `Hand_${side}`;
  tube(`Sweater_sleeve_${side}`, materials.cloth, [[sign * .21, 1.257, .025], [sign * .31, 1.16, .10], [sign * .35, 1.04, .255], [sign * .305, 1.022, .392], [sign * .251, 1.025, .496]], [.117, .107, .089, .077, .073], [upper, fore, hand], 36, 24);
  tube(`Cuff_${side}`, materials.trim, [[sign * .266, 1.025, .459], [sign * .252, 1.025, .495], [sign * .244, 1.025, .519]], [.077, .077, .068], [fore, hand], 8, 24);
  tube(`Palm_${side}`, materials.fur, [[sign * .245, 1.025, .510], [sign * .245, 1.023, .564], [sign * .245, 1.013, .618]], [.052, .074, .057], [hand], 18, 20);
  for (let f = 0; f < 3; f++) {
    const x = sign * .245 + (f - 1) * .047, length = f === 1 ? .079 : .067;
    tube(`Finger_${side}_${f}_mesh`, materials.fur, [[x, 1.015, .606], [x, 1.008, .639], [x, .988, .622 + length], [x, .976, .617 + length]], [.025, .025, .019, .002], [hand, `Finger_${side}_${f}`], 16, 12);
    tube(`Finger_crease_${side}_${f}`, materials.stripe, [[x - .013, 1.031, .639], [x, 1.034, .641], [x + .013, 1.031, .639]], [.0008, .002, .0008], [`Finger_${side}_${f}`], 8, 6);
  }
  tube(`Thumb_${side}_mesh`, materials.fur, [[sign * .190, 1.015, .551], [sign * .161, 1.002, .588], [sign * .174, .983, .611]], [.030, .029, .006], [hand, `Thumb_${side}`], 18, 14);
  tube(`Trousers_${side}`, materials.trousers, [[sign * .12, .68, .0], [sign * .145, .58, .23], [sign * .151, .52, .337], [sign * .168, .34, .390], [sign * .17, .21, .404]], [.12, .123, .097, .087, .081], [`Thigh_${side}`, `Shin_${side}`, `Foot_${side}`], 32, 22);
  // Shoes are elongated toe profiles; paired soles create an authored footwear silhouette.
  for (const [key, mat, y, width, depth] of [['upper', materials.shoes, .108, .101, .67], ['sole', materials.sole, .031, .106, .20]]) {
    tube(`Shoe_${key}_${side}`, mat, [[sign * .17, y, .337], [sign * .17, y, .399], [sign * .17, y, .50], [sign * .17, y, .58]], [.002, width, width * .92, .003], [`Foot_${side}`], 24, 20, depth);
  }
}
tube('Tail', materials.fur, [[0, .69, -.168], [-.16, .60, -.27], [-.35, .44, -.27], [-.47, .30, -.12], [-.54, .265, .08], [-.49, .32, .205]], [.073, .085, .087, .072, .054, .001], ['TailBase', 'TailTip'], 42, 20);

// Knit seams follow the garment rather than floating over it.
for (let col = -9; col <= 9; col++) {
  const a = col / 9 * 1.15;
  tube(`Hem_rib_${col}`, materials.stitch, [[.245 * Math.sin(a), .678, .181 * Math.cos(a) + .021], [.246 * Math.sin(a), .719, .183 * Math.cos(a) + .021]], [.0015, .0015], ['Hips'], 3, 5);
}
tube('Sweater_center_seam', materials.stitch, [[0, .77, .215], [0, .98, .210], [0, 1.18, .197]], [.0012, .0018, .0012], ['Hips', 'Spine', 'Chest'], 18, 6);
// Small woven label, using a custom quad instead of an unrelated logo or asset.
surface('Woven_label', materials.trim, 1, 1, (u, v) => [.105 + v * .053, .803 + u * .026, .191], () => weighted(['Hips', 'Spine'], .3));

for (const [name, parent, position] of [
  ['Grip_L', 'Hand_L', [0, -.015, .077]], ['Grip_R', 'Hand_R', [0, -.015, .077]],
  ['Gaze', 'Head', [0, .28, .65]], ['Paper_support_L', 'Hand_L', [0, -.044, .071]],
]) {
  const anchor = new THREE.Object3D(); anchor.name = name; anchor.position.set(...position); bones[indices[parent]].add(anchor);
}

function rotationTrack(name, times, angles, axis = 'x') {
  const values = angles.flatMap((angle) => new THREE.Quaternion().setFromEuler(new THREE.Euler(axis === 'x' ? angle : 0, axis === 'y' ? angle : 0, axis === 'z' ? angle : 0)).toArray());
  return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values);
}
const animations = [
  new THREE.AnimationClip('Read', 5, [rotationTrack('Head', [0, 1.4, 3.8, 5], [.01, -.04, -.04, .01]), rotationTrack('Chest', [0, 1.4, 3.8, 5], [-.01, -.004, .008, -.01], 'y')]),
  new THREE.AnimationClip('Type', 3.6, ['L', 'R'].flatMap((side, index) => [rotationTrack(`Hand_${side}`, [0, .3, .6, .9, 1.2, 2.1, 3.6], [0, .018, -.015, .01, 0, 0, 0].map((a) => a * (index ? -1 : 1))), ...[0, 1, 2].map((f) => rotationTrack(`Finger_${side}_${f}`, [0, .25 + f * .08, .5 + f * .08, .8 + f * .08, 1.5, 2.5, 3.6], [0, .11, 0, .07, 0, .08, 0]))])),
  new THREE.AnimationClip('Review', 4.8, [rotationTrack('Head', [0, 1.2, 2.8, 4.8], [0, -.09, -.09, 0]), rotationTrack('Chest', [0, 1.2, 2.8, 4.8], [0, -.015, -.015, 0])]),
];
root.userData = {
  author: 'Easel project / original procedural surface study',
  license: 'Original project asset; no third-party model or texture inputs.',
  status: 'First rigged character study; requires visual art review before replacing the office cast.',
  proportions: 'Seated cat / meters / Y up / face +Z',
  anchors: ['Grip_L', 'Grip_R', 'Gaze', 'Paper_support_L'],
};
const exporter = new GLTFExporter();
const glb = await exporter.parseAsync(root, { binary: true, animations, onlyVisible: false });
const output = fileURLToPath(new URL('./easel-cat-study.glb', import.meta.url));
await writeFile(output, Buffer.from(glb));
let vertices = 0, triangles = 0, skinnedMeshes = 0;
root.traverse((object) => { if (object.isSkinnedMesh) { skinnedMeshes++; vertices += object.geometry.attributes.position.count; triangles += object.geometry.index.count / 3; } });
const metadata = { format: 'glTF 2.0', generator: 'make-character.mjs', bytes: glb.byteLength, vertices, triangles, skinnedMeshes, bones: bones.map((b) => b.name), animations: animations.map((clip) => clip.name), morphTargets: ['Blink'], anchors: root.userData.anchors, thirdPartyAssets: [] };
await writeFile(fileURLToPath(new URL('./easel-cat-study.manifest.json', import.meta.url)), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify({ output, ...metadata }, null, 2));
