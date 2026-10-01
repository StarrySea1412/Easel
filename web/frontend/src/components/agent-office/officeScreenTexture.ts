import * as THREE from 'three';
import type { OfficeWorkSurface } from './officeWorkSurface';

/** One reusable canvas per occupied desk; redraw only when its observed content changes. */
export function createOfficeScreenTexture() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 768; canvas.height = 480;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  let previous = '';
  return {
    texture,
    update(surface: OfficeWorkSurface | null) {
      const key = JSON.stringify(surface);
      if (key === previous) return;
      previous = key;
      const c = context;
      c.fillStyle = '#f8faf2'; c.fillRect(0, 0, 768, 480);
      c.fillStyle = surface?.kind === 'error' ? '#984f43' : '#34574f'; c.fillRect(0, 0, 768, 94);
      c.fillStyle = '#ffffff'; c.font = 'bold 38px "Microsoft YaHei", sans-serif';
      c.fillText(surface?.title || '空闲工位', 30, 62);
      if (!surface) { texture.needsUpdate = true; return; }
      c.font = '22px "Microsoft YaHei", sans-serif'; c.textAlign = 'right';
      c.fillText(surface.sample ? '演示' : surface.state, 737, 60); c.textAlign = 'left';
      const wrap = (text: string, y: number, max: number) => {
        let line = '', row = 0;
        for (const char of text) {
          if (c.measureText(line + char).width > 693) {
            c.fillText(row === max - 1 ? line.slice(0, -1) + '…' : line, 30, y + row * 45);
            if (++row >= max) return;
            line = '';
          }
          line += char;
        }
        if (line) c.fillText(line, 30, y + row * 45);
      };
      c.fillStyle = '#233c36'; c.font = 'bold 32px "Microsoft YaHei", sans-serif';
      wrap(surface.task, 142, 2);
      // Distinct visual workspaces accompany actual task text, never fabricated output.
      if (surface.kind === 'designing') {
        c.fillStyle = '#e2a579'; c.fillRect(30, 223, 198, 132);
        c.fillStyle = '#95b0a0'; c.beginPath(); c.arc(129, 275, 40, 0, Math.PI * 2); c.fill();
        ['#34574f', '#a5bc9f', '#e7b383'].forEach((color, i) => { c.fillStyle = color; c.fillRect(254 + i * 64, 237, 48, 48); });
        c.fillStyle = '#60786b'; c.font = '24px "Microsoft YaHei", sans-serif'; c.fillText('画板示意', 254, 330);
      } else if (surface.kind === 'delegating') {
        ['任务', '分派', '协作'].forEach((label, i) => {
          c.fillStyle = '#dbe8dc'; c.fillRect(30 + i * 236, 238, 208, 106);
          c.fillStyle = '#34574f'; c.font = 'bold 30px "Microsoft YaHei", sans-serif'; c.fillText(label, 74 + i * 236, 303);
        });
      } else {
        c.fillStyle = '#e5eadf'; c.fillRect(30, 221, 708, 143);
        c.fillStyle = '#41594d'; c.font = '28px "Microsoft YaHei", sans-serif';
        wrap(surface.toolLabel || `${surface.stale ? '上次记录：' : ''}${surface.detail}`, 268, 2);
      }
      c.fillStyle = '#63746b'; c.font = '23px "Microsoft YaHei", sans-serif';
      c.fillText(surface.source, 30, 423);
      c.font = '19px "Microsoft YaHei", sans-serif'; c.fillText('选中工位可展开查看', 30, 458);
      texture.needsUpdate = true;
    },
    dispose() { texture.dispose(); canvas.width = 1; canvas.height = 1; },
  };
}
