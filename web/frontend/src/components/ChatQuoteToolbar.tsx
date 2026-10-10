import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CHAT_QUOTE_EVENT } from '../lib/chatQuote';
import '../styles/chat-quote.css';

export default function ChatQuoteToolbar({ sessionId, root }: { sessionId: string; root: RefObject<HTMLDivElement | null> }) {
  const [selection, setSelection] = useState<{ text: string; left: number; top: number } | null>(null);
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const interacting = useRef(false);
  const quote = useCallback((text: string) => {
    interacting.current = false;
    window.dispatchEvent(new window.CustomEvent(CHAT_QUOTE_EVENT, { detail: { sessionId, text } }));
    document.getSelection()?.removeAllRanges(); setSelection(null);
  }, [sessionId]);
  useEffect(() => {
    const update = (event: Event) => {
      if (interacting.current) return;
      if ((event.target as Element | null)?.closest?.('.chat-quote-button')) return;
      const selected = document.getSelection();
      if (!selected || selected.isCollapsed || !selected.rangeCount || !root.current?.contains(selected.anchorNode) || !root.current?.contains(selected.focusNode)) { setSelection(null); return; }
      const text = selected.toString().trim();
      if (!text) { setSelection(null); return; }
      const rect = selected.getRangeAt(0).getBoundingClientRect();
      setSelection({ text, left: Math.max(12, Math.min(rect.left, window.innerWidth - 110)), top: Math.max(12, Math.min(rect.top - 40, window.innerHeight - 48)) });
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { interacting.current = false; setSelection(null); }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'q' && selectionRef.current) { event.preventDefault(); quote(selectionRef.current.text); }
    };
    document.addEventListener('selectionchange', update); document.addEventListener('pointerup', update); document.addEventListener('keyup', update);
    document.addEventListener('keydown', key);
    const clear = () => { interacting.current = false; setSelection(null); };
    root.current?.addEventListener('scroll', clear);
    const area = root.current;
    return () => { document.removeEventListener('selectionchange', update); document.removeEventListener('pointerup', update); document.removeEventListener('keyup', update); document.removeEventListener('keydown', key); area?.removeEventListener('scroll', clear); };
  }, [quote, root]);
  return selection && createPortal(<button type="button" className="chat-quote-button" aria-label="引用选中文字" title="引用到输入框（Ctrl+Shift+Q）"
    style={{ left: selection.left, top: selection.top }} onPointerDown={event => { interacting.current = true; event.preventDefault(); }} onPointerCancel={() => { interacting.current = false; }} onMouseDown={event => event.preventDefault()} onClick={() => quote(selection.text)}>引用 <span>↗</span></button>, document.body);
}
