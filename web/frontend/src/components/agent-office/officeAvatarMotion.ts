import * as THREE from 'three';
import type { OfficeAvatar, OfficeWorkstationRole } from './officeGeometry';
import type { OfficeAgent } from '../../lib/agentOffice';
import { syncOfficeBodySkin } from './officeBodySkin';
import { OFFICE_PEN_GRIP_OFFSET, OFFICE_PEN_PICKUP, placeOfficePen } from './officePen';
import { captureOfficePaperPose, placeOfficePaper, officePaperHandTarget, type OfficePaperPose, type OfficePaperBlend } from './officePaper';
import { updateOfficeHandPose, type OfficeHandWeights } from './officeHands';

type Action = NonNullable<OfficeAgent['action']>['kind'];
const upperLength = 0.25, lowerLength = 0.27;
const forward = new THREE.Vector3(0, 0, -1);
// Scratch objects are reused across sequential avatar updates; no per-frame geometry or allocations.
const target = new THREE.Vector3(), direction = new THREE.Vector3(), pole = new THREE.Vector3();
const elbowPoint = new THREE.Vector3(), foreDirection = new THREE.Vector3();
const inverseBody = new THREE.Matrix4(), absoluteFore = new THREE.Quaternion(), inverseArm = new THREE.Quaternion();
const wristRotation = new THREE.Quaternion();
const left = new THREE.Vector3(), right = new THREE.Vector3(), gaze = new THREE.Vector3();
const penLift = new THREE.Vector3();

export interface OfficeMotionPose {
  position: THREE.Vector3;
  body: THREE.Quaternion;
  head: THREE.Quaternion;
  left: THREE.Vector3;
  right: THREE.Vector3;
  paper: OfficePaperPose;
  paperHands: { left: THREE.Vector3; right: THREE.Vector3 };
  hands: { left: OfficeHandWeights; right: OfficeHandWeights };
}
export interface OfficeMotionBlend {
  from: OfficeMotionPose;
  amount: number;
  pen?: { kind: 'pickup' | 'stow'; progress: number };
  paper?: OfficePaperBlend;
}

/** Capture only when an action changes; hand targets remain in seated-root space. */
export function captureOfficeMotionPose(avatar: OfficeAvatar): OfficeMotionPose {
  avatar.root.updateWorldMatrix(true, true);
  return {
    position: avatar.body.position.clone(), body: avatar.body.quaternion.clone(), head: avatar.head.quaternion.clone(),
    left: avatar.root.worldToLocal(avatar.leftWrist.getWorldPosition(new THREE.Vector3())),
    right: avatar.root.worldToLocal(avatar.rightWrist.getWorldPosition(new THREE.Vector3())),
    paper: captureOfficePaperPose(avatar),
    paperHands: { left: officePaperHandTarget(avatar.document, 'left', new THREE.Vector3()), right: officePaperHandTarget(avatar.document, 'right', new THREE.Vector3()) },
    hands: {
      left: { pen: avatar.leftHand.mesh.morphTargetInfluences?.[0] ?? 0, paper: avatar.leftHand.mesh.morphTargetInfluences?.[1] ?? 0 },
      right: { pen: avatar.rightHand.mesh.morphTargetInfluences?.[0] ?? 0, paper: avatar.rightHand.mesh.morphTargetInfluences?.[1] ?? 0 },
    },
  };
}

// These are seated working habits, not claims about tools or execution. The
// reported action below still determines every working prop and contact.
const postures: Record<OfficeWorkstationRole, { lean: number; turn: number; tilt: number; x: number; z: number; tempo: number }> = {
  coordinator: { lean: -.025, turn: .17, tilt: .025, x: -.015, z: 0, tempo: .86 },
  researcher: { lean: -.045, turn: .12, tilt: -.055, x: -.025, z: -.008, tempo: .78 },
  designer: { lean: -.10, turn: -.09, tilt: -.05, x: .018, z: -.006, tempo: 1.10 },
  writer: { lean: -.13, turn: .035, tilt: .025, x: -.006, z: -.009, tempo: .91 },
  tester: { lean: -.015, turn: .075, tilt: -.015, x: -.018, z: 0, tempo: 1.02 },
  reviewer: { lean: .075, turn: -.075, tilt: .04, x: .012, z: .018, tempo: .69 },
  generic: { lean: .025, turn: -.035, tilt: 0, x: 0, z: 0, tempo: 1 },
};

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
  if (!holding) { result.x -= OFFICE_PEN_GRIP_OFFSET.x; result.y += 0.05; }
}

/** Choreography is only a visual interpretation of the current reported action, never execution evidence. */
export function applyOfficeAvatarMotion(avatar: OfficeAvatar, state: OfficeAgent['state'], time: number, action: Action, blend?: OfficeMotionBlend) {
  const role = avatar.workstationRole;
  const posture = postures[role];
  const variation = avatar.postureVariation;
  const tempo = posture.tempo * (1 + variation * .12);
  const t = (Number.isFinite(time) ? Math.max(0, time) : 0) * tempo + avatar.phase;
  const active = state === 'working' && ['executing', 'reading', 'writing', 'designing', 'delegating'].includes(action);
  const thinking = state === 'thinking';
  const animated = active || thinking;
  const cycle = t % 6;
  // A reviewer comes forward from the backrest only when a reported pen action
  // needs the far side of the page; fixed arm lengths are never stretched.
  const postureWeight = active ? role === 'reviewer' && (action === 'writing' || action === 'designing') ? .45 : 1
    : thinking ? .72 : role === 'generic' ? 0 : .45;
  avatar.body.position.set((posture.x + variation * .018) * postureWeight, 0, posture.z * postureWeight);
  avatar.body.rotation.set(
    (posture.lean + variation * .022) * postureWeight + (animated ? Math.sin(t * .8) * .004 : 0),
    (posture.turn + variation * .06) * postureWeight,
    (posture.tilt + variation * .035) * postureWeight,
  );
  // Quiet states have their own weight, without pretending another task happened.
  if (role !== 'generic' && !animated) {
    if (state === 'done') avatar.body.rotation.x += .045;
    else if (state === 'error') avatar.body.rotation.z -= .025;
    else if (state === 'stopped') avatar.body.rotation.x += .025;
  }
  avatar.body.updateMatrix(); inverseBody.copy(avatar.body.matrix).invert();
  const wantsPaper = active && (action === 'reading' || action === 'writing');
  avatar.tablet.visible = active && action === 'designing';
  let heldPen = active && (action === 'writing' || action === 'designing');
  avatar.document.position.y = action === 'writing' ? 0.47 : 0.57;
  avatar.document.position.z = action === 'writing' ? -.36 : -.48;
  avatar.document.position.x = role === 'researcher' ? -.045 : role === 'reviewer' ? .035 : .01;
  if (action === 'writing') avatar.document.position.x += .071;
  avatar.tablet.position.x = .161;
  avatar.document.rotation.x = action === 'writing' ? -1.12 : -0.8;
  avatar.document.rotation.y = role === 'researcher' ? .09 : role === 'reviewer' ? -.045 : 0;
  avatar.document.rotation.z = role === 'researcher' ? .06 : role === 'writer' ? -.035 : 0;
  const paperGrip = placeOfficePaper(avatar, wantsPaper, action === 'writing', blend?.from.paper, blend?.paper);
  avatar.pen.rotation.set(0, 0, 0);
  // Resting hands stay in front of the body, above the near edge of the desk.
  left.set(-0.1, 0.435, -0.24); right.set(0.28, 0.435, -0.24);
  left.x += variation * .02; right.z += variation * .02;
  gaze.set(0.55, 0.81, -0.74); // actual monitor, relative to the seated avatar
  if (role === 'coordinator') gaze.set(-.47, .69, -.77); // planning board
  if (role === 'tester') gaze.set(-.49, .73, -.77); // comparison display
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
    if (role === 'tester') {
      const compareWeight = THREE.MathUtils.smoothstep(cycle, 2.1, 3.1) * (1 - THREE.MathUtils.smoothstep(cycle, 4.8, 5.8));
      gaze.set(.55, .81, -.74).lerp(target.set(-.49, .73, -.77), compareWeight);
    }
    gaze.lerp(target.set(0.12, 0.39, -0.36), glanceWeight);
  } else if (active && (action === 'writing' || action === 'designing')) {
    const prop = action === 'writing' ? avatar.document : avatar.tablet;
    const inspectWeight = THREE.MathUtils.smoothstep(cycle, role === 'writer' ? 2.9 : 3.8, role === 'writer' ? 3.6 : 4.6)
      * (1 - THREE.MathUtils.smoothstep(cycle, 5.4, 6));
    const strokePhase = cycle % 2;
    const progress = (1 - Math.cos(Math.PI * strokePhase)) / 2;
    if (action === 'writing') officePaperHandTarget(prop, 'left', left);
    else paperPoint(prop, -0.22, -0.04, left, true);
    // The return stroke lifts the pen and travels back continuously; inspection eases in/out.
    const lift = strokePhase > 1 ? Math.sin(Math.PI * (strokePhase - 1)) * 0.035 : 0;
    paperPoint(prop,
      THREE.MathUtils.lerp(-0.08 + progress * 0.23, 0.12, inspectWeight),
      THREE.MathUtils.lerp(Math.sin(cycle * Math.PI / 3) * 0.035, 0.02, inspectWeight), right);
    right.y += THREE.MathUtils.lerp(lift, 0.045, inspectWeight);
    gaze.copy(prop.position); gaze.y += 0.035;
    if (role === 'writer') gaze.lerp(target.set(.55, .81, -.74), inspectWeight * .65);
    stage = inspectWeight > 0.5 ? 'inspect' : 'stroke';
  } else if (active && action === 'reading') {
    officePaperHandTarget(avatar.document, 'left', left);
    officePaperHandTarget(avatar.document, 'right', right);
    gaze.copy(avatar.document.position); gaze.x += Math.sin(t * 0.8) * 0.08;
    gaze.y += 0.015 + Math.cos(t * Math.PI / 3) * 0.055;
    stage = 'scan';
  } else if (active && action === 'delegating') {
    // A short screen-directed gesture; no invented walking, conversation or recipient.
    if (role === 'coordinator') left.set(-.37, .55 + Math.max(0, Math.sin(t * 1.2)) * .035, -.38);
    else right.set(0.4, 0.55 + Math.max(0, Math.sin(t * 1.2)) * 0.035, -0.38);
    stage = 'coordinate';
  } else if (thinking) {
    // Six different ways to pause and consider. No unobserved conversation,
    // coffee or tool use is inferred from a thinking state.
    switch (role) {
      case 'coordinator': left.set(-.24, .48, -.28); right.set(.28, .435, -.29); break;
      case 'researcher': left.set(-.16, .58, -.25); right.set(.25, .435, -.32); gaze.set(-.2, .57, -.4); break;
      case 'designer': left.set(-.13, .435, -.31); right.set(.23, .56, -.25); gaze.set(.05, .49, -.42); break;
      case 'writer': left.set(-.08, .44, -.34); right.set(.12, .57, -.27); gaze.set(.36, .7, -.6); break;
      case 'tester': left.set(-.09, .445, -.35); right.set(.37, .445, -.29); gaze.set(-.49, .73, -.77); break;
      case 'reviewer': left.set(-.11, .45, -.27); right.set(.27, .49, -.26); gaze.set(.55, .8, -.74); break;
      default: right.set(.16, .61, -.24); gaze.set(.65, .85, -.74);
    }
    stage = 'consider';
  }
  if (blend && blend.amount < 1) {
    const amount = THREE.MathUtils.clamp(blend.amount, 0, 1);
    avatar.body.position.lerpVectors(blend.from.position, avatar.body.position, amount);
    avatar.body.quaternion.slerpQuaternions(blend.from.body, avatar.body.quaternion, amount);
    left.lerpVectors(blend.from.left, left, amount);
    // Move the hand to the actual stand before attaching, and release only
    // after the same pen has returned. Interpolating wrist targets preserves IK.
    if (blend.pen) {
      const p = THREE.MathUtils.clamp(blend.pen.progress, 0, 1);
      const ease = (x: number) => THREE.MathUtils.smoothstep(x, 0, 1);
      if (blend.pen.kind === 'pickup') {
        heldPen = p >= .30;
        if (p < .30) right.lerpVectors(blend.from.right, OFFICE_PEN_PICKUP, ease(p / .30));
        else if (p < .48) right.copy(OFFICE_PEN_PICKUP).setY(OFFICE_PEN_PICKUP.y + .10 * ease((p - .30) / .18));
        else right.lerpVectors(target.set(OFFICE_PEN_PICKUP.x, OFFICE_PEN_PICKUP.y + .10, OFFICE_PEN_PICKUP.z), right, ease((p - .48) / .52));
      } else {
        heldPen = p < .65;
        if (p < .18) right.copy(blend.from.right).setY(blend.from.right.y + .09 * ease(p / .18));
        else if (p < .48) right.lerpVectors(target.copy(blend.from.right).setY(blend.from.right.y + .09),
          penLift.set(OFFICE_PEN_PICKUP.x, OFFICE_PEN_PICKUP.y + .10, OFFICE_PEN_PICKUP.z), ease((p - .18) / .30));
        else if (p < .65) right.copy(OFFICE_PEN_PICKUP).setY(OFFICE_PEN_PICKUP.y + .10 * (1 - ease((p - .48) / .17)));
        else right.lerpVectors(OFFICE_PEN_PICKUP, right, ease((p - .65) / .35));
      }
      stage = blend.pen.kind === 'pickup' ? 'pick-up-pen' : 'put-down-pen';
    } else right.lerpVectors(blend.from.right, right, amount);
    avatar.body.updateMatrix(); inverseBody.copy(avatar.body.matrix).invert();
  }
  if (blend?.paper && blend.amount < 1) {
    officePaperHandTarget(avatar.document, 'left', target);
    if (blend.paper.kind === 'pickup') left.lerpVectors(blend.from.left, target, paperGrip);
    else if (blend.paper.kind === 'stow') left.lerp(target, paperGrip);
    else left.copy(target);
    if (!heldPen && !blend.pen) {
      officePaperHandTarget(avatar.document, 'right', target);
      if (blend.paper.kind === 'pickup') right.lerpVectors(blend.from.right, target, paperGrip);
      else if (blend.paper.kind === 'stow') right.lerp(target, paperGrip);
      else right.copy(target).addScaledVector(penLift.subVectors(blend.from.right, blend.from.paperHands.right),
        1 - THREE.MathUtils.smoothstep(blend.paper.progress, 0, .25));
    }
    stage = blend.paper.kind === 'pickup' ? 'pick-up-paper' : blend.paper.kind === 'stow' ? 'put-down-paper' : stage;
  }
  reach(avatar, 'left', left); reach(avatar, 'right', right);
  syncOfficeBodySkin(avatar.bodySkin);
  placeOfficePen(avatar, heldPen);
  let penGrip = heldPen ? 1 : 0;
  if (blend?.pen && blend.amount < 1) {
    const p = blend.pen.progress;
    penGrip = blend.pen.kind === 'pickup' ? THREE.MathUtils.smoothstep(p, .18, .30) : 1 - THREE.MathUtils.smoothstep(p, .65, .78);
  }
  const handAmount = blend ? THREE.MathUtils.clamp(blend.amount, 0, 1) : 1;
  const leftPaper = wantsPaper ? paperGrip : active && action === 'designing' ? .65 : blend?.paper ? paperGrip : 0;
  const rightPaper = action === 'reading' && active ? paperGrip : blend?.paper && !heldPen && !blend.pen ? paperGrip : 0;
  updateOfficeHandPose(avatar.leftHand, { paper: THREE.MathUtils.lerp(blend?.from.hands.left.paper ?? leftPaper, leftPaper, handAmount) });
  updateOfficeHandPose(avatar.rightHand, {
    pen: blend?.pen ? penGrip : THREE.MathUtils.lerp(blend?.from.hands.right.pen ?? penGrip, penGrip, handAmount),
    paper: THREE.MathUtils.lerp(blend?.from.hands.right.paper ?? rightPaper, rightPaper, handAmount),
  });
  target.copy(gaze).applyMatrix4(inverseBody).sub(avatar.head.position);
  avatar.head.rotation.set(
    THREE.MathUtils.clamp(Math.atan2(target.y, Math.hypot(target.x, target.z)), -0.5, 0.25),
    THREE.MathUtils.clamp(Math.atan2(-target.x, -target.z), -0.85, 0.85),
    state === 'error' ? 0.1 : thinking ? 0.035 : 0,
    'YXZ',
  );
  if (blend && blend.amount < 1) avatar.head.quaternion.slerpQuaternions(blend.from.head, avatar.head.quaternion, Math.max(0, blend.amount));
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
