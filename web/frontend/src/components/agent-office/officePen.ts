import * as THREE from 'three';
import type { OfficeAvatar } from './officeGeometry';

// Avatar-local coordinates. The stand sits in front of the mouse, clear of
// the keyboard and inside even the narrowest workstation's front edge.
export const OFFICE_PEN_DOCK = new THREE.Vector3(.53, .496, -.17);
export const OFFICE_PEN_GRIP_OFFSET = new THREE.Vector3(.105, .06, 0);
export const OFFICE_PEN_PICKUP = OFFICE_PEN_DOCK.clone().sub(OFFICE_PEN_GRIP_OFFSET);
const inverseWrist = new THREE.Matrix4();

/** A tapered nib, grip and capped barrel, all within one continuous mesh. */
export function createOfficePenGeometry() {
  const profile = [[0,-.11],[.003,-.107],[.010,-.073],[.014,-.06],[.014,-.014],[.011,-.006],[.011,.093],[.009,.106],[0,.11]];
  const geometry = new THREE.LatheGeometry(profile.map(([r,y]) => new THREE.Vector2(r,y)), 24);
  const positions = geometry.getAttribute('position'), colors = new Float32Array(positions.count * 3);
  const graphite = new THREE.Color('#303b40'), grip = new THREE.Color('#6a7d76'), metal = new THREE.Color('#b8c4bf');
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    (y < -.078 || y > .09 ? metal : y < -.009 ? grip : graphite).toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Keep one pen object: held at the wrist or stationary in its physical stand. */
export function placeOfficePen(avatar: OfficeAvatar, held: boolean) {
  avatar.pen.visible = true;
  avatar.pen.userData.held = held;
  if (held) {
    avatar.pen.position.copy(OFFICE_PEN_GRIP_OFFSET);
    avatar.pen.quaternion.identity();
    return;
  }
  // Invert the control chain without allocating or reparenting rendered objects.
  avatar.body.updateMatrix(); avatar.rightArm.updateMatrix(); avatar.rightElbow.updateMatrix(); avatar.rightWrist.updateMatrix();
  inverseWrist.copy(avatar.body.matrix).multiply(avatar.rightArm.matrix).multiply(avatar.rightElbow.matrix).multiply(avatar.rightWrist.matrix).invert();
  avatar.pen.position.copy(OFFICE_PEN_DOCK).applyMatrix4(inverseWrist);
  avatar.pen.quaternion.setFromRotationMatrix(inverseWrist);
}
