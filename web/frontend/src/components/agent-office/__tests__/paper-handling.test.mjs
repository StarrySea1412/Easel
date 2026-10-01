import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';
const { OfficeResources, createOfficeWorld, createOfficeAvatar, poseOfficeAvatar } = await loadTsModule('../officeGeometry.ts', import.meta.url);
const { createOfficeMotionPlayer } = await loadTsModule('../officeMotionPlayer.ts', import.meta.url);
const { OFFICE_PAPER_DOCK, OFFICE_PAPER_DOCK_ROTATION, officePaperHandTarget } = await loadTsModule('../officePaper.ts', import.meta.url);
function fixture(role='researcher',species='cat') {
  const resources = new OfficeResources();
  const world=createOfficeWorld(resources,1,[{id:role,role,appearance:{id:role}}]);
  const avatar=createOfficeAvatar(resources,world.desks[0],role,{id:role,species});
  return {resources,avatar,player:createOfficeMotionPlayer(avatar)};
}
function point(avatar,object) {
  avatar.root.updateWorldMatrix(true,true);
  return avatar.root.worldToLocal(object.getWorldPosition(new THREE.Vector3()));
}
function snapshot(avatar) {
  return [...avatar.document.position,...avatar.document.quaternion,...point(avatar,avatar.leftWrist),...point(avatar,avatar.rightWrist),
    ...avatar.leftWrist.getWorldQuaternion(new THREE.Quaternion()),...avatar.rightWrist.getWorldQuaternion(new THREE.Quaternion()),
    ...avatar.leftHand.mesh.morphTargetInfluences,...avatar.rightHand.mesh.morphTargetInfluences];
}
function parked(avatar) {
  assert.equal(avatar.document.visible,true);
  assert.equal(avatar.document.userData.engaged,false);
  assert.ok(avatar.document.position.distanceTo(OFFICE_PAPER_DOCK)<1e-9);
  assert.ok(avatar.document.quaternion.angleTo(OFFICE_PAPER_DOCK_ROTATION)<1e-7);
}
function near(a,b,limit=1e-8) { assert.ok(a.every((n,i)=>Math.abs(n-b[i])<limit),`pose jumps ${Math.max(...a.map((n,i)=>Math.abs(n-b[i])))}`); }

test('one paper remains parked above the desktop and behind the keyboard after work and terminal states',()=>{
  const {resources,avatar}=fixture(); const document=avatar.document;
  for(const [state,action] of [['waiting','waiting'],['working','reading'],['working','designing'],['done','completed'],['error','error'],['stopped','stopped']]) {
    poseOfficeAvatar(avatar,state,1,false,action);
    assert.equal(avatar.document,document);assert.equal(document.visible,true);
    if(action!=='reading') {
      parked(avatar);document.updateMatrix();
      const bounds=new THREE.Box3().setFromObject(document);
      assert.ok(!bounds.isEmpty());
      for(const x of [-.295,.295]) for(const y of [-.215,.215]) for(const z of [-.015,.04]) {
        const corner=new THREE.Vector3(x,y,z).applyMatrix4(document.matrix);
        assert.ok(corner.y>.3425,'paper above desk');
        assert.ok(corner.z<-.46,'paper behind keyboard');
      }
    }
  }
  resources.dispose();
});

test('paper pickup/return preserve hand contact and fixed limbs across all roles and species',()=>{
  for(const [i,role] of ['coordinator','researcher','designer','writer','tester','reviewer'].entries()) {
    const {resources,avatar,player}=fixture(role,['cat','rabbit','fox','bear'][i%4]);
    let time=0;player.draw('waiting','waiting',time,false,0,true);
    for(const [state,action] of [['working','reading'],['working','writing'],['done','completed']]) {
      for(let frame=0;frame<80;frame++,time+=1/60) {
        player.draw(state,action,time,false,1/60,true);
        for(const side of ['left','right']) {
          const wrist=point(avatar,avatar[`${side}Wrist`]),elbow=point(avatar,avatar[`${side}Elbow`]),shoulder=point(avatar,avatar[`${side}Arm`]);
          assert.ok(Math.abs(wrist.distanceTo(elbow)-.27)<1e-8);assert.ok(Math.abs(elbow.distanceTo(shoulder)-.25)<1e-8);
          assert.ok(wrist.y>.395,`${role}/${action}: wrist clears desktop`);
          if(avatar.document.userData.engaged && (side==='left'|| action==='reading') && avatar.document.userData.handContact===1) {
            const target=officePaperHandTarget(avatar.document,side,new THREE.Vector3());
            assert.ok(target.distanceTo(wrist)<1e-8,`${role}/${action}/${frame}: ${side} lost paper contact ${target.distanceTo(wrist)}`);
          }
        }
        avatar.document.updateMatrix();
        for(const x of [-.295,.295]) for(const y of [-.215,.215]) {
          const corner=new THREE.Vector3(x,y,-.015).applyMatrix4(avatar.document.matrix);
          assert.ok(corner.y>.3425,`${role}/${action}: clipboard below table`);
        }
      }
      assert.equal(player.pending,false);
    }
    parked(avatar);resources.dispose();
  }
});

test('interrupted pickup, reading, pen switch and return continue from the displayed pose',()=>{
  for(const frames of [5,20,45,62]) {
    for(const destination of [['working','reading'],['working','writing'],['working','designing'],['error','error']]) {
      const {resources,avatar,player}=fixture();
      player.draw('waiting','waiting',0,false,0,true);
      for(let i=0;i<frames;i++)player.draw('working','reading',i/60,false,1/60,true);
      const before=snapshot(avatar);
      player.draw(...destination,frames/60,false,0,true);
      near(snapshot(avatar),before);
      for(let i=0;i<90;i++)player.draw(...destination,(frames+i)/60,false,1/60,true);
      const returning=snapshot(avatar);
      player.draw('stopped','stopped',3,false,0,true);
      near(snapshot(avatar),returning);
      for(let i=0;i<frames;i++)player.draw('stopped','stopped',3+i/60,false,1/60,true);
      const stopped=snapshot(avatar);
      player.draw('working','reading',4,false,0,true);
      near(snapshot(avatar),stopped);
      resources.dispose();
    }
  }
});

test('paused pickup freezes paper, fingers and wrists; seek/reset settles directly without replaying old work',()=>{
  const {resources,avatar,player}=fixture();
  player.draw('waiting','waiting',0,false,0,true);
  for(let i=0;i<35;i++)player.draw('working','reading',i/60,false,1/60,true);
  const paused=snapshot(avatar);
  for(let i=0;i<6;i++)player.draw('working','reading',34/60,false,.06,false);
  near(snapshot(avatar),paused);
  player.draw('done','completed',1,false,0,false);parked(avatar);
  const done=snapshot(avatar);player.draw('done','completed',100,false,.06,true);near(snapshot(avatar),done);
  player.reset();player.draw('working','reading',20,false,0,false);
  const seek=snapshot(avatar);poseOfficeAvatar(avatar,'working',20,false,'reading');near(snapshot(avatar),seek);
  resources.dispose();
});

test('held-page palms follow its plane and both physical finger-pad anchors remain on the paper',()=>{
  for (const species of ['cat','rabbit','fox','bear']) {
    const {resources,avatar}=fixture('researcher',species);
    poseOfficeAvatar(avatar,'working',1,false,'reading');
    avatar.root.updateWorldMatrix(true,true);
    const pageNormal=new THREE.Vector3(0,0,1).applyQuaternion(avatar.document.getWorldQuaternion(new THREE.Quaternion()));
    for (const side of ['left','right']) {
      const wrist=avatar[`${side}Wrist`];
      const palmNormal=new THREE.Vector3(0,1,0).applyQuaternion(wrist.getWorldQuaternion(new THREE.Quaternion()));
      assert.ok(palmNormal.dot(pageNormal)>.999999,'palm turns with the page instead of staying horizontal');
      const contact=wrist.localToWorld(new THREE.Vector3(0,-.025,-.08));
      const page=avatar.document.localToWorld(new THREE.Vector3(side==='left'?-.22:.22,avatar.document.userData.gripY,.042));
      assert.ok(contact.distanceTo(page)<1e-8,`${species}/${side}: rotated finger pad touches the held page`);
    }
    resources.dispose();
  }
});

test('interrupting return after the pen releases never attaches the free right paw to the paper',()=>{
  for(const role of ['coordinator','researcher','designer','writer','tester','reviewer']) {
    const {resources,avatar,player}=fixture(role);
    // Pen releases at .65, while the left paw keeps holding paper until .75.
    for(const frames of [45,46,48,50,51]) for(const destination of [
      ['waiting','waiting'],['working','executing'],['working','delegating'],['thinking','thinking'],['error','error'],
    ]) {
      player.reset();player.draw('working','writing',2,false,0,false);
      player.draw('done','completed',2,false,0,true);
      for(let i=0;i<frames;i++)player.draw('done','completed',2+i/60,false,1/60,true);
      assert.equal(avatar.pen.userData.held,false);
      assert.equal(avatar.document.userData.engaged,true);
      assert.equal(avatar.rightHand.mesh.morphTargetInfluences[1],0);
      const before=snapshot(avatar),pen=point(avatar,avatar.pen);
      player.draw(...destination,2+(frames-1)/60,false,0,true);
      near(snapshot(avatar),before);
      assert.ok(point(avatar,avatar.pen).distanceTo(pen)<1e-8);
      for(let i=0;i<80;i++) {
        player.draw(...destination,3+i/60,false,1/60,true);
        assert.equal(avatar.rightHand.mesh.morphTargetInfluences[1],0,'free paw never acquires a page grip');
        for(const side of ['left','right'])assert.ok(point(avatar,avatar[`${side}Wrist`]).y>.395);
      }
      assert.equal(player.pending,false);parked(avatar);
    }
    resources.dispose();
  }
});

test('paper-to-pen interruptions preserve both wrists and fingers before and after pen attachment',()=>{
  const {resources,avatar,player}=fixture('writer');
  for(const frames of [5,16,21,25,45,50,65]) for(const destination of [
    ['working','reading'],['working','designing'],['thinking','thinking'],['done','completed'],
  ]) {
    player.reset();player.draw('working','reading',2,false,0,false);
    player.draw('working','writing',2,false,0,true);
    for(let i=0;i<frames;i++)player.draw('working','writing',2+i/60,false,1/60,true);
    const before=snapshot(avatar),pen=point(avatar,avatar.pen);
    player.draw(...destination,2+(frames-1)/60,false,0,true);
    near(snapshot(avatar),before);
    assert.ok(point(avatar,avatar.pen).distanceTo(pen)<1e-8);
  }
  resources.dispose();
});
