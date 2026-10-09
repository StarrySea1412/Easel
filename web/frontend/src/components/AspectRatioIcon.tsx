/** Fit the real width/height ratio into one consistent icon slot. */
export default function AspectRatioIcon({ ratio, automatic = false }: { ratio: string; automatic?: boolean }) {
  const [w, h] = ratio.split(/[:/]/).map(Number);
  const valid = w > 0 && h > 0 && Number.isFinite(w / h);
  const width = valid ? 18 * w / Math.max(w, h) : 16;
  const height = valid ? 18 * h / Math.max(w, h) : 16;
  return <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true"><rect x={(22-width)/2} y={(22-height)/2} width={width} height={height} rx="2" stroke="currentColor" strokeWidth="1.3" strokeDasharray={automatic ? '2 2' : undefined}/></svg>;
}
