import { useEffect, useRef, useState } from 'react';
import { extractVideoFirstFrame, readStudioClipboard } from '../lib/studioClipboard';

export function useStudioMediaInput(upload: (file: File) => Promise<{ id: string } | null>, locked: boolean, referenceId: string | null) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [sourceVideo, setSourceVideo] = useState<{ url: string; name: string; referenceId: string } | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const sourceUrl = useRef('');
  const decodeAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; decodeAbort.current?.abort(); if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current); };
  }, []);
  const clearVideo = () => { if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current); sourceUrl.current = ''; setSourceVideo(null); };
  useEffect(() => {
    // Gallery selection and reference removal also change the input outside this hook.
    // Bind the preview to the saved reference, never to the last file chooser action.
    if (!sourceVideo || sourceVideo.referenceId === referenceId || processing) return;
    if (sourceUrl.current === sourceVideo.url) { URL.revokeObjectURL(sourceVideo.url); sourceUrl.current = ''; }
    setSourceVideo(current => current === sourceVideo ? null : current);
  }, [sourceVideo, referenceId, processing]);
  const receive = async (file: File) => {
    if (file.type.startsWith('video/')) {
      decodeAbort.current = new AbortController();
      const frame = await extractVideoFirstFrame(file, decodeAbort.current.signal);
      if (!alive.current) return;
      const uploaded = await upload(frame);
      if (!uploaded || !alive.current) return;
      clearVideo();
      sourceUrl.current = URL.createObjectURL(file);
      setSourceVideo({ name: file.name, url: sourceUrl.current, referenceId: uploaded.id });
    } else { if (alive.current) { const uploaded = await upload(file); if (uploaded && alive.current) clearVideo(); } }
  };
  const run = async (source: () => Promise<File | undefined>) => {
    if (locked || pending.current) return;
    pending.current = true; setProcessing(true); setError('');
    try { const file = await source(); if (file && alive.current) await receive(file); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '参考素材读取失败。'); }
    finally { decodeAbort.current = null; pending.current = false; if (alive.current) setProcessing(false); }
  };
  return { processing, error, sourceVideo: sourceVideo?.referenceId === referenceId ? sourceVideo : null, clearVideo,
    receiveFile: (file?: File) => file ? run(() => Promise.resolve(file)) : Promise.resolve(),
    pasteClipboard: () => run(() => readStudioClipboard()),
  };
}
