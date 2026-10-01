import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import modelUrl from '../../../assets/office-character/easel-cat-study.glb?url';
import { createStudyWorkstation } from './studyWorkstation';
import { STUDY_FURS, STUDY_SWEATERS, type StudyAppearance, type StudyPresetId, type StudyView } from './studyPresets';

interface Options {
  host: HTMLDivElement;
  preset: StudyPresetId;
  appearance: StudyAppearance;
  paused: boolean;
  view: StudyView;
  onReady: () => void;
  onStage: (stage: number) => void;
  onError: (message: string) => void;
}

/** A standalone asset-review scene; it never invents live agent events. */
export function createCharacterStudyRuntime(options: Options) {
  const { host } = options;
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' }); }
  catch { options.onError('当前浏览器无法打开三维预览，请启用硬件加速后重试。'); return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0xefeee7);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', '原创蒙皮猫角色与岗位工位三维样板，可拖动旋转');
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, .05, 80);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false; controls.enableDamping = false;
  controls.minDistance = 2; controls.maxDistance = 10;
  controls.minZoom = .65; controls.maxZoom = 2.3;
  controls.minPolarAngle = .22; controls.maxPolarAngle = Math.PI * .53;
  scene.add(new THREE.HemisphereLight(0xfffaf0, 0xb1b9af, 2.0));
  const sun = new THREE.DirectionalLight(0xfff2dc, 3.3);
  sun.position.set(-3.8, 6.8, 4.3); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); sun.shadow.normalBias = .018; sun.shadow.bias = -.00008;
  Object.assign(sun.shadow.camera, { left: -3.5, right: 3.5, top: 3.5, bottom: -3.5, near: .5, far: 16 });
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xe8f1f2, 1.5); fill.position.set(4, 3, -3); scene.add(fill);
  const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xe7e8de, roughness: 1 });
  const floorGeometry = new THREE.CircleGeometry(3.3, 80);
  const floor = new THREE.Mesh(floorGeometry, floorMaterial); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.position.y = -.005; scene.add(floor);
  const penGeometry = new THREE.CylinderGeometry(.007, .0045, 1, 12);
  const penMaterial = new THREE.MeshStandardMaterial({ color: 0x42574c, roughness: .7 });
  const pen = new THREE.Mesh(penGeometry, penMaterial); pen.name = 'Held_stylus'; pen.castShadow = true; scene.add(pen);
  let preset = options.preset, appearance = options.appearance, paused = options.paused, view = options.view;
  let workstation = createStudyWorkstation(preset); scene.add(workstation.root);
  let model: THREE.Group | null = null;
  const bones = new Map<string, THREE.Bone>(), skinned: THREE.SkinnedMesh[] = [];
  let disposed = false, frameId = 0, elapsed = 0, previous = 0, lastStage = -1;
  let intersects = true, failed = false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let modelMaterials: THREE.MeshStandardMaterial[] = [];

  function applyAppearance() {
    const fur = STUDY_FURS.find((item) => item.id === appearance.fur) || STUDY_FURS[0];
    const sweater = STUDY_SWEATERS.find((item) => item.id === appearance.sweater) || STUDY_SWEATERS[0];
    const colors: Record<string, string> = { Fur: fur.color, Face_cream: fur.cream, Fur_markings: fur.marking, Sweater: sweater.color, Knit_trim: sweater.trim, Stitches: sweater.trim };
    modelMaterials.forEach((material) => { if (colors[material.name]) material.color.set(colors[material.name]); });
    invalidate();
  }
  function frameCamera() {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    const halfHeight = view === 'hands' ? .54 : view === 'work' ? 1.38 : 1.27;
    camera.top = halfHeight; camera.bottom = -halfHeight; camera.left = -halfHeight * width / height; camera.right = halfHeight * width / height;
    camera.zoom = 1;
    const cameras: Record<StudyView, { from: number[]; target: number[] }> = {
      work: { from: preset === 'research' ? [3.6, 2.9, 4.8] : preset === 'design' ? [3.5, 3.15, 4.2] : [-3.9, 2.8, 4.8], target: [0, 1.13, .40] },
      front: { from: [0, 1.55, 6], target: [0, 1.15, .2] },
      side: { from: [6, 2.1, .25], target: [0, 1.12, .25] },
      back: { from: [-1.8, 2.4, -5], target: [0, 1.1, .1] },
      hands: { from: [1.65, 2.7, 2.8], target: [.0, 1.04, .61] },
    };
    camera.position.fromArray(cameras[view].from); controls.target.fromArray(cameras[view].target);
    camera.updateProjectionMatrix(); controls.update(); invalidate();
  }

  const scratch = { shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), direction: new THREE.Vector3(), bend: new THREE.Vector3(), target: new THREE.Vector3(), quaternion: new THREE.Quaternion(), grip: new THREE.Vector3() };
  function aim(bone: THREE.Bone, child: THREE.Bone, target: THREE.Vector3) {
    const local = target.clone(); bone.parent!.worldToLocal(local); local.sub(bone.position).normalize();
    bone.quaternion.setFromUnitVectors(child.position.clone().normalize(), local);
    bone.updateMatrixWorld(true);
  }
  function poseArm(side: 'L' | 'R', target: THREE.Vector3) {
    const upper = bones.get(`UpperArm_${side}`), fore = bones.get(`Forearm_${side}`), hand = bones.get(`Hand_${side}`);
    if (!upper || !fore || !hand) return;
    upper.getWorldPosition(scratch.shoulder); fore.getWorldPosition(scratch.elbow);
    const l1 = fore.position.length(), l2 = hand.position.length();
    scratch.direction.copy(target).sub(scratch.shoulder); const length = THREE.MathUtils.clamp(scratch.direction.length(), Math.abs(l1 - l2) + .001, l1 + l2 - .001); scratch.direction.normalize();
    scratch.bend.copy(scratch.elbow).sub(scratch.shoulder).addScaledVector(scratch.direction, -scratch.elbow.clone().sub(scratch.shoulder).dot(scratch.direction)).normalize();
    const along = (l1 * l1 - l2 * l2 + length * length) / (2 * length), height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    scratch.elbow.copy(scratch.shoulder).addScaledVector(scratch.direction, along).addScaledVector(scratch.bend, height);
    aim(upper, fore, scratch.elbow); aim(fore, hand, target);
    // Maintain a palm-down contact while the forearm follows the new work surface.
    fore.getWorldQuaternion(scratch.quaternion); hand.quaternion.copy(scratch.quaternion.invert());
    hand.updateMatrixWorld(true);
  }
  function pose() {
    if (!model) return;
    for (const bone of bones.values()) bone.quaternion.identity();
    const cycle = elapsed % 24, stage = cycle < 5 ? 0 : cycle < 13 ? 1 : cycle < 19 ? 2 : 3;
    if (stage !== lastStage) { lastStage = stage; options.onStage(stage); }
    const active = stage === 1;
    const head = bones.get('Head'), chest = bones.get('Chest');
    if (head) { head.rotation.x = stage === 2 ? .025 : active ? .10 : .065; head.rotation.y = preset === 'research' ? -.14 + Math.sin(elapsed * .38) * .035 : preset === 'writing' && !active ? .20 : -.025; }
    if (chest) chest.rotation.x = (active ? .006 : -.012) + Math.sin(elapsed * 1.1) * .002;
    model.updateMatrixWorld(true);
    const left = workstation.contactLeft.clone(), right = workstation.contactRight.clone();
    if (preset === 'writing' && active) {
      left.y += Math.max(0, Math.sin(elapsed * 4.8)) * .004;
      right.y += Math.max(0, Math.sin(elapsed * 5.4 + 1)) * .004;
    }
    if (preset === 'research') { right.z += Math.sin(elapsed * .55) * .018; right.x += Math.sin(elapsed * .37) * .02; }
    if (preset === 'design' && active) { right.x += Math.sin(elapsed * .9) * .025; right.z += Math.cos(elapsed * .8) * .015; }
    poseArm('L', left); poseArm('R', right);
    if (preset === 'writing' && active) for (const side of ['L', 'R']) for (let finger = 0; finger < 3; finger++) {
      const bone = bones.get(`Finger_${side}_${finger}`); if (bone) bone.rotation.x = Math.max(0, Math.sin(elapsed * 5.6 + finger * 1.8 + (side === 'R' ? 2 : 0))) * .12;
    }
    if (preset === 'design') {
      for (let finger = 0; finger < 3; finger++) { const bone = bones.get(`Finger_R_${finger}`); if (bone) bone.rotation.x = .31; }
      const thumb = bones.get('Thumb_R'); if (thumb) thumb.rotation.z = -.19;
    }
    const blinkPhase = elapsed % 5.9, blink = blinkPhase > 5.55 ? Math.sin((blinkPhase - 5.55) / .35 * Math.PI) : 0;
    for (const mesh of skinned) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[0] = blink;
    model.updateMatrixWorld(true);
    pen.visible = preset === 'design';
    if (pen.visible) {
      const grip = model.getObjectByName('Grip_R');
      if (grip) {
        grip.getWorldPosition(scratch.grip);
        scratch.target.copy(workstation.penTarget);
        scratch.target.x += active ? Math.sin(elapsed * .9) * .025 : 0;
        scratch.target.z += active ? Math.cos(elapsed * .8) * .015 : 0;
        if (!active) scratch.target.y += .018;
        scratch.direction.copy(scratch.grip).sub(scratch.target); const distance = scratch.direction.length();
        pen.position.copy(scratch.target).addScaledVector(scratch.direction, .5); pen.scale.y = distance + .055;
        pen.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), scratch.direction.normalize());
      }
    }
  }
  function shouldAnimate() { return !disposed && !failed && !document.hidden && intersects && !paused && !reduced.matches && Boolean(model); }
  function render(time = 0) {
    frameId = 0; if (disposed || failed) return;
    if (shouldAnimate()) elapsed += previous ? Math.min(.05, (time - previous) / 1000) : 0;
    previous = time;
    pose(); renderer.render(scene, camera);
    if (shouldAnimate()) frameId = requestAnimationFrame(render);
  }
  function invalidate() { if (!frameId && !disposed && !failed) { previous = 0; frameId = requestAnimationFrame(render); } }
  function visibility() { previous = 0; invalidate(); }
  function contextLost(event: Event) { event.preventDefault(); failed = true; options.onError('三维画面已暂停，重新打开样板可恢复预览。'); }
  const resize = new ResizeObserver(frameCamera); resize.observe(host);
  const intersection = new IntersectionObserver(([entry]) => { intersects = Boolean(entry?.isIntersecting); visibility(); }); intersection.observe(host);
  document.addEventListener('visibilitychange', visibility); reduced.addEventListener('change', visibility);
  controls.addEventListener('change', invalidate); renderer.domElement.addEventListener('webglcontextlost', contextLost);
  frameCamera();
  function disposeModel(value: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), skeletons = new Set<THREE.Skeleton>();
    value.traverse((object) => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); (Array.isArray(object.material) ? object.material : [object.material]).forEach((m) => materials.add(m)); } if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton); });
    geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); skeletons.forEach((s) => s.dispose());
  }
  void new GLTFLoader().loadAsync(modelUrl).then((gltf) => {
    if (disposed) { disposeModel(gltf.scene); return; }
    model = gltf.scene; model.name = 'Character_study_asset';
    const materials = new Set<THREE.MeshStandardMaterial>();
    model.traverse((object) => {
      if (object instanceof THREE.Bone) bones.set(object.name, object);
      if (object instanceof THREE.SkinnedMesh) { skinned.push(object); object.frustumCulled = false; }
      if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; (Array.isArray(object.material) ? object.material : [object.material]).forEach((m) => { if (m instanceof THREE.MeshStandardMaterial) materials.add(m); }); }
    });
    modelMaterials = [...materials]; scene.add(model); applyAppearance(); pose(); options.onReady(); invalidate();
  }).catch(() => { if (!disposed) options.onError('角色资源暂时无法载入，请重新打开样板。'); });

  return {
    setPreset(value: StudyPresetId) { if (value === preset) return; preset = value; workstation.dispose(); workstation = createStudyWorkstation(preset); scene.add(workstation.root); elapsed = 0; lastStage = -1; frameCamera(); },
    setAppearance(value: StudyAppearance) { appearance = value; applyAppearance(); },
    setPaused(value: boolean) { paused = value; previous = 0; invalidate(); },
    setView(value: StudyView) { view = value; frameCamera(); },
    restart() { elapsed = 0; lastStage = -1; previous = 0; invalidate(); },
    dispose() {
      if (disposed) return; disposed = true; cancelAnimationFrame(frameId);
      resize.disconnect(); intersection.disconnect(); document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', visibility);
      controls.removeEventListener('change', invalidate); controls.dispose(); renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      workstation.dispose(); if (model) disposeModel(model); floorGeometry.dispose(); floorMaterial.dispose(); penGeometry.dispose(); penMaterial.dispose(); sun.shadow.dispose();
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
