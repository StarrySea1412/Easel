import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { createOfficeBodyGeometry, createOfficeBodySkin, syncOfficeBodySkin } = await loadTsModule('../officeBodySkin.ts', import.meta.url);
const { OfficeResources, createOfficeWorld, createOfficeAvatar, poseOfficeAvatar } = await loadTsModule('../officeGeometry.ts', import.meta.url);

function fixture() {
  const resources = new OfficeResources();
  const desk = createOfficeWorld(resources, 1).desks[0];
  const avatar = createOfficeAvatar(resources, desk, 'body-skin-check');
  const controls = { left: [avatar.leftArm, avatar.leftElbow, avatar.leftWrist], right: [avatar.rightArm, avatar.rightElbow, avatar.rightWrist] };
  const skin = createOfficeBodySkin(resources, avatar.body, controls, [resources.color(0x557766), resources.color(0xdab988)]);
  return { resources, avatar, skin };
}

for (const species of ['cat', 'rabbit', 'fox', 'bear']) test(`${species}: torso and both arms are a single welded closed surface below the triangle budget`, () => {
  const geometry = createOfficeBodyGeometry(species);
  const positions = geometry.attributes.position, weights = geometry.attributes.skinWeight;
  assert.ok(geometry.index.count / 3 < 25000);
  assert.equal(geometry.groups.length, 2);
  assert.ok([...positions.array, ...geometry.attributes.normal.array, ...weights.array].every(Number.isFinite));
  const edges = new Map(), adjacent = new Map();
  for (let offset = 0; offset < geometry.index.count; offset += 3) {
    const ids = [0, 1, 2].map(delta => geometry.index.getX(offset + delta));
    for (let edge = 0; edge < 3; edge++) {
      const a = ids[edge], b = ids[(edge + 1) % 3];
      const key = [a, b].sort((x, y) => x - y).join(':');
      edges.set(key, (edges.get(key) || 0) + 1);
      if (!adjacent.has(a)) adjacent.set(a, new Set());
      adjacent.get(a).add(b);
    }
  }
  assert.ok([...edges.values()].every(count => count === 2), 'shoulder, cuffs and caps have no open or non-manifold edges');
  const reached = new Set(), pending = [0];
  while (pending.length) {
    const vertex = pending.pop(); if (reached.has(vertex)) continue;
    reached.add(vertex); pending.push(...adjacent.get(vertex));
  }
  assert.equal(reached.size, positions.count, 'torso and both arms form one connected component');
  assert.equal(positions.count - edges.size + geometry.index.count / 3, 2, 'a closed genus-zero surface without hidden inner shells');
  let shoulderBlend = 0;
  for (let index = 0; index < weights.count; index++) {
    const values = [weights.getX(index), weights.getY(index), weights.getZ(index), weights.getW(index)];
    assert.ok(values.every(value => value >= 0 && value <= 1));
    assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-6);
    if (values[0] > .05 && values[0] < .95 && values[1] > .05) shoulderBlend++;
  }
  assert.ok(shoulderBlend > 100, 'the shirt-to-shoulder transition has shared blended vertices');
  geometry.dispose();
});

test('all seven skin bones follow the current work solver and the shoulder stays a shared surface while bending', () => {
  const { resources, avatar, skin } = fixture();
  const geometry = skin.mesh.geometry, indices = geometry.index.array.slice(), original = geometry.attributes.position.array.slice();
  const position = geometry.attributes.position, weights = geometry.attributes.skinWeight, boneIndex = geometry.attributes.skinIndex;
  const shoulderIndex = Array.from({ length: position.count }, (_, index) => index).find(index => weights.getX(index) > .2 && weights.getX(index) < .8);
  let firstShoulder;
  for (const action of ['executing', 'reading', 'writing', 'designing', 'delegating']) for (const time of [.2, 1.7, 5]) {
    poseOfficeAvatar(avatar, 'working', time, false, action); syncOfficeBodySkin(skin);
    avatar.root.updateMatrixWorld(true); skin.mesh.skeleton.update();
    for (const [side, start] of [['left', 1], ['right', 4]]) for (let joint = 0; joint < 3; joint++) {
      assert.ok(skin.bones[start + joint].getWorldPosition(new THREE.Vector3()).distanceTo(skin.controls[side][joint].getWorldPosition(new THREE.Vector3())) < 1e-8);
    }
    for (let index = 0; index < position.count; index++) {
      const bind = new THREE.Vector3().fromBufferAttribute(position, index);
      const actual = skin.mesh.localToWorld(skin.mesh.applyBoneTransform(index, bind.clone()));
      assert.ok(actual.toArray().every(Number.isFinite));
      if (weights.getW(index) === 1) {
        const side = boneIndex.getW(index) === 3 ? 'left' : 'right';
        const relative = bind.clone().sub(new THREE.Vector3(side === 'left' ? -.245 : .245, .44, -.52));
        assert.ok(actual.distanceTo(skin.controls[side][2].localToWorld(relative)) < 1e-7, 'paw skin and pen share the original exact wrist contact');
      }
      if (index === shoulderIndex && action === 'executing' && time === .2) firstShoulder = actual;
    }
    assert.deepEqual(geometry.index.array, indices, 'bending cannot split the welded shoulder topology');
  }
  const lastShoulder = skin.mesh.localToWorld(skin.mesh.applyBoneTransform(shoulderIndex, new THREE.Vector3().fromBufferAttribute(position, shoulderIndex)));
  assert.ok(firstShoulder.distanceTo(lastShoulder) > .001, 'the blended shoulder really deforms with work poses');
  assert.deepEqual(geometry.attributes.position.array, original, 'only bones move; no per-frame geometry regeneration');
  assert.equal(avatar.pen.parent, avatar.rightWrist);
  resources.dispose();
});

test('same-species bodies share geometry and owned skeleton textures release once', () => {
  const { resources, avatar, skin } = fixture();
  const second = createOfficeBodySkin(resources, avatar.body, skin.controls, skin.mesh.material);
  assert.equal(second.mesh.geometry, skin.mesh.geometry);
  let geometryDisposals = 0, texturesDisposed = 0;
  skin.mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
  for (const body of [skin, second]) {
    body.mesh.skeleton.computeBoneTexture();
    body.mesh.skeleton.boneTexture.addEventListener('dispose', () => texturesDisposed++);
  }
  resources.dispose(); resources.dispose();
  assert.equal(geometryDisposals, 1);
  assert.equal(texturesDisposed, 2);
});
