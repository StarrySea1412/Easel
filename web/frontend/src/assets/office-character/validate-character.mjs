/** Structural QA; this cannot judge whether a character looks natural. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../../../node_modules/three/build/three.module.js';
import { GLTFLoader } from '../../../node_modules/three/examples/jsm/loaders/GLTFLoader.js';

const input = await readFile(new URL('./easel-cat-study.glb', import.meta.url));
const bytes = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
assert.equal(input.readUInt32LE(0), 0x46546c67, 'valid glTF binary header');
const jsonSize = input.readUInt32LE(12), gltf = JSON.parse(input.subarray(20, 20 + jsonSize).toString());
assert.equal(gltf.asset.version, '2.0');
for (const animation of gltf.animations) {
  const targetPaths = animation.channels.map((channel) => `${channel.target.node}:${channel.target.path}`);
  assert.equal(new Set(targetPaths).size, targetPaths.length, `${animation.name} has unique property channels`);
}
const loaded = await new GLTFLoader().parseAsync(bytes, '');
const meshes = [], bones = new Set(), morphs = [];
loaded.scene.traverse((node) => { if (node.isSkinnedMesh) meshes.push(node); if (node.isBone) bones.add(node.name); if (node.morphTargetInfluences) morphs.push(node); });
assert.ok(meshes.length > 0, 'contains real skinned meshes');
assert.ok(bones.size >= 20, 'contains articulated skeleton');
let weightedVertices = 0, deformingVertices = 0;
for (const mesh of meshes) {
  const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
  assert.equal(position.count, skinIndex.count); assert.equal(position.count, skinWeight.count);
  for (let i = 0; i < position.count; i++) {
    for (const axis of ['X', 'Y', 'Z']) assert.ok(Number.isFinite(position[`get${axis}`](i)), `${mesh.name} finite vertex`);
    const sum = skinWeight.getX(i) + skinWeight.getY(i) + skinWeight.getZ(i) + skinWeight.getW(i);
    assert.ok(Math.abs(sum - 1) < 1e-5, `${mesh.name} normalized weights`);
    for (const axis of ['X', 'Y', 'Z', 'W']) assert.ok(skinIndex[`get${axis}`](i) < mesh.skeleton.bones.length, `${mesh.name} valid joint`);
    if (skinWeight.getY(i) > .001 && skinWeight.getX(i) > .001) weightedVertices++;
  }
}
assert.ok(weightedVertices > 1000, 'joint transitions use blended weights');
loaded.scene.updateMatrixWorld(true);
const hand = loaded.scene.getObjectByName('Finger_R_1');
assert.ok(hand, 'finger joint exists');
const fingerMesh = loaded.scene.getObjectByName('Finger_R_1_mesh');
const before = [];
fingerMesh.skeleton.update();
for (let i = 0; i < fingerMesh.geometry.attributes.position.count; i++) before.push(fingerMesh.getVertexPosition(i, new THREE.Vector3()).clone());
hand.rotation.x = .35; loaded.scene.updateMatrixWorld(true); fingerMesh.skeleton.update();
for (let i = 0; i < before.length; i++) if (fingerMesh.getVertexPosition(i, new THREE.Vector3()).distanceTo(before[i]) > .00001) deformingVertices++;
assert.ok(deformingVertices > 50, 'finger rotation actually deforms the weighted surface');
assert.ok(morphs.length >= 2, 'eyelid blink morphs are present');
for (const anchor of ['Grip_L', 'Grip_R', 'Gaze', 'Paper_support_L']) assert.ok(loaded.scene.getObjectByName(anchor), `${anchor} exported`);
console.log(JSON.stringify({ status: 'PASS', bytes: input.length, skinnedMeshes: meshes.length, bones: bones.size, blendedWeightVertices: weightedVertices, fingerVerticesDeformed: deformingVertices, blinkMeshes: morphs.length, animations: loaded.animations.map((clip) => clip.name), browserVisualQA: 'not covered', backendExecution: 'not covered' }, null, 2));
