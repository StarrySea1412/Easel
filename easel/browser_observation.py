"""Page-side observation; only the browser adapter executes this fixed script."""

OBSERVE = r"""() => {
  const visible = el => {
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const clean = value => (value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const role = el => el.getAttribute('role') || ({A:'link',BUTTON:'button',TEXTAREA:'textbox',SELECT:'combobox',SUMMARY:'button'}[el.tagName]) ||
    (el.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',button:'button',submit:'button'}[el.type] || 'textbox') : 'element');
  const name = el => clean(el.getAttribute('aria-label') ||
    (el.getAttribute('aria-labelledby') || '').split(' ').map(id => document.getElementById(id)?.textContent || '').join(' ') ||
    Array.from(el.labels || []).map(label => label.textContent).join(' ') || el.innerText || el.getAttribute('placeholder') || el.title || el.alt);
  const candidates = document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[contenteditable=true]');
  const nodes = Array.from(candidates).filter(visible).slice(0, 120);
  const elements = nodes.map((el, i) => {
    const box = el.getBoundingClientRect();
    return {ref:'e'+i,role:role(el),name:name(el),tag:el.tagName.toLowerCase(),
      disabled:!!el.disabled || el.getAttribute('aria-disabled') === 'true',
      sensitive: el.type === 'password' || /password|one-time-code|cc-number/.test(el.autocomplete || ''),
      x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)};
  });
  const root = document.querySelector('main,[role=main],article') || document.body;
  const clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,svg,nav,aside,footer,[hidden],[aria-hidden=true]').forEach(el => el.remove());
  clone.querySelectorAll('p,h1,h2,h3,h4,div,section,article,li,tr,br').forEach(el => {
    el.prepend(document.createTextNode('\n')); el.append(document.createTextNode('\n'));
  });
  const text = (clone.textContent || '').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim().slice(0, 24000);
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]')).filter(visible).slice(0,80)
    .map(el => ({level:el.getAttribute('aria-level') || el.tagName.slice(1),text:clean(el.innerText)}));
  const icon = Array.from(document.querySelectorAll('link[rel~="icon"]')).find(el => {
    try { const url = new URL(el.href); return /^https?:$/.test(url.protocol) && url.origin === location.origin; } catch { return false; }
  });
  const faviconUrl = /^https?:$/.test(location.protocol) ? (icon?.href || new URL('/favicon.ico', location.href).href) : '';
  return {data:{title:document.title,url:location.href,text,faviconUrl,selection:String(getSelection() || '').slice(0,8000),
    viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},headings,elements,
    frames:Array.from(document.querySelectorAll('iframe')).map(el=>({title:el.title || '',src:el.getAttribute('src') || ''})).slice(0,20)},nodes,document};
}"""

ELEMENT_NAME = r"""el => ({connected:el.isConnected,name:(el.getAttribute('aria-label') ||
  (el.getAttribute('aria-labelledby') || '').split(' ').map(id=>document.getElementById(id)?.textContent || '').join(' ') ||
  Array.from(el.labels || []).map(label=>label.textContent).join(' ') || el.innerText || el.getAttribute('placeholder') || el.title || el.alt || '')
  .replace(/\s+/g,' ').trim().slice(0,240)})"""

# Fetch only same-origin raster icons through Chromium's guarded network.
READ_FAVICON = r"""async url => {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(url, {signal:controller.signal, credentials:'omit', mode:'same-origin'});
    const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!response.ok || !['image/png','image/jpeg','image/webp','image/gif','image/x-icon','image/vnd.microsoft.icon'].includes(type)) return '';
    const reader = response.body.getReader(); let bytes = [], size = 0;
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length; if (size > 65536) { await reader.cancel(); return ''; }
      bytes.push(value);
    }
    const data = new Uint8Array(size); let offset = 0;
    for (const part of bytes) { data.set(part,offset); offset += part.length; }
    return 'data:'+type+';base64,'+btoa(String.fromCharCode(...data));
  } catch { return ''; } finally { clearTimeout(timer); }
}"""
