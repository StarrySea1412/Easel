import * as THREE from 'three';
import type { OfficeAvatar } from './officeGeometry';

// Flat on the desk, behind the keyboard. The same clipboard stays in the scene.
export const OFFICE_PAPER_DOCK = new THREE.Vector3(.01, .378, -.70);
export const OFFICE_PAPER_DOCK_ROTATION = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
export interface OfficePaperPose { position: THREE.Vector3; rotation: THREE.Quaternion; gripY: number }
export interface OfficePaperBlend { kind: 'pickup' | 'stow' | 'adjust'; progress: number }
const goalPosition = new THREE.Vector3(), goalRotation = new THREE.Quaternion();
const palmToPage = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const leftPageGrip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -.4);
const rightPageGrip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .4);
const contactOffset = new THREE.Vector3(), handRotation = new THREE.Quaternion();
const ease = (x: number) => THREE.MathUtils.smoothstep(x, 0, 1);

export function captureOfficePaperPose(avatar: OfficeAvatar): OfficePaperPose {
  return { position: avatar.document.position.clone(), rotation: avatar.document.quaternion.clone(), gripY: avatar.document.userData.gripY ?? -.16 };
}

/** Returns how firmly hands are attached; rendering never delays task status. */
export function placeOfficePaper(avatar: OfficeAvatar, engaged: boolean, writing: boolean, from?: OfficePaperPose, blend?: OfficePaperBlend) {
  const paper = avatar.document, role = avatar.workstationRole;
  goalPosition.copy(engaged ? paper.position : OFFICE_PAPER_DOCK);
  goalRotation.copy(engaged ? paper.quaternion : OFFICE_PAPER_DOCK_ROTATION);
  const goalGripY = engaged && writing ? -.04 : -.16;
  let grip = engaged ? 1 : 0;
  paper.visible = true;
  if (from && blend && blend.progress < 1) {
    const p = THREE.MathUtils.clamp(blend.progress, 0, 1);
    const moving = blend.kind === 'pickup' ? ease((p - .25) / .75) : blend.kind === 'stow' ? ease(p / .75) : ease(p);
    paper.position.lerpVectors(from.position, goalPosition, moving);
    paper.quaternion.slerpQuaternions(from.rotation, goalRotation, moving);
    // Lift before traversing the keyboard; both endpoints are above the desktop.
    paper.position.y += Math.sin(Math.PI * moving) * .085;
    paper.userData.gripY = THREE.MathUtils.lerp(from.gripY, goalGripY, moving);
    grip = blend.kind === 'pickup' ? ease(p / .25) : blend.kind === 'stow' ? 1 - ease((p - .75) / .25) : 1;
    paper.userData.engaged = blend.kind === 'pickup' ? p >= .25 : blend.kind === 'stow' ? p < .75 : true;
  } else {
    paper.position.copy(goalPosition); paper.quaternion.copy(goalRotation);
    paper.userData.gripY = goalGripY; paper.userData.engaged = engaged;
  }
  // Stored for inspection/pose capture only, never used as execution evidence.
  paper.userData.handContact = grip;
  paper.userData.workstationRole = role;
  return grip;
}

/** Palm normal follows the page; fingers point along its near-to-far edge. */
export function officePaperWristRotation(paper: THREE.Group, side: 'left' | 'right', result: THREE.Quaternion) {
  return result.copy(paper.quaternion).multiply(palmToPage).multiply(side === 'left' ? leftPageGrip : rightPageGrip);
}

export function officePaperHandTarget(paper: THREE.Group, side: 'left' | 'right', result: THREE.Vector3) {
  paper.updateMatrix();
  result.set(side === 'left' ? -.22 : .22, paper.userData.gripY ?? -.16, .042).applyMatrix4(paper.matrix);
  // Solve from the actual rotated finger pad, not from a horizontal wrist.
  officePaperWristRotation(paper, side, handRotation);
  contactOffset.set(0, -.025, -.08).applyQuaternion(handRotation);
  result.sub(contactOffset);
  return result;
}
