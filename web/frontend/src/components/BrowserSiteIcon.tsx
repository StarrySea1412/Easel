import { useState } from 'react';
import { IconCompass } from './icons';

function SiteImage({ source }: { source: string }) {
  const [status,setStatus] = useState<'loading'|'loaded'|'failed'>('loading');
  return <>{status !== 'loaded' && <IconCompass size={14}/>}{status !== 'failed' &&
    <img src={source} alt="" hidden={status !== 'loaded'} onLoad={()=>setStatus('loaded')} onError={()=>setStatus('failed')}/>}</>;
}

export default function BrowserSiteIcon({ source }: { source?: string }) {
  const allowed = source && source.length < 90000 && /^data:image\/(png|jpeg|webp|gif|x-icon|vnd.microsoft.icon);base64,[A-Za-z0-9+/=]+$/.test(source);
  return <span className="browser-site-icon" aria-hidden="true">{allowed
    ? <SiteImage key={source} source={source}/>: <IconCompass size={14}/>}</span>;
}
