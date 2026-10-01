import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';
const { OfficeResources, createOfficeWorld, createOfficeAvatar, poseOfficeAvatar } = await loadTsModule('../officeGeometry.ts', import.meta.url);
const { createOfficeMotionPlayer } = await loadTsModule('../officeMotionPlayer.ts', import.meta.url);
const roles = ['coordinator', 'researcher', 'designer', 'writer', 'tester', 'reviewer'];
function fixture(role = 'designer') {
  const resources = new OfficeResources();
  const desk = createOfficeWorld(resources, 1, [{ id: role, role, appearance: { id: role } }]).desks[0];
  const avatar = createOfficeAvatar(resources, desk, role);
  return { resources, avatar, player: createOfficeMotionPlayer(avatar) };
}
function point(avatar, object) {
  avatar.root.updateWorldMatrix(true, true);
  return avatar.root.worldToLocal(object.getWorldPosition(new THREE.Vector3()));
}
function pose(avatar) {
  return [...avatar.body.position, ...avatar.body.quaternion, ...avatar.head.quaternion,
    ...point(avatar, avatar.leftWrist), ...point(avatar, avatar.rightWrist),
    ...avatar.leftWrist.getWorldQuaternion(new THREE.Quaternion()), ...avatar.rightWrist.getWorldQuaternion(new THREE.Quaternion())];
}

test('action changes settle from the displayed hands rather than teleporting, including interrupted transitions', () => {
  const { avatar, resources, player } = fixture();
  player.draw('working', 'executing', 2, false, 0, true);
  const before = pose(avatar);
  player.draw('working', 'designing', 2, false, .016, true);
  pose(avatar).forEach((value, i) => assert.ok(Math.abs(value - before[i]) < 1e-8));
  assert.equal(player.pending, true);
  player.draw('working', 'designing', 2.12, false, .06, true);
  assert.notDeepEqual(pose(avatar), before);
  const interrupted = pose(avatar);
  player.draw('thinking', 'thinking', 2.12, false, .016, true);
  pose(avatar).forEach((value, i) => assert.ok(Math.abs(value - interrupted[i]) < 1e-8));
  assert.equal(avatar.pen.userData.held, false, 'interrupted reach never takes the parked pen');
  for (let i = 0; i < 9; i++) player.draw('thinking', 'thinking', 2.12, false, .06, true);
  assert.equal(player.pending, false);
  const settled = pose(avatar);
  poseOfficeAvatar(avatar, 'thinking', 2.12, false, 'thinking');
  assert.deepEqual(pose(avatar), settled);
  resources.dispose();
});

test('pause freezes a partial transition, and state changes while paused or reset are immediate', () => {
  const { avatar, resources, player } = fixture();
  player.draw('working', 'reading', 1, false, 0, true);
  player.draw('working', 'writing', 1, false, 0, true);
  player.draw('working', 'writing', 1.06, false, .06, true);
  const paused = pose(avatar);
  for (let i = 0; i < 4; i++) player.draw('working', 'writing', 1.06, false, .06, false);
  assert.deepEqual(pose(avatar), paused);
  player.draw('done', 'completed', 1.06, false, .06, false);
  assert.equal(player.pending, false);
  assert.equal(avatar.document.visible, true);
  assert.equal(avatar.document.userData.engaged, false);
  const terminal = pose(avatar);
  player.draw('done', 'completed', 100, false, .06, true);
  assert.deepEqual(pose(avatar), terminal, 'completed employees do not loop a work or success animation');
  player.reset();
  player.draw('working', 'designing', 18, false, 0, false);
  const scrubbed = pose(avatar);
  poseOfficeAvatar(avatar, 'working', 18, false, 'designing');
  assert.deepEqual(pose(avatar), scrubbed);
  assert.equal(player.pending, false);
  resources.dispose();
});

test('role transitions preserve limb lengths and keep hands above the desk without moving the seated root', () => {
  for (const role of roles) {
    const { avatar, resources, player } = fixture(role);
    const position = avatar.root.position.clone();
    let time = 1;
    for (const [state, action] of [['working','executing'],['thinking','thinking'],['working','reading'],['working','designing'],['working','writing'],['working','delegating'],['done','completed'],['error','error'],['stopped','stopped']]) {
      for (let frame = 0; frame < 90; frame++, time += 1/60) {
        player.draw(state, action, time, false, 1/60, true);
        avatar.root.updateWorldMatrix(true, true);
        for (const side of ['left','right']) {
          const shoulder = point(avatar, avatar[`${side}Arm`]);
          const elbow = point(avatar, avatar[`${side}Elbow`]);
          const wrist = point(avatar, avatar[`${side}Wrist`]);
          assert.ok(Math.abs(shoulder.distanceTo(elbow) - .25) < 1e-8);
          assert.ok(Math.abs(elbow.distanceTo(wrist) - .27) < 1e-8);
          assert.ok(wrist.y >= .395 && wrist.z < -.15, `${role}/${state}/${action}: hand ${wrist.toArray()}`);
          assert.ok([...wrist].every(Number.isFinite));
        }
        assert.deepEqual(avatar.root.position, position);
      }
      assert.equal(player.pending, false);
    }
    resources.dispose();
  }
});

test('thinking hands differ across all six roles, with terminal feedback remaining still', () => {
  const hands = new Set();
  for (const role of roles) {
    const { avatar, resources } = fixture(role);
    poseOfficeAvatar(avatar, 'thinking', 2, false, 'thinking');
    hands.add([...point(avatar, avatar.leftWrist), ...point(avatar, avatar.rightWrist)].map(n => n.toFixed(3)).join(','));
    poseOfficeAvatar(avatar, 'done', 3, false, 'completed');
    const done = pose(avatar);
    poseOfficeAvatar(avatar, 'done', 120, false, 'completed');
    assert.deepEqual(pose(avatar), done);
    resources.dispose();
  }
  assert.equal(hands.size, 6);
});

test('restarting pickup preserves displayed fingers and establishes a full grip at the stand', () => {
  for(const role of roles) {
    const {avatar,resources,player}=fixture(role);
    const hand=avatar.rightHand.mesh;
    function fingers() {
      avatar.root.updateWorldMatrix(true,true);
      return Array.from({length:hand.geometry.attributes.position.count},(_,index)=>
        avatar.root.worldToLocal(hand.localToWorld(hand.getVertexPosition(index,new THREE.Vector3()))));
    }
    for(const cancelledReturn of [false,true]) {
      player.reset();
      player.draw(cancelledReturn?'working':'waiting',cancelledReturn?'writing':'waiting',0,false,0,false);
      player.draw(cancelledReturn?'done':'working',cancelledReturn?'completed':'writing',0,false,0,true);
      const frames=cancelledReturn?50:16;
      for(let i=0;i<frames;i++)player.draw(cancelledReturn?'done':'working',cancelledReturn?'completed':'writing',i/60,false,1/60,true);
      const before=pose(avatar),weights=[...hand.morphTargetInfluences],vertices=fingers();
      assert.ok(weights[0]>0 && weights[0]<1,'interruption occurs during finger curling');
      const action=cancelledReturn?'writing':'designing';
      player.draw('working',action,(frames-1)/60,false,0,true);
      pose(avatar).forEach((value,index)=>assert.ok(Math.abs(value-before[index])<1e-8));
      assert.deepEqual(hand.morphTargetInfluences,weights);
      fingers().forEach((vertex,index)=>assert.ok(vertex.distanceTo(vertices[index])<1e-8,'visible finger surface stays continuous'));
      for(let i=1;i<=80;i++) {
        player.draw('working',action,(frames+i)/60,false,1/60,true);
        if(avatar.pen.userData.held) {
          assert.equal(hand.morphTargetInfluences[0],1,'held barrel has a full finger grip');
          assert.equal(hand.morphTargetInfluences[1],0);
        }
      }
      assert.equal(player.pending,false);
    }
    // Reading starts with a full page grip, which must clear before grasping a pen.
    player.reset();player.draw('working','reading',0,false,0,false);
    for(let i=0;i<80;i++) {
      player.draw('working','writing',i/60,false,1/60,true);
      if(avatar.pen.userData.held)assert.deepEqual(hand.morphTargetInfluences,[1,0]);
    }
    for(let i=0;i<80;i++) {
      player.draw('working','reading',2+i/60,false,1/60,true);
      if(avatar.pen.userData.held)assert.deepEqual(hand.morphTargetInfluences,[1,0]);
    }
    assert.deepEqual(hand.morphTargetInfluences,[0,1]);
    resources.dispose();
  }
});
