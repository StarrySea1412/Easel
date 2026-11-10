import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '../hooks/useModalFocus';
import { IconDownload } from './icons';
import '../styles/image-preview-modal.css';

/** Uses the same authenticated file URL as the thumbnail, without opening a tab. */
export default function ImagePreviewModal({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const id = useId(), ref = useModalFocus(true, onClose);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  return createPortal(<div className="image-preview-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="image-preview-modal" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <header><div><strong id={id}>查看原图</strong><span title={name}>{name}</span></div>
        <a href={`${src}&download=true`}><IconDownload size={15}/>下载原图</a>
        <button type="button" data-modal-autofocus aria-label="关闭原图" onClick={onClose}><span aria-hidden="true">×</span></button>
      </header>
      <div className="image-preview-canvas">{failed ? <p role="status">原图加载失败，请关闭后刷新图片再试。</p> : <img src={src} alt={name} onError={() => setFailed(true)}/>}</div>
    </div>
  </div>, document.body);
}
