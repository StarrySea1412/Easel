import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadTsModule } from '../../../../tests/load-ts.mjs';

const { createProviderStudyCharacter } = await loadTsModule('../providerCharacterGeometry.ts', import.meta.url);
const providers = ['doubao', 'deepseek', 'unknown'];

function inspect(root) {
  root.updateMatrixWorld(true);
  const stats = { meshes: 0, triangles: 0, geometries: new Set(), materials: new Set() };
  root.traverse((part) => {
    if (!part.isMesh) return;
    stats.meshes++;
    stats.geometries.add(part.geometry);
    stats.materials.add(part.material);
    const positions = part.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const world = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(part.matrixWorld);
      assert.ok(world.toArray().every(Number.isFinite), 'every transformed vertex is finite');
    }
    stats.triangles += (part.geometry.index?.count ?? positions.count) / 3;
  });
  return { ...stats, bounds: new THREE.Box3().setFromObject(root) };
}
function release(stats) {
  stats.geometries.forEach((geometry) => geometry.dispose());
  stats.materials.forEach((material) => material.dispose());
}

for (const provider of providers) {
  test(`${provider}: both poses stay above floor and fit the review stage`, (t) => {
    const measurements = {};
    for (const pose of ['standing', 'seated']) {
      const stats = inspect(createProviderStudyCharacter(provider, pose));
      try {
        const { min, max } = stats.bounds;
        assert.ok(min.y >= -.001 && min.y < .05, 'feet remain supported at the floor');
        assert.ok(min.x >= -1.1 && max.x <= 1.1, 'body fits the podium width');
        assert.ok(min.z > -.6 && max.z < 1, 'body fits stage depth including seated legs');
        assert.ok(max.y > 1.8 && max.y < 2.9, 'camera can frame the complete character');
        assert.ok(stats.meshes <= 60 && stats.triangles < 100000, 'single-review model resource ceiling');
        assert.ok(stats.materials.size <= 16 && stats.materials.size < stats.meshes / 2, 'materials are shared across repeated pieces');
        measurements[pose] = { height: max.y, front: max.z };
        t.diagnostic(`${pose}: ${stats.meshes} meshes, ${stats.triangles} triangles, ${stats.geometries.size} geometries, ${stats.materials.size} materials`);
      } finally { release(stats); }
    }
    assert.ok(measurements.standing.height - measurements.seated.height > .3, 'seated silhouette lowers with the pelvis');
    assert.ok(measurements.seated.front > measurements.standing.front, 'seated legs and hands project toward the desk');
  });
}

function signedVolume(geometry) {
  const p = geometry.getAttribute('position'), index = geometry.index;
  let volume = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < (index?.count ?? p.count); i += 3) {
    a.fromBufferAttribute(p, index ? index.getX(i) : i);
    b.fromBufferAttribute(p, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(p, index ? index.getX(i + 2) : i + 2);
    volume += a.dot(b.cross(c)) / 6;
  }
  return volume;
}

for (const provider of providers) {
  test(`${provider}: continuous surfaces face outward and have finite lighting normals`, () => {
    for (const pose of ['standing', 'seated']) {
      const root = createProviderStudyCharacter(provider, pose), stats = inspect(root);
      try {
        root.traverse((part) => {
          if (!part.isMesh) return;
          const normal = part.geometry.getAttribute('normal');
          for (let i = 0; i < normal.count; i++) assert.ok([normal.getX(i), normal.getY(i), normal.getZ(i)].every(Number.isFinite));
          if (part.name.startsWith('continuous-') && !part.name.includes('hair')) {
            assert.ok(signedVolume(part.geometry) > .0001, `${part.name} is outward-facing, not an inside-out shell`);
          }
        });
        const torso = root.getObjectByName('continuous-torso');
        for (const side of [-1, 1]) {
          const arm = root.getObjectByName(`continuous-sleeve-${side}`);
          const leg = root.getObjectByName(`continuous-leg-${side}`);
          const torsoBounds = new THREE.Box3().setFromObject(torso);
          assert.ok(torsoBounds.intersectsBox(new THREE.Box3().setFromObject(arm)), 'sleeve joins the shoulder');
          assert.ok(torsoBounds.intersectsBox(new THREE.Box3().setFromObject(leg)), 'leg joins the pelvis');
        }
      } finally { release(stats); }
    }
  });
}
