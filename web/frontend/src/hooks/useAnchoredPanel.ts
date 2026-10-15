import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** Keep global/composer popovers inside the viewport, including a collapsed rail. */
export function useAnchoredPanel(open: boolean, close: () => void,
  anchor: RefObject<HTMLButtonElement | null>, panel: RefObject<HTMLElement | null>,
  placement: 'above' | 'beside', preferredWidth: number) {
  const [position, setPosition] = useState({ left: 12, top: 12, width: preferredWidth });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(preferredWidth, window.innerWidth - 24);
      const height = Math.min(panel.current?.getBoundingClientRect().height || 300, window.innerHeight - 24);
      const above = rect.top - height - 10;
      setPosition({ width, left: Math.max(12, Math.min(placement === 'beside' ? rect.right + 10 : rect.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(placement === 'above' && above >= 12 ? above : placement === 'beside' ? rect.bottom - height : rect.bottom + 10, window.innerHeight - height - 12)) });
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, placement, preferredWidth, anchor, panel]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: Event) => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); anchor.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape); window.addEventListener('easel:page-navigation', close);
    return () => {
      document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape); window.removeEventListener('easel:page-navigation', close);
    };
  }, [open, close, anchor, panel]);
  return position;
}
