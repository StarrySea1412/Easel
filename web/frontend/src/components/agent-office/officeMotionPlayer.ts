import type { OfficeAgent, OfficeActionKind } from '../../lib/agentOffice';
import { captureOfficeMotionPose, type OfficeMotionPose } from './officeAvatarMotion';
import { poseOfficeAvatar, type OfficeAvatar } from './officeGeometry';

const SETTLE_SECONDS = .42;

/** Render-only settling and pen handling. Observed task state updates immediately. */
export function createOfficeMotionPlayer(avatar: OfficeAvatar) {
  let key: string | undefined;
  let from: OfficeMotionPose | undefined;
  let elapsed = 0;
  let pen: 'pickup' | 'stow' | undefined;
  let paper: 'pickup' | 'stow' | 'adjust' | undefined;
  let duration = SETTLE_SECONDS;
  return {
    get pending() { return Boolean(from); },
    reset() { key = undefined; from = undefined; pen = undefined; paper = undefined; elapsed = 0; },
    draw(state: OfficeAgent['state'], action: OfficeActionKind, time: number, selected: boolean, delta: number, motionAllowed: boolean) {
      const nextKey = `${state}:${action}`;
      const changed = nextKey !== key;
      if (changed) {
        from = key !== undefined && motionAllowed ? captureOfficeMotionPose(avatar) : undefined;
        const wantsPen = state === 'working' && (action === 'writing' || action === 'designing');
        const heldPen = avatar.pen.userData.held === true;
        pen = from && wantsPen !== heldPen ? wantsPen ? 'pickup' : 'stow' : undefined;
        const wantsPaper = state === 'working' && (action === 'reading' || action === 'writing');
        const heldPaper = avatar.document.userData.engaged === true;
        paper = from ? wantsPaper ? heldPaper ? 'adjust' : 'pickup' : heldPaper ? 'stow' : undefined : undefined;
        duration = Math.max(pen === 'pickup' ? 1.1 : pen === 'stow' ? .9 : SETTLE_SECONDS, paper ? 1.15 : 0);
        elapsed = 0; key = nextKey;
      } else if (from && motionAllowed) {
        elapsed = Math.min(duration, elapsed + (Number.isFinite(delta) ? Math.max(0, Math.min(delta, .06)) : 0));
      }
      const progress = elapsed / duration;
      const amount = progress * progress * (3 - 2 * progress);
      poseOfficeAvatar(avatar, state, time, selected, action, from ? { from, amount,
        pen: pen ? { kind: pen, progress } : undefined, paper: paper ? { kind: paper, progress } : undefined } : undefined);
      if (progress >= 1) { from = undefined; pen = undefined; paper = undefined; }
    },
  };
}
