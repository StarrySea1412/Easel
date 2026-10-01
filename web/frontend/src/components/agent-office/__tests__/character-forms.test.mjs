import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { CHARACTER_FACE_FEATURES, createCharacterHeadGeometry, createCharacterTorsoGeometry, createCharacterLegGeometry, createCharacterEarGeometry, createCharacterFoxTailGeometry, createCharacterNeckGeometry, characterFaceSurface } = await loadTsModule('../officeCharacterForms.ts', import.meta.url);
const { OfficeResources, createOfficeWorld, createOfficeAvatar, poseOfficeAvatar } = await loadTsModule('../officeGeometry.ts', import.meta.url);
const species = ['cat', 'rabbit', 'fox', 'bear'];

function validateClosedSurface(geometry, triangleBudget, minimumVolume = .01) {
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv'), index = geometry.getIndex();
  assert.equal(position.count, normal.count); assert.equal(position.count, uv.count);
  assert.ok(index.count / 3 < triangleBudget);
  const welded = new Map(), vertexIds = [], edgeUses = new Map();
  for (let vertex = 0; vertex < position.count; vertex++) {
    const point = new THREE.Vector3().fromBufferAttribute(position, vertex);
    const direction = new THREE.Vector3().fromBufferAttribute(normal, vertex);
    assert.ok([...point, ...direction, uv.getX(vertex), uv.getY(vertex)].every(Number.isFinite));
    assert.ok(Math.abs(direction.length() - 1) < 1e-5, 'lighting normals are normalized');
    assert.ok(uv.getX(vertex) >= 0 && uv.getX(vertex) <= 1 && uv.getY(vertex) >= 0 && uv.getY(vertex) <= 1);
    const key = point.toArray().map((value) => Math.round(value * 1e7)).join(',');
    if (!welded.has(key)) welded.set(key, welded.size);
    vertexIds.push(welded.get(key));
  }
  let signedVolume = 0;
  for (let face = 0; face < index.count; face += 3) {
    const ids = [index.getX(face), index.getX(face + 1), index.getX(face + 2)];
    const [a, b, c] = ids.map((id) => new THREE.Vector3().fromBufferAttribute(position, id));
    const cross = b.clone().sub(a).cross(c.clone().sub(a));
    assert.ok(cross.lengthSq() > 1e-12, 'pole caps have no zero-area triangles');
    signedVolume += a.dot(b.clone().cross(c)) / 6;
    for (let side = 0; side < 3; side++) {
      const endpoints = [vertexIds[ids[side]], vertexIds[ids[(side + 1) % 3]]].sort((x, y) => x - y);
      const key = endpoints.join(':'); edgeUses.set(key, (edgeUses.get(key) || 0) + 1);
    }
  }
  assert.ok([...edgeUses.values()].every((uses) => uses === 2), 'all geometric edges close after welding only the UV seam');
  assert.ok(signedVolume > minimumVolume, 'winding points outward and encloses positive volume');
  assert.equal(welded.size - edgeUses.size + index.count / 3, 2, 'the surface is one closed genus-zero shell');
}

function frontAt(geometry, x, y) {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material); mesh.updateMatrixWorld(true);
  const hits = new THREE.Raycaster(new THREE.Vector3(x, y, -1), new THREE.Vector3(0, 0, 1)).intersectObject(mesh);
  material.dispose(); assert.ok(hits.length > 0, `surface exists at ${x}, ${y}`);
  return hits[0].point.z;
}

function widthAt(geometry, y) {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material); mesh.updateMatrixWorld(true);
  const hits = new THREE.Raycaster(new THREE.Vector3(-1, y, 0), new THREE.Vector3(1, 0, 0)).intersectObject(mesh);
  material.dispose(); assert.ok(hits.length > 0);
  return -2 * hits[0].point.x;
}

test('four authored head and torso shells are closed, finite, UV mapped and within triangle budgets', () => {
  for (const animal of species) {
    const head = createCharacterHeadGeometry(animal), torso = createCharacterTorsoGeometry(animal);
    validateClosedSurface(head, 6000); validateClosedSurface(torso, 1000);
    const headSize = head.boundingBox.getSize(new THREE.Vector3()), torsoSize = torso.boundingBox.getSize(new THREE.Vector3());
    assert.ok(headSize.x >= .46 && headSize.x <= .69 && headSize.y >= .51 && headSize.y <= .65, `${animal}: compatible skull scale`);
    assert.ok(torsoSize.x >= .44 && torsoSize.x <= .55 && torsoSize.y >= .51 && torsoSize.y <= .55, `${animal}: compatible seated torso`);
    assert.equal(torso.boundingBox.min.y, 0, 'hem closes at body origin');
    head.dispose(); torso.dispose();
  }
});

test('face attachment API follows the integrated surface and clothing anchors remain compatible', () => {
  for (const animal of species) {
    const head = createCharacterHeadGeometry(animal), torso = createCharacterTorsoGeometry(animal);
    const features = CHARACTER_FACE_FEATURES[animal];
    for (const [x, y] of [[-features.eyeX, features.eyeY], [features.eyeX, features.eyeY], [0, features.noseY],
      [-features.cheekX, features.cheekY], [features.cheekX, features.cheekY], [.064, -.072]]) {
      const authoredZ = characterFaceSurface(animal, x, y), polygonZ = frontAt(head, x, y);
      assert.ok(Math.abs(authoredZ - polygonZ) < .003, `${animal}: attachment follows the actual cheek/nose/eye surface (${x}, ${y})`);
      assert.ok(authoredZ - .008 < polygonZ, 'placing at returned Z minus clearance stays in front of the mesh');
    }
    const nose = characterFaceSurface(animal, 0, features.noseY), forehead = characterFaceSurface(animal, 0, .12);
    const minimumProjection = { cat: .040, rabbit: .026, fox: .17, bear: .080 };
    assert.ok(nose < forehead - minimumProjection[animal], `${animal}: its authored muzzle projects from the skull itself`);
    const badge = frontAt(torso, .11, .31);
    assert.ok(badge > -.184 && badge < -.152, `${animal}: existing badge at -.187 remains readable (${badge})`);
    const collar = frontAt(torso, .067, .46);
    assert.ok(collar > -.149 && collar < -.077, `${animal}: existing collar stays above clothing (${collar})`);
    head.dispose(); torso.dispose();
  }
});

test('muzzle is one continuous manifold with a soft vertex-color field rather than attached shapes', () => {
  const projections = {};
  for (const animal of species) {
    const head = createCharacterHeadGeometry(animal), position = head.getAttribute('position'), mix = head.getAttribute('muzzleMix');
    assert.equal(mix.count, position.count);
    let cream = 0, transition = 0;
    for (let index = 0; index < mix.count; index++) {
      const value = mix.getX(index);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
      if (position.getZ(index) >= 0) assert.equal(value, 0, 'the cream mask never leaks onto the back of the head');
      if (value > .95) cream++;
      if (value > .05 && value < .95) transition++;
    }
    assert.ok(cream > 10 && transition > 40, 'cream center and gradual edge both have useful sampled coverage');
    assert.equal(head.groups.length, 0, 'color transitions need no separately attached/material-split muzzle');
    // Sample through the cheek-to-mouth transition to detect discontinuities.
    let previous = characterFaceSurface(animal, .055, -.20);
    for (let y = -.199; y < .1; y += .001) {
      const next = characterFaceSurface(animal, .055, y);
      assert.ok(Math.abs(next - previous) < .006, 'mouth transition does not jump at a patch boundary');
      previous = next;
    }
    projections[animal] = -characterFaceSurface(animal, 0, -.067);
    head.dispose();
  }
  assert.ok(projections.fox > projections.cat + .055 && projections.fox > projections.bear + .045, 'fox has a longer authored muzzle, not larger attached balls');
  assert.ok(projections.rabbit < projections.bear, 'rabbit keeps a finer, shorter muzzle than bear');
});

test('face attachment API rejects invalid or off-silhouette anchors', () => {
  assert.throws(() => characterFaceSurface('cat', .9, .03), RangeError);
  assert.throws(() => characterFaceSurface('fox', 0, 2), RangeError);
  assert.throws(() => characterFaceSurface('bear', Number.NaN, 0), RangeError);
});

test('species change jaw/forehead and shoulder/waist proportions rather than just head scale or ears', () => {
  const headRatios = new Set(), torsoRatios = new Set();
  const widths = {};
  for (const animal of species) {
    const head = createCharacterHeadGeometry(animal), torso = createCharacterTorsoGeometry(animal);
    const cheek = widthAt(head, -.075), forehead = widthAt(head, .155);
    const waist = widthAt(torso, .19), shoulder = widthAt(torso, .435);
    headRatios.add((cheek / forehead).toFixed(3)); torsoRatios.add((waist / shoulder).toFixed(3));
    widths[animal] = { cheek, forehead, waist, shoulder, height: head.boundingBox.max.y - head.boundingBox.min.y };
    head.dispose(); torso.dispose();
  }
  assert.equal(headRatios.size, 4); assert.equal(torsoRatios.size, 4);
  assert.ok(widths.fox.cheek / widths.fox.forehead > widths.cat.cheek / widths.cat.forehead, 'fox has a stronger cheek-to-brow wedge');
  assert.ok(widths.bear.waist > widths.rabbit.waist, 'bear has a stockier abdomen');
  assert.ok(widths.rabbit.height > widths.bear.height, 'rabbit has an elongated oval skull');
});

test('geometry ownership is caller-controlled and UV seam normals match', () => {
  const first = createCharacterHeadGeometry('cat'), second = createCharacterHeadGeometry('cat');
  assert.notEqual(first, second, 'helper has no hidden global cache');
  assert.deepEqual(first.getAttribute('position').array, second.getAttribute('position').array, 'authored surfaces are deterministic');
  const normal = first.getAttribute('normal');
  for (let ring = 0; ring < 39; ring++) {
    const a = 1 + ring * 49, b = a + 48;
    assert.ok(new THREE.Vector3().fromBufferAttribute(normal, a).distanceTo(new THREE.Vector3().fromBufferAttribute(normal, b)) < 1e-7);
  }
  first.dispose(); second.dispose();
});

test('species remain distinguishable by naked skull silhouette and facial landmarks with identical palettes', () => {
  const heads = Object.fromEntries(species.map(animal => [animal, createCharacterHeadGeometry(animal)]));
  const sizes = Object.fromEntries(species.map(animal => [animal, heads[animal].boundingBox.getSize(new THREE.Vector3())]));
  assert.ok(sizes.rabbit.y / sizes.rabbit.x > 1.3, 'rabbit has a visibly narrow elongated face even without ears');
  assert.ok(sizes.bear.x / sizes.bear.y > 1.2, 'bear has a broad low skull and short neck');
  assert.ok(sizes.cat.x / sizes.cat.y > 1.12 && sizes.cat.x < sizes.bear.x - .04, 'cat has round cheeks on a smaller, shallower skull');
  assert.ok(widthAt(heads.fox, -.085) / widthAt(heads.fox, .155) > 1.65, 'fox has an obvious cheek-to-forehead wedge');
  assert.ok(sizes.fox.z > sizes.cat.z + .11, 'fox long muzzle is visible in the side silhouette');
  Object.values(heads).forEach(head => head.dispose());
  const resources = new OfficeResources(), desk = createOfficeWorld(resources, 1).desks[0], faces = {};
  for (const animal of species) {
    const avatar = createOfficeAvatar(resources, desk, animal, { species: animal, skinColor: '#aa8866', hairColor: '#554433' });
    const left = avatar.root.getObjectByName('animal-eye-left'), right = avatar.root.getObjectByName('animal-eye-right');
    const nose = avatar.root.getObjectByName('animal-nose'), mouth = avatar.root.getObjectByName('animal-mouth');
    const eyes = avatar.eyes;
    faces[animal] = { eyeAspect: left.scale.y / left.scale.x, spacing: right.position.x - left.position.x, noseWidth: nose.scale.x };
    assert.deepEqual(avatar.head.position.toArray(), [0, .79, 0], 'facial distinction does not move the head/shoulder anchor');
    assert.equal(left.position.x, -right.position.x, 'neutral face stays centered on the screen');
    assert.ok(nose.position.y < eyes.position.y - .07, 'nose remains below the eye line');
    assert.ok(mouth && !Array.isArray(mouth.material), 'one subtle mouth follows the continuous muzzle');
    assert.ok(mouth.geometry.getAttribute('position').array.every(Number.isFinite));
    assert.equal(avatar.root.getObjectByName('animal-face').geometry.groups.length, 0, 'muzzle cheeks remain one surface');
  }
  assert.ok(faces.rabbit.eyeAspect > faces.cat.eyeAspect * 1.3 && faces.fox.eyeAspect < .75, 'rabbit oval eyes and fox almond eyes use different authored forms');
  assert.ok(faces.rabbit.spacing < faces.bear.spacing - .06, 'eye spacing follows each skull');
  assert.ok(faces.bear.noseWidth > faces.rabbit.noseWidth * 2, 'bear has a broad nose; rabbit a fine soft nose');
  resources.dispose();
});

test('seated thigh, knee, ankle and paw are one closed limb with a flat supported sole', () => {
  const leg = createCharacterLegGeometry();
  validateClosedSurface(leg, 1500);
  const bounds = leg.boundingBox, position = leg.getAttribute('position'), normal = leg.getAttribute('normal');
  assert.ok(Math.abs(bounds.min.y + .384) < 1e-7, 'sole keeps the old foot-support contact height');
  assert.ok(Math.abs(bounds.max.y - .080) < 1e-7, 'upper cap is hidden inside torso');
  assert.ok(bounds.min.z > -.422 && bounds.min.z < -.400, `toe reaches the existing footprint (${bounds.min.z})`);
  assert.ok(bounds.max.x < .115 && bounds.min.x > -.115, 'left/right hip offsets can be preserved');
  let soleVertices = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (Math.abs(position.getY(vertex) + .384) < 1e-7) soleVertices++;
  }
  assert.ok(soleVertices >= 29, 'a real flat sole contacts the support, not just one bottom point');
  assert.ok(Math.abs(position.getZ(position.count - 1)) < 1e-7, 'thigh top meets the torso around Z=0');
  for (let ring = 0; ring < 25; ring++) {
    const a = 1 + ring * 29, b = a + 28;
    assert.ok(new THREE.Vector3().fromBufferAttribute(normal, a).distanceTo(new THREE.Vector3().fromBufferAttribute(normal, b)) < 1e-7);
  }
  leg.dispose();
});

test('continuous limb has a finite upper-trousers to lower-fur color field without separate meshes', () => {
  const leg = createCharacterLegGeometry(), position = leg.getAttribute('position'), mix = leg.getAttribute('trousersMix');
  assert.equal(mix.count, position.count);
  let transition = 0;
  for (let vertex = 0; vertex < mix.count; vertex++) {
    const y = position.getY(vertex), value = mix.getX(vertex);
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
    if (y > -.20) assert.equal(value, 1);
    if (y < -.27) assert.equal(value, 0);
    if (value > 0 && value < 1) transition++;
  }
  assert.ok(transition >= 58, 'multiple rings interpolate the fabric/fur transition');
  assert.equal(leg.groups.length, 0, 'leg does not require a separate joint, cuff or shoe surface');
  leg.dispose();
});

test('four ears have closed cupped shells, tapered thickness and species-specific proportions', () => {
  const proportions = {};
  for (const animal of species) {
    const ear = createCharacterEarGeometry(animal);
    validateClosedSurface(ear, 2200, .0002);
    const bounds = ear.boundingBox, size = bounds.getSize(new THREE.Vector3());
    assert.ok(bounds.min.y < -.04, 'ear root remains buried below the original head attachment');
    assert.ok(size.z > .075 && size.z < .2, 'ear has a physical shell with an asymmetric front and back');
    proportions[animal] = size.y / size.x;
    const position = ear.getAttribute('position'), uv = ear.getAttribute('uv');
    const middle = [], tip = [];
    for (let vertex = 0; vertex < position.count; vertex++) {
      const v = uv.getY(vertex);
      if (Math.abs(v - .5) < .02) middle.push(position.getZ(vertex));
      if (v > .90 && v < .95) tip.push(position.getZ(vertex));
    }
    assert.ok(Math.max(...tip) - Math.min(...tip) < (Math.max(...middle) - Math.min(...middle)) * .6, 'tip shell is thinner than the ear body');
    // At mid-height, the front center sits behind the flanking rim: actual
    // geometry creates the inner-ear recess instead of a second inset object.
    const y = THREE.MathUtils.lerp(bounds.min.y, bounds.max.y, .5);
    const center = frontAt(ear, 0, y), rim = frontAt(ear, size.x * .25, y);
    assert.ok(center > rim + .004, `${animal}: inner ear is visibly cupped (${center - rim})`);
    ear.dispose();
  }
  assert.ok(proportions.rabbit > proportions.cat * 1.8, 'rabbit retains long ears');
  assert.ok(proportions.bear < 1.2, 'bear retains rounded short ears');
  assert.equal(new Set(Object.values(proportions).map(value => value.toFixed(3))).size, 4, 'each species uses an authored profile');
});

test('ear inset and fox markings are bounded color fields confined to the intended surface', () => {
  for (const animal of species) {
    const ear = createCharacterEarGeometry(animal), uv = ear.getAttribute('uv');
    const inner = ear.getAttribute('earInnerMix'), tip = ear.getAttribute('earTipMix');
    let innerVertices = 0, blendedVertices = 0;
    for (let vertex = 0; vertex < inner.count; vertex++) {
      const weight = inner.getX(vertex), tipWeight = tip.getX(vertex);
      assert.ok([weight, tipWeight].every(value => Number.isFinite(value) && value >= 0 && value <= 1));
      if (Math.cos(uv.getX(vertex) * Math.PI * 2) >= 0) assert.equal(weight, 0, 'inner ear color never wraps around the back');
      if (weight > .95) innerVertices++;
      if (weight > .05 && weight < .95) blendedVertices++;
      if (animal !== 'fox') assert.equal(tipWeight, 0);
    }
    assert.ok(innerVertices > 8 && blendedVertices > 50, 'inset has both a clear center and soft boundary');
    assert.equal(ear.groups.length, 0, 'color fields do not add material groups/draw calls');
    ear.dispose();
  }
});

test('fox tail is one curved watertight brush with a smooth cream tip and shared seam normals', () => {
  const tail = createCharacterFoxTailGeometry();
  validateClosedSurface(tail, 1600, .01);
  const position = tail.getAttribute('position'), uv = tail.getAttribute('uv'), normal = tail.getAttribute('normal'), mix = tail.getAttribute('tailTipMix');
  assert.ok(tail.boundingBox.max.x > .47 && tail.boundingBox.max.x < .55, 'tail keeps the seated footprint');
  let previousMix = -1, transitionRings = 0;
  for (let ring = 0; ring < 31; ring++) {
    const a = 1 + ring * 25, b = a + 24, weight = mix.getX(a);
    assert.ok(weight >= previousMix, 'cream transition follows the brush length monotonically'); previousMix = weight;
    assert.ok(new THREE.Vector3().fromBufferAttribute(normal, a).distanceTo(new THREE.Vector3().fromBufferAttribute(normal, b)) < 1e-7);
    if (weight > .05 && weight < .95) transitionRings++;
  }
  assert.ok(transitionRings >= 4, 'several rings blend into the cream tip');
  for (let vertex = 0; vertex < position.count; vertex++) {
    if (uv.getY(vertex) < .67) assert.equal(mix.getX(vertex), 0);
    if (uv.getY(vertex) > .86) assert.equal(mix.getX(vertex), 1);
  }
  assert.equal(tail.groups.length, 0, 'the tail tip is part of the same mesh/material');
  tail.dispose();
});

test('ear and fox-tail replacements preserve animation pivots, color editing and resource ownership', () => {
  const resources = new OfficeResources(), desk = createOfficeWorld(resources, 1).desks[0];
  for (const animal of species) {
    const appearance = { species: animal, skinColor: '#bd956b', hairColor: '#60452f' };
    const avatar = createOfficeAvatar(resources, desk, animal, appearance);
    const edited = createOfficeAvatar(resources, desk, `${animal}-edited`, { ...appearance, skinColor: '#4a82ac', hairColor: '#823761' });
    avatar.ears.forEach((ear, index) => {
      assert.equal(ear.name, index ? 'animal-ear-right' : 'animal-ear-left');
      assert.deepEqual(ear.position.toArray(), [index ? .2 : -.2, .22, 0]);
      assert.equal(ear.children.length, 1, 'one shell draw call per ear');
      assert.equal(ear.children[0].name, 'continuous-ear-shell');
      assert.deepEqual(ear.children[0].scale.toArray(), [1, 1, 1], 'authored shell needs no primitive scaling');
      assert.notDeepEqual(ear.children[0].geometry.getAttribute('color').array, edited.ears[index].children[0].geometry.getAttribute('color').array, 'saved appearance edits rebuild ear colors');
    });
    assert.equal(avatar.ears[0].children[0].geometry, avatar.ears[1].children[0].geometry, 'left/right ears reuse one resource');
    assert.deepEqual(avatar.tail.position.toArray(), [.16, .02, .14]);
    if (animal === 'fox') {
      assert.equal(avatar.tail.children.length, 1);
      assert.equal(avatar.tail.children[0].name, 'continuous-fox-tail');
      assert.notDeepEqual(avatar.tail.children[0].geometry.getAttribute('color').array, edited.tail.children[0].geometry.getAttribute('color').array);
    }
    poseOfficeAvatar(avatar, 'working', 2.3, false, 'executing');
    assert.ok(avatar.ears.every(ear => Math.abs(ear.rotation.x) > 0), 'ear twitch still reaches the preserved pivots');
    assert.ok(Math.abs(avatar.tail.rotation.y) > 0, 'tail motion still reaches the preserved pivot');
  }
  let disposals = 0;
  const cached = resources.geometry('ownership-test-ear', () => createCharacterEarGeometry('cat'));
  cached.addEventListener('dispose', () => disposals++);
  resources.dispose(); resources.dispose();
  assert.equal(disposals, 1, 'resources dispose geometry exactly once');
});

test('short neck is closed, low-cost and overlaps both real shirt and skull through the supported gaze range', () => {
  const resources = new OfficeResources(), desk = createOfficeWorld(resources, 1).desks[0];
  const direction = new THREE.Vector3(.37, .23, .91).normalize();
  const contains = (object, point) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const sides = materials.map(material => material.side);
    materials.forEach(material => { material.side = THREE.DoubleSide; });
    const hits = new THREE.Raycaster(point, direction).intersectObject(object, false);
    materials.forEach((material, index) => { material.side = sides[index]; });
    const distances = [];
    for (const hit of hits) if (!distances.some(distance => Math.abs(distance - hit.distance) < 1e-7)) distances.push(hit.distance);
    return distances.length % 2 === 1;
  };
  let disposals = 0;
  for (const animal of species) {
    const authored = createCharacterNeckGeometry(animal);
    validateClosedSurface(authored, 900, .001);
    assert.ok(authored.boundingBox.min.y < .48 && authored.boundingBox.max.y > .70, 'both caps bury inside adjacent volumes');
    authored.dispose();
    const avatar = createOfficeAvatar(resources, desk, `${animal}-neck`, { species: animal });
    const neck = avatar.root.getObjectByName('animal-neck'), face = avatar.root.getObjectByName('animal-face');
    assert.equal(neck.parent, avatar.body, 'neck follows the clothing frame, not the head rotation');
    assert.deepEqual(neck.position.toArray(), [0, 0, 0]);
    const position = neck.geometry.getAttribute('position'), upper = [], lower = [];
    for (let vertex = 0; vertex < position.count; vertex++) {
      const y = position.getY(vertex);
      if (y > .64 && vertex % 3 === 0) upper.push(new THREE.Vector3().fromBufferAttribute(position, vertex));
      if (y > .478 && y < .49) lower.push(new THREE.Vector3().fromBufferAttribute(position, vertex));
    }
    assert.ok(upper.length > 25 && lower.length >= 24, 'coverage uses complete contact rings, not just cap centers');
    avatar.root.updateMatrixWorld(true); avatar.bodySkin.mesh.skeleton.update();
    for (const point of lower) assert.ok(contains(avatar.bodySkin.mesh, neck.localToWorld(point.clone())), `${animal}: neck lower contour stays inside the actual skinned shirt`);
    for (const pitch of [-1.1, -.65, 0, .35]) for (const yaw of [-1.1, -.55, 0, .55, 1.1]) {
      avatar.head.rotation.set(pitch, yaw, 0, 'YXZ'); avatar.root.updateMatrixWorld(true);
      for (const point of upper) assert.ok(contains(face, neck.localToWorld(point.clone())), `${animal}: neck upper contour stays inside skull at pitch ${pitch}, yaw ${yaw}`);
    }
    neck.geometry.addEventListener('dispose', () => disposals++);
  }
  resources.dispose(); resources.dispose();
  assert.equal(disposals, 4, 'each cached neck geometry is released exactly once');
});
