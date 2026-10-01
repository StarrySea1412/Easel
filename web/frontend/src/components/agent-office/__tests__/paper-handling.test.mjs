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
