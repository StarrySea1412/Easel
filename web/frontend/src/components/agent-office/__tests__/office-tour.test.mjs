import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { officeTourRoute, officeTourPose } = await loadTsModule('../officeTour.ts', import.meta.url);
const { OfficeResources, createOfficeWorld, createOfficeTourAvatar, officeLayout } = await loadTsModule('../officeGeometry.ts', import.meta.url);
const { poseOfficeTourAvatar } = await loadTsModule('../officeAvatarMotion.ts', import.meta.url);

test('tour remains in perimeter aisles and covers every area without cutting through workstations', () => {
  for (const count of [1,8,12,20,50]) {
    const layout = officeLayout(count), route = officeTourRoute(layout.width,layout.depth);
    assert.equal(new Set(route.map(stop=>stop.area)).size,5);
    let previous = officeTourPose(route,0);
    for (let time=0;time<180;time+=.1) {
      const pose = officeTourPose(route,time);
      assert.ok(Math.abs(pose.x) < layout.width/2 && Math.abs(pose.z) < layout.depth/2);
      for (const station of layout.slots) {
        assert.ok(Math.abs(pose.x-station.x)>1.12 || Math.abs(pose.z-station.z)>1.15,'walking must not cross a workstation');
      }
      assert.ok(Math.hypot(pose.x-previous.x,pose.z-previous.z)<=.086,'route is continuous across turns and loop wrap');
      previous=pose;
    }
  }
});

test('tour mascot has upright legs and no live agent identity or carried desktop support', () => {
  const resources=new OfficeResources();
  const world=createOfficeWorld(resources,1);
  const mascot=createOfficeTourAvatar(resources,world.desks[0]);
  assert.equal(mascot.root.userData.agentId,undefined);
  assert.equal(mascot.root.getObjectByName('employee-footrest').visible,false);
  assert.equal(mascot.root.getObjectByName('employee-leg-left').visible,false);
  poseOfficeTourAvatar(mascot,.3,true);
  assert.notEqual(mascot.root.getObjectByName('tour-leg-0').rotation.x,0);
  assert.equal(mascot.document.visible,false); assert.equal(mascot.pen.visible,false);
  poseOfficeTourAvatar(mascot,2,false);
  assert.equal(mascot.root.getObjectByName('tour-leg-0').rotation.x,0);
  assert.equal(world.desks[0].screen.map,null,'demonstration must not replace real workstation content');
  resources.dispose();
});
