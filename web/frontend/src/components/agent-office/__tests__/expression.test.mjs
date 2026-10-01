import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { OfficeResources, createOfficeWorld, createOfficeAvatar, poseOfficeAvatar } = await loadTsModule('../officeGeometry.ts', import.meta.url);
const { applyOfficeExpression, officeExpressionKind } = await loadTsModule('../officeExpression.ts', import.meta.url);
const { CHARACTER_FACE_FEATURES } = await loadTsModule('../officeCharacterForms.ts', import.meta.url);
const species = ['cat', 'rabbit', 'fox', 'bear'];

function fixture() {
  const resources = new OfficeResources(), desk = createOfficeWorld(resources, 1).desks[0];
  return { resources, make: (animal, id = animal, accessory) => createOfficeAvatar(resources, desk, id,
    { species: animal, skinColor: '#bf9870', hairColor: '#65513e', accessory }) };
}

function expressionSnapshot(avatar) {
  return [avatar.expression.current, [...avatar.expression.mouth.morphTargetInfluences], [...avatar.expression.brows.morphTargetInfluences],
    avatar.expression.eyes.map(eye => [...eye.position, ...eye.scale]), [...avatar.eyes.scale]];
}

function vertices(mesh) {
  return Array.from({ length: mesh.geometry.getAttribute('position').count }, (_, index) => mesh.getVertexPosition(index, new THREE.Vector3()).toArray());
}

test('visual expressions reflect reported status without inventing focused work or a happy unknown state', () => {
  for (const action of ['executing', 'reading', 'writing', 'designing', 'delegating']) assert.equal(officeExpressionKind('working', action), 'focused');
  assert.equal(officeExpressionKind('working', 'unreported'), 'neutral');
  assert.equal(officeExpressionKind('unknown', 'completed'), 'neutral');
  assert.equal(officeExpressionKind('thinking'), 'thinking');
  assert.equal(officeExpressionKind('waiting'), 'waiting');
  assert.equal(officeExpressionKind('stopped'), 'waiting');
  assert.equal(officeExpressionKind('done'), 'complete');
  assert.equal(officeExpressionKind('error'), 'concerned');
});

test('all species have actual mouth and brow changes while eye anchors, accessories and blink remain compatible', () => {
  const { resources, make } = fixture();
  for (const animal of species) {
    const avatar = make(animal, animal, 'glasses'), rig = avatar.expression;
    const initialAnchors = rig.eyes.map(eye => eye.position.toArray()), headTransform = [...avatar.head.position, ...avatar.head.quaternion];
    const signatures = new Set();
    for (const state of ['unknown', 'working', 'thinking', 'waiting', 'done', 'error']) {
      avatar.eyes.scale.y = .2;
      applyOfficeExpression(rig, state, 'executing');
      assert.equal(avatar.eyes.scale.y, .2, 'expression does not reset motion-owned blink');
      assert.deepEqual(rig.eyes.map(eye => eye.position.toArray()), initialAnchors, 'openness cannot pull eyes off the face');
      assert.deepEqual([...avatar.head.position, ...avatar.head.quaternion], headTransform, 'expression never turns or tilts the head');
      assert.ok(rig.eyes.every(eye => eye.scale.y / CHARACTER_FACE_FEATURES[animal].eyeScale[1] >= .8), 'expressive eye opening stays restrained');
      signatures.add(JSON.stringify([vertices(rig.mouth), vertices(rig.brows)]));
      assert.equal(rig.mouth.morphTargetInfluences.reduce((sum, value) => sum + value, 0), 1);
      assert.equal(rig.brows.morphTargetInfluences.reduce((sum, value) => sum + value, 0), 1);
    }
    assert.equal(signatures.size, 6, `${animal}: distinct curves, not only status names`);
    applyOfficeExpression(rig, 'unknown');
    assert.ok(rig.eyes.every(eye => eye.scale.y === CHARACTER_FACE_FEATURES[animal].eyeScale[1]), 'returning to neutral restores each species eye anatomy');
    assert.equal(rig.brows.parent, avatar.head);
    assert.equal(rig.mouth.parent.name, 'animal-muzzle');
  }
  resources.dispose();
});

test('expression geometry is finite, prebuilt, shared safely, and changing one character cannot affect another', () => {
  const { resources, make } = fixture(), first = make('fox', 'first'), second = make('fox', 'second');
  assert.equal(first.expression.mouth.geometry, second.expression.mouth.geometry);
  assert.equal(first.expression.brows.geometry, second.expression.brows.geometry);
  assert.notEqual(first.expression.mouth.morphTargetInfluences, second.expression.mouth.morphTargetInfluences);
  const secondBefore = expressionSnapshot(second), geometries = [first.expression.mouth.geometry, first.expression.brows.geometry];
  const attributes = geometries.map(geometry => geometry.getAttribute('position'));
  for (const geometry of geometries) {
    assert.equal(geometry.morphAttributes.position.length, 6);
    for (const attribute of [...geometry.morphAttributes.position, ...geometry.morphAttributes.normal]) {
      assert.ok(attribute.array.every(Number.isFinite));
      assert.equal(attribute.count, geometry.getAttribute('position').count);
    }
  }
  for (let index = 0; index < 100; index++) applyOfficeExpression(first.expression, index % 2 ? 'error' : 'done');
  assert.deepEqual(expressionSnapshot(second), secondBefore, 'shared read-only geometry does not share per-character expressions');
  geometries.forEach((geometry, index) => assert.equal(geometry.getAttribute('position'), attributes[index], 'no frame update rebuilds the curve buffer'));
  let geometryDisposals = 0, materialDisposals = 0;
  geometries.forEach(geometry => geometry.addEventListener('dispose', () => geometryDisposals++));
  first.expression.mouth.material.addEventListener('dispose', () => materialDisposals++);
  resources.dispose(); resources.dispose();
  assert.equal(geometryDisposals, 2); assert.equal(materialDisposals, 1);
});

test('pose integration applies state expressions after motion and terminal states stay static across time', () => {
  const { resources, make } = fixture(), avatar = make('cat');
  poseOfficeAvatar(avatar, 'working', 1.7, false, 'executing');
  assert.equal(avatar.expression.current, 'focused');
  for (const state of ['done', 'error', 'waiting', 'stopped', 'unknown']) {
    poseOfficeAvatar(avatar, state, 0, false, 'unreported');
    const before = expressionSnapshot(avatar);
    for (const time of [1, 8, 1000]) {
      poseOfficeAvatar(avatar, state, time, false, 'unreported');
      assert.deepEqual(expressionSnapshot(avatar), before, `${state}: no looping smile, brow or blink`);
    }
  }
  poseOfficeAvatar(avatar, 'working', 4, false, 'unreported');
  assert.equal(avatar.expression.current, 'neutral');
  resources.dispose();
});
