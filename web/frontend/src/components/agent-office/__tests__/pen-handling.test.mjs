import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';
const { OfficeResources, createOfficeWorld, createOfficeAvatar, poseOfficeAvatar } = await loadTsModule('../officeGeometry.ts', import.meta.url);
const { captureOfficeMotionPose } = await loadTsModule('../officeAvatarMotion.ts', import.meta.url);
const { createOfficeMotionPlayer } = await loadTsModule('../officeMotionPlayer.ts', import.meta.url);
const { OFFICE_PEN_DOCK } = await loadTsModule('../officePen.ts', import.meta.url);

function fixture(role='designer', species='cat') {
  const resources = new OfficeResources();
  const desk = createOfficeWorld(resources,1,[{ id:role, role, appearance:{id:role} }]).desks[0];
  const avatar = createOfficeAvatar(resources,desk,role,{id:role,species});
  return {resources,desk,avatar,player:createOfficeMotionPlayer(avatar)};
}
function point(avatar, object, local = new THREE.Vector3()) {
  avatar.root.updateWorldMatrix(true,true);
  return avatar.root.worldToLocal(object.localToWorld(local.clone()));
}
function penPose(avatar) {
  avatar.root.updateWorldMatrix(true,true);
  return {center:point(avatar,avatar.pen),tip:point(avatar,avatar.pen,new THREE.Vector3(0,-.11,0)),right:point(avatar,avatar.rightWrist)};
}
function parked(avatar) {
  const pose=penPose(avatar);
  assert.ok(pose.center.distanceTo(OFFICE_PEN_DOCK)<1e-8);
  assert.ok(pose.tip.distanceTo(OFFICE_PEN_DOCK.clone().add(new THREE.Vector3(0,-.11,0)))<1e-8);
  assert.equal(avatar.pen.visible,true);
  assert.equal(avatar.pen.userData.held,false);
}

test('one detailed pen parks upright in a real stand clear of the tablet, mouse, keyboard and shortest desk edge',()=>{
  for (const role of ['coordinator','researcher','designer','writer','tester','reviewer','generic']) {
    const {resources,avatar,desk}=fixture(role);
    poseOfficeAvatar(avatar,'waiting',0,false,'waiting'); parked(avatar);
    const stand=avatar.root.getObjectByName('office-pen-stand');
    stand.geometry.computeBoundingBox();
    const box=stand.geometry.boundingBox.clone().translate(stand.position);
    assert.ok(box.min.y >= .3425 && box.min.y <= .346);
    assert.ok(box.max.z + .56 < .434, 'stand stays inside even the shortest desktop');
    assert.ok(box.min.z > -.245, 'stand is in front of mouse and keyboard bounds');
    assert.ok(box.min.x > .41, 'stand clears tablet right edge .41 in avatar space');
    assert.ok(box.min.y < OFFICE_PEN_DOCK.y-.11 && box.max.y > OFFICE_PEN_DOCK.y-.11, 'nib rests inside the sleeve');
    const pens=[]; avatar.root.traverse(o=>{if(o.name==='drawing-stylus')pens.push(o)});
    assert.equal(pens.length,1);
    assert.equal(avatar.pen.geometry.type,'LatheGeometry');
    assert.equal(desk.root.rotation.y,avatar.root.rotation.y);
    resources.dispose();
  }
});

test('pickup and return boundaries keep the same pen continuous and change ownership only at the stand',()=>{
  const {resources,avatar}=fixture();
  for (const kind of ['pickup','stow']) {
    poseOfficeAvatar(avatar,'working',1,false,kind==='pickup'?'executing':'designing');
    const from=captureOfficeMotionPose(avatar);
    const state=kind==='pickup'?'working':'done',action=kind==='pickup'?'designing':'completed';
    const apply=p=>{poseOfficeAvatar(avatar,state,1,false,action,{from,amount:p*p*(3-2*p),pen:{kind,progress:p}});return penPose(avatar)};
    for (const boundary of kind==='pickup'?[0,.30,.48,1]:[0,.18,.48,.65,1]) {
      const a=apply(Math.max(0,boundary-.00001)),b=apply(Math.min(1,boundary+.00001));
      for(const key of ['center','tip','right']) assert.ok(a[key].distanceTo(b[key])<.0001,`${kind}/${boundary}/${key} jumps`);
    }
    apply(kind==='pickup'?.299:.651); parked(avatar);
    apply(kind==='pickup'?.301:.649); assert.equal(avatar.pen.userData.held,true);
  }
  resources.dispose();
});

test('taking and returning a pen preserve bone length, pen/table clearance and a stationary seated root',()=>{
  const roles=['coordinator','researcher','designer','writer','tester','reviewer'];
  for (const [index,role] of roles.entries()) {
    const {resources,avatar,player}=fixture(role,['cat','rabbit','fox','bear'][index%4]);
    const root=avatar.root.position.clone();
    let time=0;
    player.draw('waiting','waiting',time,false,0,true);
    for(const [state,action] of [['working','designing'],['done','completed'],['working','writing'],['error','error']]) {
      for(let i=0;i<95;i++,time+=1/60) {
        player.draw(state,action,time,false,1/60,true);
        const pose=penPose(avatar);
        assert.ok(pose.tip.y>.3425,`${role}/${action}: nib below table`);
        assert.ok(pose.right.y>.395,`${role}/${action}: wrist below clearance`);
        const a=point(avatar,avatar.rightArm),b=point(avatar,avatar.rightElbow),c=pose.right;
        assert.ok(Math.abs(a.distanceTo(b)-.25)<1e-8);assert.ok(Math.abs(b.distanceTo(c)-.27)<1e-8);
        if(i%12===0) {
          const mesh=avatar.bodySkin.mesh,g=mesh.geometry;
          mesh.skeleton.update();
          for(let n=0;n<g.attributes.position.count;n++) {
            if(g.attributes.skinWeight.getW(n)<.999 || g.attributes.skinIndex.getW(n)!==6)continue;
            const vertex=mesh.applyBoneTransform(n,new THREE.Vector3().fromBufferAttribute(g.attributes.position,n));
            avatar.root.worldToLocal(mesh.localToWorld(vertex));
            assert.ok(vertex.y>.3425,`${role}/${action} frame ${i}: palm y=${vertex.y}, wrist=${c.toArray()}, vertex ${n}`);
          }
        }
        assert.deepEqual(avatar.root.position,root);
      }
      assert.equal(player.pending,false);
      if(state!=='working')parked(avatar);
    }
    resources.dispose();
  }
});

test('pause, early cancellation, interrupted return and time seeking never duplicate or lose the pen',()=>{
  const {resources,avatar,player}=fixture('writer');
  player.draw('waiting','waiting',0,false,0,true);
  player.draw('working','writing',0,false,0,true);
  player.draw('working','writing',.06,false,.06,true);
  player.draw('stopped','stopped',.06,false,0,true);
  parked(avatar);
  player.reset(); player.draw('working','writing',18,false,0,false);
  assert.equal(avatar.pen.userData.held,true);
  player.draw('done','completed',18,false,0,true);
  player.draw('done','completed',18.06,false,.06,true);
  const before=penPose(avatar);
  player.draw('done','completed',18.06,false,.06,false);
  assert.deepEqual(penPose(avatar),before);
  player.draw('working','writing',18.06,false,0,true);
  assert.ok(penPose(avatar).center.distanceTo(before.center)<1e-8,'interrupting return preserves world position');
  player.reset(); player.draw('done','completed',48,false,0,false); parked(avatar);
  assert.equal(player.pending,false);
  resources.dispose();
});
