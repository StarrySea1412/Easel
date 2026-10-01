import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { createOfficeHandGeometry, createOfficeHand, updateOfficeHandPose, OFFICE_HAND_PEN_AXIS } = await loadTsModule('../officeHands.ts', import.meta.url);
const { OfficeResources } = await loadTsModule('../officeGeometry.ts', import.meta.url);
const { createOfficeBodyGeometry } = await loadTsModule('../officeBodySkin.ts', import.meta.url);

function segmentDistance(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(a[0] + dx * t, a[1] + dz * t);
}
function triangleDistance(a, b, c) {
  const cross = (u, v) => u[0] * v[1] - u[1] * v[0];
  const signs = [cross(a, b), cross(b, c), cross(c, a)];
  const area = cross([b[0] - a[0], b[1] - a[1]], [c[0] - a[0], c[1] - a[1]]);
  if (Math.abs(area) > 1e-12 && (signs.every(x => x >= 0) || signs.every(x => x <= 0))) return 0;
  return Math.min(segmentDistance(a, b), segmentDistance(b, c), segmentDistance(c, a));
}

for (const species of ['cat', 'rabbit', 'fox', 'bear']) test(`${species}: all finger pose blends stay clear of the entire pen barrel`, () => {
  const geometry = createOfficeHandGeometry(species);
  const base = geometry.attributes.position, grip = geometry.morphAttributes.position[0], paper = geometry.morphAttributes.position[1];
  let minimum = Infinity;
  for (let step = 0; step <= 10; step++) for (let press = 0; press <= 10 - step; press++) {
    const amount = step / 10, paperAmount = press / 10, flatAmount = 1 - amount - paperAmount;
    for (let i = 0; i < geometry.index.count; i += 3) {
      const points = [0, 1, 2].map(offset => {
        const vertex = geometry.index.getX(i + offset);
        return [base.getX(vertex) * flatAmount + grip.getX(vertex) * amount + paper.getX(vertex) * paperAmount - OFFICE_HAND_PEN_AXIS.x,
          base.getZ(vertex) * flatAmount + grip.getZ(vertex) * amount + paper.getZ(vertex) * paperAmount - OFFICE_HAND_PEN_AXIS.y];
      });
      minimum = Math.min(minimum, triangleDistance(...points));
    }
  }
  assert.ok(minimum > .014, `all triangle surfaces, including claws, clear the .014 barrel radius (actual ${minimum})`);
  // Opposing fingertip pads actually approach the tool; a distant empty fist
  // would also pass a collision-only test, but would not be a usable grip.
  const perDigit = 203, tip = 192;
  const indexTip = new THREE.Vector3().fromBufferAttribute(grip, tip);
  const thumbTip = new THREE.Vector3().fromBufferAttribute(grip, perDigit * 3 + tip);
  assert.ok(indexTip.z < -.02 && thumbTip.z > .02);
  assert.ok(Math.abs(indexTip.x - OFFICE_HAND_PEN_AXIS.x) < .01 && Math.abs(thumbTip.x - OFFICE_HAND_PEN_AXIS.x) < .01);
  assert.ok(indexTip.distanceTo(thumbTip) < .06, 'thumb and index oppose each other at the grip');
  assert.ok(geometry.index.count / 3 < 1700, 'four fingers remain within the per-hand mesh budget');
  for (const attributes of [geometry.attributes, ...[0, 1].map(i => ({ position: geometry.morphAttributes.position[i], normal: geometry.morphAttributes.normal[i] }))]) {
    assert.ok([...attributes.position.array, ...attributes.normal.array].every(Number.isFinite));
  }
  geometry.dispose();
});

for (const species of ['cat', 'rabbit', 'fox', 'bear']) for (const side of ['right', 'left']) test(`${species}/${side}: three real finger pads support the pen without a visible floating gap`, () => {
  const geometry = createOfficeHandGeometry(species, side);
  geometry.setAttribute('position', geometry.morphAttributes.position[0]);
  geometry.morphAttributes = {};
  geometry.setDrawRange(geometry.groups[0].start, geometry.groups[0].count);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.updateMatrixWorld(true);
  const mirror = side === 'left' ? -1 : 1, ray = new THREE.Raycaster();
  // Probe a patch of each supporting pad from the barrel, not just an isolated
  // tip vertex: the index and thumb oppose at one height, the middle supports
  // below them. This catches a collision-free but visibly empty grip.
  for (const [name, digit, height, z] of [['index', 0, .021, -1], ['thumb', 3, .024, 1], ['middle', 1, -.02, -1]]) {
    for (const x of [-.4, -.3, -.2]) for (const dy of [-.001, 0, .001]) {
      ray.set(new THREE.Vector3(OFFICE_HAND_PEN_AXIS.x * mirror, height + dy, OFFICE_HAND_PEN_AXIS.y), new THREE.Vector3(-x * mirror, 0, z).normalize());
      const contact = ray.intersectObject(mesh, false)[0];
      assert.ok(contact, `${name} provides a continuous supporting pad`);
      assert.equal(Math.floor(contact.face.a / 203), digit, `${name} itself touches the grip area`);
      assert.ok(contact.distance > .014 && contact.distance < .017, `${name} skin gap from barrel stays below .003 (actual ${contact.distance - .014})`);
      assert.ok(contact.face.normal.dot(ray.ray.direction) < 0, `${name} presents its outward skin surface to the pen`);
    }
  }
  geometry.dispose(); material.dispose();
});

for (const species of ['cat', 'rabbit', 'fox', 'bear']) test(`${species}: fingers have closed topology and roots stay buried in the continuous palm in every pose`, () => {
  const geometry = createOfficeHandGeometry(species);
  const skinIndices = geometry.groups[0];
  const edges = new Map();
  for (let i = 0; i < skinIndices.count; i += 3) for (let edge = 0; edge < 3; edge++) {
    const a = geometry.index.getX(i + edge), b = geometry.index.getX(i + (edge + 1) % 3);
    const key = [a, b].sort((x, y) => x - y).join(':'); edges.set(key, (edges.get(key) || 0) + 1);
  }
  assert.ok([...edges.values()].every(count => count === 2), 'no uncapped finger joints or split tube seams');
  const palm = new THREE.Mesh(createOfficeBodyGeometry(species), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  palm.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), direction = new THREE.Vector3(0, 1, 0);
  let clearance = Infinity;
  const bodyPosition = palm.geometry.attributes.position;
  for (let i = 0; i < palm.geometry.index.count; i += 3) {
    const points = [0, 1, 2].map(offset => {
      const vertex = palm.geometry.index.getX(i + offset);
      return [bodyPosition.getX(vertex) - .245 - OFFICE_HAND_PEN_AXIS.x, bodyPosition.getZ(vertex) + .52 - OFFICE_HAND_PEN_AXIS.y];
    });
    clearance = Math.min(clearance, triangleDistance(...points));
  }
  assert.ok(clearance > .014, 'the original continuous palm also clears the laterally held pen');
  for (const position of [geometry.attributes.position, ...geometry.morphAttributes.position]) for (let digit = 0; digit < 4; digit++) {
    for (let root = 0; root < 12; root++) {
      const point = new THREE.Vector3().fromBufferAttribute(position, digit * 203 + root).add(new THREE.Vector3(.245, .44, -.52));
      ray.set(point, direction);
      assert.equal(ray.intersectObject(palm, false).length % 2, 1, 'embedded digit root never exposes a detached joint');
    }
  }
  palm.geometry.dispose(); palm.material.dispose(); geometry.dispose();
});

test('left and right hands mirror all three poses, with distinct flat and paper silhouettes', () => {
  const right = createOfficeHandGeometry('rabbit', 'right'), left = createOfficeHandGeometry('rabbit', 'left');
  for (const [r, l] of [[right.attributes.position, left.attributes.position], ...right.morphAttributes.position.map((r, i) => [r, left.morphAttributes.position[i]])]) {
    for (let i = 0; i < r.count; i++) {
      assert.equal(r.getX(i), -l.getX(i)); assert.equal(r.getY(i), l.getY(i)); assert.equal(r.getZ(i), l.getZ(i));
    }
  }
  const flat = right.attributes.position, paper = right.morphAttributes.position[1];
  assert.ok(flat.getX(3 * 203 + 192) < 0, 'right thumb points inward toward the left hand');
  assert.ok(left.attributes.position.getX(3 * 203 + 192) > 0, 'left thumb points inward toward the right hand');
  assert.ok(OFFICE_HAND_PEN_AXIS.x < 0, 'right-hand pen grip lies on the anatomical thumb side');
  assert.ok(paper.getY(192) > flat.getY(192) + .01, 'pressing pads keep the tapered fingertip above the page');
  assert.ok(paper.getY(6 * 12) < flat.getY(6 * 12) - .005, 'middle finger pads lower to meet the page');
  right.dispose(); left.dispose();
});

test('shared hand geometry has independent blend weights and is released exactly once', () => {
  const resources = new OfficeResources(), materials = [resources.color(0xccaa88), resources.color(0xffeedd)];
  const wrist = new THREE.Group();
  const a = createOfficeHand(resources, wrist, materials, 'cat', 'right');
  const b = createOfficeHand(resources, wrist, materials, 'cat', 'right');
  assert.equal(a.mesh.parent, wrist); assert.equal(a.mesh.geometry, b.mesh.geometry);
  assert.notEqual(a.mesh.morphTargetInfluences, b.mesh.morphTargetInfluences);
  const original = a.mesh.geometry.attributes.position.array.slice();
  updateOfficeHandPose(a, 'pen'); updateOfficeHandPose(b, 'paper');
  assert.deepEqual(a.mesh.morphTargetInfluences, [1, 0]); assert.deepEqual(b.mesh.morphTargetInfluences, [0, 1]);
  updateOfficeHandPose(a, { pen: .8, paper: .8 }); assert.deepEqual(a.mesh.morphTargetInfluences, [.5, .5]);
  updateOfficeHandPose(a, { pen: NaN, paper: -1 }); assert.deepEqual(a.mesh.morphTargetInfluences, [0, 0]);
  for (let frame = 0; frame < 100; frame++) updateOfficeHandPose(a, { pen: frame / 100 });
  assert.deepEqual(a.mesh.geometry.attributes.position.array, original, 'only morph weights change per frame');
  let disposed = 0; a.mesh.geometry.addEventListener('dispose', () => disposed++);
  resources.dispose(); resources.dispose(); assert.equal(disposed, 1);
});
