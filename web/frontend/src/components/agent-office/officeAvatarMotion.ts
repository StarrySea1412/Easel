import * as THREE from 'three';
import type { OfficeAvatar } from './officeGeometry';
import type { OfficeAgent } from '../../lib/agentOffice';

type Action = NonNullable<OfficeAgent['action']>['kind'];
const upperLength = 0.25, lowerLength = 0.27;
const forward = new THREE.Vector3(0, 0, -1);
// Scratch objects are reused across sequential avatar updates; no per-frame geometry or allocations.
const target = new THREE.Vector3(), direction = new THREE.Vector3(), pole = new THREE.Vector3();
const elbowPoint = new THREE.Vector3(), foreDirection = new THREE.Vector3();
const inverseBody = new THREE.Matrix4(), absoluteFore = new THREE.Quaternion(), inverseArm = new THREE.Quaternion();
const wristRotation = new THREE.Quaternion();
const left = new THREE.Vector3(), right = new THREE.Vector3(), gaze = new THREE.Vector3();

/** Fixed-length two-bone IK, with an upward/backward pole to keep elbows above the desktop. */
function reach(avatar: OfficeAvatar, side: 'left' | 'right', point: THREE.Vector3) {
  const shoulder = side === 'left' ? avatar.leftArm : avatar.rightArm;
  const elbow = side === 'left' ? avatar.leftElbow : avatar.rightElbow;
  const wrist = side === 'left' ? avatar.leftWrist : avatar.rightWrist;
  target.copy(point).applyMatrix4(inverseBody);
  direction.subVectors(target, shoulder.position);
  const distance = THREE.MathUtils.clamp(direction.length(), 0.04, upperLength + lowerLength - 0.001);
  direction.normalize();
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const bend = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  pole.set(side === 'left' ? -0.24 : 0.24, 0.8, 0.65);
  pole.addScaledVector(direction, -pole.dot(direction)).normalize();
  elbowPoint.copy(shoulder.position).addScaledVector(direction, along).addScaledVector(pole, bend);
  target.copy(shoulder.position).addScaledVector(direction, distance);
  foreDirection.subVectors(target, elbowPoint).normalize();
  direction.subVectors(elbowPoint, shoulder.position).normalize();
  shoulder.quaternion.setFromUnitVectors(forward, direction);
  absoluteFore.setFromUnitVectors(forward, foreDirection);
  inverseArm.copy(shoulder.quaternion).invert();
  elbow.quaternion.copy(inverseArm).multiply(absoluteFore);
  // Counter-rotate the wrist so paws stay level on the keyboard and the stylus stays upright.
  wristRotation.copy(avatar.body.quaternion).multiply(absoluteFore).invert();
  wrist.quaternion.copy(wristRotation);
}

function paperPoint(prop: THREE.Group, x: number, y: number, result: THREE.Vector3, holding = false) {
  prop.updateMatrix();
  result.set(x, y, 0.042).applyMatrix4(prop.matrix);
  if (!holding) { result.x -= 0.034; result.y += 0.05; }
}

/** Choreography is only a visual interpretation of the current reported action, never execution evidence. */
export function applyOfficeAvatarMotion(avatar: OfficeAvatar, state: OfficeAgent['state'], time: number, action: Action) {
  const t = (Number.isFinite(time) ? Math.max(0, time) : 0) + avatar.phase;
  const active = state === 'working' && ['executing', 'reading', 'writing', 'designing', 'delegating'].includes(action);
  const thinking = state === 'thinking';
  const animated = active || thinking;
  const cycle = t % 6;
  avatar.body.rotation.set(active ? 0.025 + Math.sin(t * 0.8) * 0.004 : 0, active ? -0.035 : 0, 0);
  avatar.body.updateMatrix(); inverseBody.copy(avatar.body.matrix).invert();
  avatar.document.visible = active && (action === 'reading' || action === 'writing');
  avatar.tablet.visible = active && action === 'designing';
  avatar.pen.visible = active && (action === 'writing' || action === 'designing');
  avatar.document.position.y = action === 'writing' ? 0.47 : 0.54;
  avatar.document.rotation.x = action === 'writing' ? -1.12 : -0.8;
  avatar.pen.rotation.set(0, 0, 0);
  // Resting hands stay in front of the body, above the near edge of the desk.
  left.set(-0.1, 0.435, -0.24); right.set(0.28, 0.435, -0.24);
  gaze.set(0.55, 0.81, -0.74); // actual monitor, relative to the seated avatar
  let stage = 'rest';
  if (active && action === 'executing') {
    // Type, inspect the monitor, then reach the real mouse. Pauses prevent perpetual hammering.
    const typing = cycle < 3.5;
    const mouseWeight = THREE.MathUtils.smoothstep(cycle, 4.2, 4.7) * (1 - THREE.MathUtils.smoothstep(cycle, 5.5, 6));
    const typingWeight = THREE.MathUtils.smoothstep(cycle, 0, 0.25) * (1 - THREE.MathUtils.smoothstep(cycle, 3.1, 3.5));
    const tap = typingWeight * Math.max(0, Math.sin(t * 12)) * 0.018;
    left.set(-0.07, 0.433 + tap, -0.36 + (typingWeight * Math.sin(t * 2.7) * 0.025));
    right.set(0.24, 0.433 + (typingWeight * Math.max(0, Math.sin(t * 12 + Math.PI)) * 0.018), -0.36);
    right.lerp(target.set(0.51, 0.437, -0.31), mouseWeight);
    stage = typing ? 'keyboard' : mouseWeight > 0.5 ? 'mouse' : 'inspect';
    const glanceWeight = THREE.MathUtils.smoothstep(cycle, 0, 0.25) * (1 - THREE.MathUtils.smoothstep(cycle, 0.55, 0.8));
    gaze.lerp(target.set(0.12, 0.39, -0.36), glanceWeight);
  } else if (active && (action === 'writing' || action === 'designing')) {
    const prop = action === 'writing' ? avatar.document : avatar.tablet;
    const inspectWeight = THREE.MathUtils.smoothstep(cycle, 3.8, 4.6) * (1 - THREE.MathUtils.smoothstep(cycle, 5.4, 6));
    const strokePhase = cycle % 2;
    const progress = (1 - Math.cos(Math.PI * strokePhase)) / 2;
    paperPoint(prop, -0.22, -0.04, left, true);
    // The return stroke lifts the pen and travels back continuously; inspection eases in/out.
    const lift = strokePhase > 1 ? Math.sin(Math.PI * (strokePhase - 1)) * 0.035 : 0;
    paperPoint(prop,
      THREE.MathUtils.lerp(-0.08 + progress * 0.23, 0.12, inspectWeight),
      THREE.MathUtils.lerp(Math.sin(cycle * Math.PI / 3) * 0.035, 0.02, inspectWeight), right);
    right.y += THREE.MathUtils.lerp(lift, 0.045, inspectWeight);
    gaze.copy(prop.position); gaze.y += 0.035;
    stage = inspectWeight > 0.5 ? 'inspect' : 'stroke';
  } else if (active && action === 'reading') {
    paperPoint(avatar.document, -0.25, -0.015, left, true);
    paperPoint(avatar.document, 0.25, -0.015, right, true);
    gaze.copy(avatar.document.position); gaze.x += Math.sin(t * 0.8) * 0.08;
    gaze.y += 0.015 + Math.cos(t * Math.PI / 3) * 0.055;
    stage = 'scan';
  } else if (active && action === 'delegating') {
    // A short screen-directed gesture; no invented walking, conversation or recipient.
    right.set(0.4, 0.55 + Math.max(0, Math.sin(t * 1.2)) * 0.035, -0.38);
    stage = 'coordinate';
  } else if (thinking) {
    right.set(0.16, 0.61, -0.24);
    gaze.set(0.65, 0.85, -0.74);
    stage = 'consider';
  }
  reach(avatar, 'left', left); reach(avatar, 'right', right);
  target.copy(gaze).applyMatrix4(inverseBody).sub(avatar.head.position);
  avatar.head.rotation.set(
    THREE.MathUtils.clamp(Math.atan2(target.y, Math.hypot(target.x, target.z)), -0.5, 0.25),
    THREE.MathUtils.clamp(Math.atan2(-target.x, -target.z), -0.85, 0.45),
    state === 'error' ? 0.1 : thinking ? 0.035 : 0,
    'YXZ',
  );
  const blinkPhase = t % 4.7;
  avatar.eyes.scale.y = animated && blinkPhase < 0.15 ? 0.14 + Math.abs(blinkPhase - 0.075) / 0.075 * 0.86 : 1;
  avatar.ears.forEach((ear, index) => {
    const sign = index === 0 ? 1 : -1;
    const base = avatar.root.userData.species === 'bear' ? 0 : 0.15 * sign;
    ear.rotation.set(animated ? Math.sin(t * 0.9 + index * 1.3) * 0.035 : 0, 0,
      base + (animated ? Math.sin(t * 0.7 + index) * 0.025 : state === 'error' ? sign * 0.07 : 0));
  });
  avatar.tail.rotation.y = animated ? Math.sin(t * 0.75) * 0.09 : 0;
  avatar.root.userData.motionStage = stage;
}
