import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';
const { OfficeResources, createOfficeWorld, createOfficeAvatar, poseOfficeAvatar } = await loadTsModule('../officeGeometry.ts', import.meta.url);
function fixture() {
  const resources = new OfficeResources();
  const desk = createOfficeWorld(resources, 1).desks[0];
  return { resources, desk, avatar: createOfficeAvatar(resources, desk, '') };
}
function local(avatar, object) {
  avatar.root.updateMatrixWorld(true);
  return avatar.root.worldToLocal(object.getWorldPosition(new THREE.Vector3()));
}

test('fixed length shoulder/elbow/wrist chains reach real keyboard and mouse without stretching', () => {
  const { resources, avatar, desk } = fixture();
  const rootPosition = avatar.root.position.clone();
  for (const time of [0, 0.12, 1, 3.8, 4.8, 5.2]) {
    poseOfficeAvatar(avatar, 'working', time, false, 'executing');
    avatar.root.updateMatrixWorld(true);
    for (const side of ['left', 'right']) {
      const shoulder = avatar[`${side}Arm`].getWorldPosition(new THREE.Vector3());
      const elbow = avatar[`${side}Elbow`].getWorldPosition(new THREE.Vector3());
      const wrist = avatar[`${side}Wrist`].getWorldPosition(new THREE.Vector3());
      assert.ok(Math.abs(shoulder.distanceTo(elbow) - .25) < 1e-8);
      assert.ok(Math.abs(elbow.distanceTo(wrist) - .27) < 1e-8);
      assert.ok(wrist.y - .079 * .65 > .9525, 'paw clears desktop');
    }
    assert.deepEqual(avatar.root.position, rootPosition, 'seated root does not slide');
  }
  poseOfficeAvatar(avatar, 'working', 0, false, 'executing');
  const left = avatar.leftWrist.getWorldPosition(new THREE.Vector3());
  avatar.root.updateMatrixWorld(true);
  left.copy(avatar.leftWrist.getWorldPosition(new THREE.Vector3()));
  assert.ok(Math.abs(left.x - (desk.slot.x - .17)) < 1e-8);
  assert.ok(Math.abs(left.z - (desk.slot.z + .2)) < 1e-8);
  poseOfficeAvatar(avatar, 'working', 5, false, 'executing');
  avatar.root.updateMatrixWorld(true);
  const mouse = avatar.rightWrist.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(mouse.x - (desk.slot.x + .41)) < 1e-8);
  assert.ok(Math.abs(mouse.z - (desk.slot.z + .25)) < 1e-8);
  assert.equal(avatar.root.userData.motionStage, 'mouse');
  resources.dispose();
});

test('stylus tip contacts the displayed writing and drawing surface, with controlled inspection lifts', () => {
  const { resources, avatar } = fixture();
  for (const action of ['writing', 'designing']) {
    poseOfficeAvatar(avatar, 'working', 0, false, action);
    avatar.root.updateMatrixWorld(true);
    const prop = action === 'writing' ? avatar.document : avatar.tablet;
    const tip = avatar.pen.localToWorld(new THREE.Vector3(0, -.11, 0));
    const paper = prop.localToWorld(new THREE.Vector3(-.08, 0, .042));
    assert.ok(tip.distanceTo(paper) < 1e-8, `${action}: tip actually touches paper`);
    poseOfficeAvatar(avatar, 'working', 5, false, action);
    avatar.root.updateMatrixWorld(true);
    const raisedTip = avatar.pen.localToWorld(new THREE.Vector3(0, -.11, 0));
    const raisedPaper = prop.localToWorld(new THREE.Vector3(.12, .02, .042));
    assert.ok(Math.abs(raisedTip.y - raisedPaper.y - .045) < 1e-8);
    assert.equal(avatar.root.userData.motionStage, 'inspect');
  }
  resources.dispose();
});

test('head faces actual monitor and actions keep joints finite and paws out of desktop', () => {
  const { resources, avatar } = fixture();
  poseOfficeAvatar(avatar, 'working', 4, false, 'executing');
  avatar.root.updateMatrixWorld(true);
  const headPosition = local(avatar, avatar.head);
  const gaze = new THREE.Vector3(.55, .81, -.74).sub(headPosition).normalize();
  const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(avatar.head.quaternion).applyQuaternion(avatar.body.quaternion);
  assert.ok(facing.dot(gaze) > .99, 'eyes orient to screen, not camera');
  for (const action of ['executing', 'reading', 'writing', 'designing', 'delegating']) {
    for (let time = 0; time < 12; time += .13) {
      poseOfficeAvatar(avatar, 'working', time, false, action);
      for (const wrist of [avatar.leftWrist, avatar.rightWrist]) {
        const point = local(avatar, wrist);
        assert.ok(point.y > .395 && point.y < .74, `${action} paw height ${point.y}`);
        assert.ok(Math.abs(point.x) < .6 && point.z > -.63 && point.z < -.15);
      }
      avatar.root.traverse(object => assert.ok([...object.position, ...object.quaternion].every(Number.isFinite)));
    }
  }
  resources.dispose();
});

test('switching to stopped, error or completed clears work and freezes all joints', () => {
  const { resources, avatar } = fixture();
  function snapshot() {
    const result = [];
    avatar.root.traverse(o => result.push(o.visible, ...o.position, ...o.quaternion, ...o.scale));
    return result;
  }
  for (const state of ['waiting', 'unknown', 'stopped', 'error', 'done']) {
    poseOfficeAvatar(avatar, 'working', 2, false, 'designing');
    poseOfficeAvatar(avatar, state, 3, false, 'designing');
    assert.equal(avatar.pen.visible, false); assert.equal(avatar.tablet.visible, false);
    const before = snapshot();
    poseOfficeAvatar(avatar, state, 120, false, 'designing');
    assert.deepEqual(snapshot(), before);
    assert.equal(avatar.root.userData.motionStage, 'rest');
  }
  resources.dispose();
});

test('work cycle boundaries ease paws and gaze instead of teleporting back to the next stroke', () => {
  const { resources, avatar } = fixture();
  for (const action of ['executing', 'reading', 'writing', 'designing']) {
    for (const boundary of [.8, 2, 3.5, 4.6, 6, 12]) {
      poseOfficeAvatar(avatar, 'working', boundary - .001, false, action);
      const before = [local(avatar, avatar.leftWrist), local(avatar, avatar.rightWrist)];
      const head = avatar.head.quaternion.clone();
      poseOfficeAvatar(avatar, 'working', boundary + .001, false, action);
      const after = [local(avatar, avatar.leftWrist), local(avatar, avatar.rightWrist)];
      before.forEach((point, index) => assert.ok(point.distanceTo(after[index]) < .003, `${action} jumps at ${boundary}`));
      assert.ok(head.angleTo(avatar.head.quaternion) < .003, `${action} gaze jumps at ${boundary}`);
    }
  }
  resources.dispose();
});
