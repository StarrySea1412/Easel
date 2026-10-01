import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { createCharacterHeadGeometry, createCharacterTorsoGeometry, createCharacterLegGeometry, characterFaceSurface } = await loadTsModule('../officeCharacterForms.ts', import.meta.url);
const species = ['cat', 'rabbit', 'fox', 'bear'];

function validateClosedSurface(geometry, triangleBudget) {
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
  assert.ok(signedVolume > .01, 'winding points outward and encloses positive volume');
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
    assert.ok(headSize.x >= .51 && headSize.x <= .69 && headSize.y >= .54 && headSize.y <= .66, `${animal}: compatible skull scale`);
    assert.ok(torsoSize.x >= .44 && torsoSize.x <= .55 && torsoSize.y >= .51 && torsoSize.y <= .55, `${animal}: compatible seated torso`);
    assert.equal(torso.boundingBox.min.y, 0, 'hem closes at body origin');
    head.dispose(); torso.dispose();
  }
});

test('face attachment API follows the integrated surface and clothing anchors remain compatible', () => {
  for (const animal of species) {
    const head = createCharacterHeadGeometry(animal), torso = createCharacterTorsoGeometry(animal);
    for (const [x, y] of [[-.116, .033], [.116, .033], [0, -.057], [-.212, -.073], [.212, -.073], [.064, -.072]]) {
      const authoredZ = characterFaceSurface(animal, x, y), polygonZ = frontAt(head, x, y);
      assert.ok(Math.abs(authoredZ - polygonZ) < .003, `${animal}: attachment follows the actual cheek/nose/eye surface (${x}, ${y})`);
      assert.ok(authoredZ - .008 < polygonZ, 'placing at returned Z minus clearance stays in front of the mesh');
    }
    const nose = characterFaceSurface(animal, 0, -.067), forehead = characterFaceSurface(animal, 0, .12);
    assert.ok(nose < forehead - .045, `${animal}: a real muzzle projects from the skull itself`);
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
