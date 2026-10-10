import * as THREE from 'three';
import type { OfficeAvatar, OfficeWorkstationRole } from './officeGeometry';
import type { OfficeAgent } from '../../lib/agentOffice';
import { syncOfficeBodySkin } from './officeBodySkin';
import { OFFICE_PEN_GRIP_OFFSET, OFFICE_PEN_PICKUP, placeOfficePen } from './officePen';
import { captureOfficePaperPose, placeOfficePaper, officePaperHandTarget, officePaperWristRotation, type OfficePaperPose, type OfficePaperBlend } from './officePaper';
import { updateOfficeHandPose, type OfficeHandWeights } from './officeHands';

type Action = NonNullable<OfficeAgent['action']>['kind'];
const upperLength = 0.25, lowerLength = 0.27;
const forward = new THREE.Vector3(0, 0, -1);
// Scratch objects are reused across sequential avatar updates; no per-frame geometry or allocations.
const target = new THREE.Vector3(), direction = new THREE.Vector3(), pole = new THREE.Vector3();
const elbowPoint = new THREE.Vector3(), foreDirection = new THREE.Vector3();
const inverseBody = new THREE.Matrix4(), absoluteFore = new THREE.Quaternion(), inverseArm = new THREE.Quaternion();
const wristRotation = new THREE.Quaternion();
const leftWristRotation = new THREE.Quaternion(), rightWristRotation = new THREE.Quaternion();
const goalLeftWristRotation = new THREE.Quaternion(), goalRightWristRotation = new THREE.Quaternion();
const penWritingRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.30, .55, -.08, 'YXZ'));
const leftTypingRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -.6);
const rightTypingRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .4);
const penTipOffset = new THREE.Vector3(OFFICE_PEN_GRIP_OFFSET.x, OFFICE_PEN_GRIP_OFFSET.y - .11, 0);
const contactOffset = new THREE.Vector3();
const left = new THREE.Vector3(), right = new THREE.Vector3(), gaze = new THREE.Vector3();
const penLift = new THREE.Vector3();

/** Used only by the explicitly requested tour mascot, never inferred from live state. */
export function poseOfficeTourAvatar(avatar: OfficeAvatar, time: number, walking: boolean) {
  const swing = walking ? Math.sin(time * 7) : 0;
  avatar.body.position.set(0, walking ? Math.abs(swing) * .012 : 0, 0);
  avatar.body.rotation.set(0, 0, swing * .025);
  avatar.head.rotation.set(0, 0, 0);
  avatar.body.updateMatrix(); inverseBody.copy(avatar.body.matrix).invert();
  reach(avatar, 'left', left.set(-.28, -.02, swing * .14), wristRotation.identity());
  reach(avatar, 'right', right.set(.28, -.02, -swing * .14), wristRotation.identity());
  syncOfficeBodySkin(avatar.bodySkin);
  avatar.document.visible = false; avatar.tablet.visible = false; avatar.pen.visible = false;
  avatar.beacon.visible = false; avatar.errorMarker.visible = false; avatar.selection.visible = false;
  avatar.root.children.filter(child => child.name.startsWith('tour-leg')).forEach((leg, i) => { leg.rotation.x = (i ? -1 : 1) * swing * .22; });
}

export interface OfficeMotionPose {
  position: THREE.Vector3;
  body: THREE.Quaternion;
  head: THREE.Quaternion;
  left: THREE.Vector3;
  right: THREE.Vector3;
  wrists: { left: THREE.Quaternion; right: THREE.Quaternion };
  paper: OfficePaperPose;
  paperHands: { left: THREE.Vector3; right: THREE.Vector3 };
  paperContact: { left: boolean; right: boolean };
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
  const left = avatar.root.worldToLocal(avatar.leftWrist.getWorldPosition(new THREE.Vector3()));
  const right = avatar.root.worldToLocal(avatar.rightWrist.getWorldPosition(new THREE.Vector3()));
  const paperHands = {
    left: officePaperHandTarget(avatar.document, 'left', new THREE.Vector3()),
    right: officePaperHandTarget(avatar.document, 'right', new THREE.Vector3()),
  };
  const engaged = avatar.document.userData.engaged === true;
  const inverseRoot = avatar.root.getWorldQuaternion(new THREE.Quaternion()).invert();
  return {
    position: avatar.body.position.clone(), body: avatar.body.quaternion.clone(), head: avatar.head.quaternion.clone(),
    left, right,
    wrists: {
      left: inverseRoot.clone().multiply(avatar.leftWrist.getWorldQuaternion(new THREE.Quaternion())),
      right: inverseRoot.clone().multiply(avatar.rightWrist.getWorldQuaternion(new THREE.Quaternion())),
    },
    paper: captureOfficePaperPose(avatar),
    paperHands,
    // A paper can still be held by the left paw after the right has returned
    // the pen. Capture each actual contact instead of assuming two free hands.
    paperContact: { left: engaged && left.distanceToSquared(paperHands.left) < 1e-12,
      right: engaged && right.distanceToSquared(paperHands.right) < 1e-12 },
    hands: {
      left: { pen: avatar.leftHand.mesh.morphTargetInfluences?.[0] ?? 0, paper: avatar.leftHand.mesh.morphTargetInfluences?.[1] ?? 0 },
      right: { pen: avatar.rightHand.mesh.morphTargetInfluences?.[0] ?? 0, paper: avatar.rightHand.mesh.morphTargetInfluences?.[1] ?? 0 },
    },
  };
}

// Timing can vary by role; sitting sideways or tilting the head is not a work
// habit. The seated body stays square to its station and gaze follows a target.
const tempos: Record<OfficeWorkstationRole, number> = {
  coordinator: .86, researcher: .78, designer: 1.10, writer: .91, tester: 1.02, reviewer: .69, generic: 1,
};

/** Fixed-length IK with elbows beside the torso, avoiding a raised-elbow wrist fold. */
function reach(avatar: OfficeAvatar, side: 'left' | 'right', point: THREE.Vector3, orientation: THREE.Quaternion) {
  const shoulder = side === 'left' ? avatar.leftArm : avatar.rightArm;
  const elbow = side === 'left' ? avatar.leftElbow : avatar.rightElbow;
  const wrist = side === 'left' ? avatar.leftWrist : avatar.rightWrist;
  target.copy(point).applyMatrix4(inverseBody);
  direction.subVectors(target, shoulder.position);
  const distance = THREE.MathUtils.clamp(direction.length(), 0.04, upperLength + lowerLength - 0.001);
  direction.normalize();
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const bend = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  // Choose the elbow circle point near desktop height, with the bend outward.
  // A fixed upward pole raises elbows as the paper rises and folds the wrists;
  // a fixed downward pole drives the forearm through the worktop instead.
  const horizontal = Math.hypot(direction.x, direction.z);
  if (bend > 1e-6 && horizontal > 1e-6) {
    const height = THREE.MathUtils.clamp(target.y - .015, .42, .47);
    const py = THREE.MathUtils.clamp((height - shoulder.position.y - direction.y * along) / bend, -horizontal, horizontal);
    const axial = -direction.y * py / horizontal;
    const sideways = Math.sqrt(Math.max(0, 1 - py * py - axial * axial)) * (side === 'left' ? -1 : 1);
    pole.set((direction.x * axial - direction.z * sideways) / horizontal, py,
      (direction.z * axial + direction.x * sideways) / horizontal);
  } else {
    pole.set(side === 'left' ? -1 : 1, 0, 0).addScaledVector(direction, -direction.x * (side === 'left' ? -1 : 1)).normalize();
  }
  elbowPoint.copy(shoulder.position).addScaledVector(direction, along).addScaledVector(pole, bend);
  target.copy(shoulder.position).addScaledVector(direction, distance);
  foreDirection.subVectors(target, elbowPoint).normalize();
  direction.subVectors(elbowPoint, shoulder.position).normalize();
  shoulder.quaternion.setFromUnitVectors(forward, direction);
  absoluteFore.setFromUnitVectors(forward, foreDirection);
  inverseArm.copy(shoulder.quaternion).invert();
  elbow.quaternion.copy(inverseArm).multiply(absoluteFore);
  // Work surfaces supply the desired palm orientation. Cancel the parent chain
  // first so a sloping page does not force the hand into an unrelated flat pose.
  wristRotation.copy(avatar.body.quaternion).multiply(absoluteFore).invert();
  wrist.quaternion.copy(wristRotation).multiply(orientation);
}

function paperPoint(prop: THREE.Group, x: number, y: number, result: THREE.Vector3, holding = false) {
  prop.updateMatrix();
  result.set(x, y, 0.042).applyMatrix4(prop.matrix);
  if (!holding) result.sub(contactOffset.copy(penTipOffset).applyQuaternion(rightWristRotation));
}

/** Choreography is only a visual interpretation of the current reported action, never execution evidence. */
export function applyOfficeAvatarMotion(avatar: OfficeAvatar, state: OfficeAgent['state'], time: number, action: Action, blend?: OfficeMotionBlend) {
  const role = avatar.workstationRole;
  const variation = avatar.postureVariation;
  const tempo = tempos[role] * (1 + variation * .12);
  // Errors settle into a visible facepalm. The transition player animates the
  // change of pose; a failed agent must not keep working or looping forever.
  const t = state === 'error' ? avatar.phase : (Number.isFinite(time) ? Math.max(0, time) : 0) * tempo + avatar.phase;
  const active = state === 'working' && ['executing', 'reading', 'writing', 'designing', 'delegating'].includes(action);
  const thinking = state === 'thinking';
  const failed = state === 'error';
  const animated = active || thinking;
  const cycle = t % 6;
  avatar.body.position.set(0, 0, 0);
  avatar.body.quaternion.identity();
  leftWristRotation.identity(); rightWristRotation.identity();
  avatar.body.updateMatrix(); inverseBody.copy(avatar.body.matrix).invert();
  const wantsPaper = active && (action === 'reading' || action === 'writing');
  avatar.tablet.visible = active && action === 'designing';
  let heldPen = active && (action === 'writing' || action === 'designing');
  avatar.document.position.y = action === 'writing' ? 0.47 : 0.57;
  avatar.document.position.z = action === 'writing' ? -.36 : -.48;
  avatar.document.position.x = .01;
  if (action === 'writing') avatar.document.position.x += .071;
  avatar.tablet.position.x = .161;
  avatar.document.rotation.x = action === 'writing' ? -1.12 : -0.8;
  avatar.document.rotation.y = 0;
  avatar.document.rotation.z = 0;
  const paperGrip = placeOfficePaper(avatar, wantsPaper, action === 'writing', blend?.from.paper, blend?.paper);
  avatar.pen.rotation.set(0, 0, 0);
  // Resting hands stay in front of the body, above the near edge of the desk.
  left.set(-0.1, 0.435, -0.24); right.set(0.28, 0.435, -0.24);
  gaze.set(0.55, 0.81, -0.74); // actual monitor, relative to the seated avatar
  let stage = 'rest';
  if (failed) {
    const sigh = (1 - Math.cos(t * 1.45)) / 2;
    left.set(-.16, .43, -.25);
    right.set(.15, .80 + sigh * .018, -.20);
    rightWristRotation.setFromEuler(new THREE.Euler(.25, 0, -.65));
    gaze.set(Math.sin(t * 1.1) * .055, .40 - sigh * .025, -.46);
    stage = 'facepalm';
  } else if (active && action === 'executing') {
    // Type, inspect the monitor, then reach the real mouse. Pauses prevent perpetual hammering.
    const typing = cycle < 3.5;
    const mouseWeight = THREE.MathUtils.smoothstep(cycle, 4.2, 4.7) * (1 - THREE.MathUtils.smoothstep(cycle, 5.5, 6));
    const typingWeight = THREE.MathUtils.smoothstep(cycle, 0, 0.25) * (1 - THREE.MathUtils.smoothstep(cycle, 3.1, 3.5));
    const tap = typingWeight * Math.max(0, Math.sin(t * 8)) * .004;
    leftWristRotation.copy(leftTypingRotation);
    rightWristRotation.slerpQuaternions(rightTypingRotation, wristRotation.identity(), mouseWeight);
    // Put the finger pads on the keys. Placing wrist centres over the keys
    // sends long fingers behind the keyboard and bends both wrists sideways.
    left.set(-.07, .3818 + tap, -.40 + typingWeight * Math.sin(t * 2.7) * .003)
      .sub(contactOffset.copy(avatar.leftHand.keyContact).applyQuaternion(leftWristRotation));
    right.set(.24, .3818 + typingWeight * Math.max(0, Math.sin(t * 8 + Math.PI)) * .004, -.40)
      .sub(contactOffset.copy(avatar.rightHand.keyContact).applyQuaternion(rightTypingRotation));
    right.lerp(target.set(.51, .3876, -.31).sub(contactOffset.copy(avatar.rightHand.keyContact)), mouseWeight);
    stage = typing ? 'keyboard' : mouseWeight > 0.5 ? 'mouse' : 'inspect';
    const glanceWeight = THREE.MathUtils.smoothstep(cycle, 0, 0.25) * (1 - THREE.MathUtils.smoothstep(cycle, 0.55, 0.8));
    if (role === 'tester') {
      const compareWeight = THREE.MathUtils.smoothstep(cycle, 2.1, 3.1) * (1 - THREE.MathUtils.smoothstep(cycle, 4.8, 5.8));
      gaze.set(.55, .81, -.74).lerp(target.set(-.49, .73, -.77), compareWeight);
    }
    gaze.lerp(target.set(0.12, 0.39, -0.36), glanceWeight);
  } else if (active && (action === 'writing' || action === 'designing')) {
    const prop = action === 'writing' ? avatar.document : avatar.tablet;
    rightWristRotation.copy(penWritingRotation);
    const inspectWeight = THREE.MathUtils.smoothstep(cycle, role === 'writer' ? 2.9 : 3.8, role === 'writer' ? 3.6 : 4.6)
      * (1 - THREE.MathUtils.smoothstep(cycle, 5.4, 6));
    const strokePhase = cycle % 2;
    const progress = (1 - Math.cos(Math.PI * strokePhase)) / 2;
    officePaperWristRotation(prop, 'left', leftWristRotation);
    if (action === 'writing') officePaperHandTarget(prop, 'left', left);
    else {
      paperPoint(prop, -0.22, -0.04, left, true);
      left.sub(contactOffset.set(0, -.025, -.08).applyQuaternion(leftWristRotation));
    }
    // The return stroke lifts the pen and travels back continuously; inspection eases in/out.
    const lift = strokePhase > 1 ? Math.sin(Math.PI * (strokePhase - 1)) * .012 : 0;
    paperPoint(prop,
      THREE.MathUtils.lerp(-0.08 + progress * (action === 'writing' ? .11 : .17), .06, inspectWeight),
      THREE.MathUtils.lerp(Math.sin(cycle * Math.PI / 3) * .016, .01, inspectWeight), right);
    right.y += THREE.MathUtils.lerp(lift, .025, inspectWeight);
    gaze.copy(right).add(contactOffset.copy(penTipOffset).applyQuaternion(rightWristRotation));
    stage = inspectWeight > 0.5 ? 'inspect' : 'stroke';
  } else if (active && action === 'reading') {
    officePaperWristRotation(avatar.document, 'left', leftWristRotation);
    officePaperWristRotation(avatar.document, 'right', rightWristRotation);
    officePaperHandTarget(avatar.document, 'left', left);
    officePaperHandTarget(avatar.document, 'right', right);
    gaze.copy(avatar.document.position); gaze.x += Math.sin(t * .8) * .035;
    gaze.y += .015 + Math.cos(t * Math.PI / 3) * .018;
    stage = 'scan';
  } else if (active && action === 'delegating') {
    // A short screen-directed gesture; no invented walking, conversation or recipient.
    if (role === 'coordinator') { left.set(-.37, .49 + Math.max(0, Math.sin(t * 1.2)) * .012, -.38); gaze.set(-.47, .69, -.77); }
    else right.set(.4, .49 + Math.max(0, Math.sin(t * 1.2)) * .012, -.38);
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
  goalLeftWristRotation.copy(leftWristRotation); goalRightWristRotation.copy(rightWristRotation);
  if (blend && blend.amount < 1) {
    const amount = THREE.MathUtils.clamp(blend.amount, 0, 1);
    avatar.body.position.lerpVectors(blend.from.position, avatar.body.position, amount);
    avatar.body.quaternion.slerpQuaternions(blend.from.body, avatar.body.quaternion, amount);
    leftWristRotation.slerpQuaternions(blend.from.wrists.left, goalLeftWristRotation, amount);
    rightWristRotation.slerpQuaternions(blend.from.wrists.right, goalRightWristRotation, amount);
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
        rightWristRotation.slerpQuaternions(blend.from.wrists.right, wristRotation.identity(), ease(p / .18));
        if (p > .48) rightWristRotation.slerpQuaternions(wristRotation.identity(), goalRightWristRotation, ease((p - .48) / .52));
      } else {
        heldPen = p < .65;
        if (p < .18) right.copy(blend.from.right).setY(blend.from.right.y + .09 * ease(p / .18));
        else if (p < .48) right.lerpVectors(target.copy(blend.from.right).setY(blend.from.right.y + .09),
          penLift.set(OFFICE_PEN_PICKUP.x, OFFICE_PEN_PICKUP.y + .10, OFFICE_PEN_PICKUP.z), ease((p - .18) / .30));
        else if (p < .65) right.copy(OFFICE_PEN_PICKUP).setY(OFFICE_PEN_PICKUP.y + .10 * (1 - ease((p - .48) / .17)));
        else right.lerpVectors(OFFICE_PEN_PICKUP, right, ease((p - .65) / .35));
        rightWristRotation.slerpQuaternions(blend.from.wrists.right, wristRotation.identity(), ease((p - .18) / .30));
        if (p > .65) rightWristRotation.slerpQuaternions(wristRotation.identity(), goalRightWristRotation, ease((p - .65) / .35));
      }
      stage = blend.pen.kind === 'pickup' ? 'pick-up-pen' : 'put-down-pen';
    } else right.lerpVectors(blend.from.right, right, amount);
    avatar.body.updateMatrix(); inverseBody.copy(avatar.body.matrix).invert();
  }
  if (blend?.paper && blend.amount < 1) {
    officePaperWristRotation(avatar.document, 'left', wristRotation);
    officePaperHandTarget(avatar.document, 'left', target);
    if (blend.paper.kind === 'pickup') {
      left.lerpVectors(blend.from.left, target, paperGrip);
      leftWristRotation.slerpQuaternions(blend.from.wrists.left, wristRotation, paperGrip);
    }
    else if (blend.paper.kind === 'stow') {
      if (blend.from.paperContact.left) {
        left.lerp(target, paperGrip);
        leftWristRotation.slerpQuaternions(goalLeftWristRotation, wristRotation, paperGrip);
      }
    }
    else { left.copy(target); leftWristRotation.copy(wristRotation); }
    if (!heldPen && !blend.pen) {
      officePaperWristRotation(avatar.document, 'right', wristRotation);
      officePaperHandTarget(avatar.document, 'right', target);
      if (blend.paper.kind === 'pickup') {
        right.lerpVectors(blend.from.right, target, paperGrip);
        rightWristRotation.slerpQuaternions(blend.from.wrists.right, wristRotation, paperGrip);
      }
      else if (blend.paper.kind === 'stow') {
        if (blend.from.paperContact.right) {
          right.lerp(target, paperGrip);
          rightWristRotation.slerpQuaternions(goalRightWristRotation, wristRotation, paperGrip);
        }
      }
      else {
        const settle = THREE.MathUtils.smoothstep(blend.paper.progress, 0, .25);
        right.copy(target).addScaledVector(penLift.subVectors(blend.from.right, blend.from.paperHands.right), 1 - settle);
        rightWristRotation.slerpQuaternions(blend.from.wrists.right, wristRotation, settle);
      }
    }
    stage = blend.paper.kind === 'pickup' ? 'pick-up-paper' : blend.paper.kind === 'stow' ? 'put-down-paper' : stage;
  }
  reach(avatar, 'left', left, leftWristRotation); reach(avatar, 'right', right, rightWristRotation);
  syncOfficeBodySkin(avatar.bodySkin);
  placeOfficePen(avatar, heldPen);
  let penGrip = heldPen ? 1 : 0;
  if (blend?.pen && blend.amount < 1) {
    const p = blend.pen.progress;
    const fromGrip = blend.from.hands.right.pen ?? 0;
    penGrip = blend.pen.kind === 'pickup'
      ? THREE.MathUtils.lerp(fromGrip, 1, THREE.MathUtils.smoothstep(p, .18, .30))
      : fromGrip * (1 - THREE.MathUtils.smoothstep(p, .65, .78));
  }
  const handAmount = blend ? THREE.MathUtils.clamp(blend.amount, 0, 1) : 1;
  const leftPaper = wantsPaper ? paperGrip : active && action === 'designing' ? .65 : blend?.paper ? paperGrip : 0;
  const rightPaper = action === 'reading' && active ? paperGrip : blend?.paper && !heldPen && !blend.pen
    && (blend.paper.kind !== 'stow' || blend.from.paperContact.right) ? paperGrip : 0;
  const fromRightPaper = blend?.from.hands.right.paper ?? rightPaper;
  // Open the page grip before closing around the barrel, and only curl back
  // onto the page once the pen is released. Overlapping weights weaken both.
  const rightPaperGrip = blend?.pen && blend.amount < 1
    ? blend.pen.kind === 'pickup'
      ? THREE.MathUtils.lerp(fromRightPaper, 0, THREE.MathUtils.smoothstep(blend.pen.progress, 0, .18))
      : THREE.MathUtils.lerp(fromRightPaper, rightPaper, THREE.MathUtils.smoothstep(blend.pen.progress, .78, 1))
    : THREE.MathUtils.lerp(fromRightPaper, rightPaper, handAmount);
  updateOfficeHandPose(avatar.leftHand, { paper: THREE.MathUtils.lerp(blend?.from.hands.left.paper ?? leftPaper, leftPaper, handAmount) });
  updateOfficeHandPose(avatar.rightHand, {
    pen: blend?.pen ? penGrip : THREE.MathUtils.lerp(blend?.from.hands.right.pen ?? penGrip, penGrip, handAmount),
    paper: rightPaperGrip,
  });
  target.copy(gaze).applyMatrix4(inverseBody).sub(avatar.head.position);
  avatar.head.rotation.set(
    THREE.MathUtils.clamp(Math.atan2(target.y, Math.hypot(target.x, target.z)), -1.1, .35),
    THREE.MathUtils.clamp(Math.atan2(-target.x, -target.z), -1.1, 1.1),
    0,
    'YXZ',
  );
  if (blend && blend.amount < 1) avatar.head.quaternion.slerpQuaternions(blend.from.head, avatar.head.quaternion, Math.max(0, blend.amount));
  const blinkPhase = t % 4.7;
  avatar.eyes.scale.y = animated && blinkPhase < 0.15 ? 0.14 + Math.abs(blinkPhase - 0.075) / 0.075 * 0.86 : 1;
  avatar.ears.forEach((ear, index) => {
    const sign = index === 0 ? 1 : -1;
    const base = avatar.root.userData.species === 'bear' ? 0 : 0.15 * sign;
    ear.rotation.set(animated ? Math.sin(t * 0.9 + index * 1.3) * 0.035 : 0, 0,
      base + (failed ? sign * .24 : animated ? Math.sin(t * 0.7 + index) * 0.025 : 0));
  });
  avatar.tail.rotation.y = animated ? Math.sin(t * 0.75) * 0.09 : 0;
  avatar.root.userData.motionStage = stage;
}
