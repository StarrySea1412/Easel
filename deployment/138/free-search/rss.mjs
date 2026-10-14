// Bounded RSS parsing without DTD/entity expansion or executing source markup.
export function parseRss(text, count) {
  if (!/<rss\b/i.test(text)) throw new Error('Search source did not return RSS');
  const decode = value => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
      const named = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
      if (named[entity]) return named[entity];
      const number = entity.startsWith('&#x') ? parseInt(entity.slice(3,-1),16) : parseInt(entity.slice(2,-1),10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    }).replace(/\s+/g,' ').trim();
  const rows = []; const seen = new Set();
  for (const match of text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const field = name => decode(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i').exec(match[1])?.[1] || '');
    const title = field('title'); const raw = field('link'); let url;
    try {url = new URL(raw);} catch {continue;}
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !title || seen.has(url.href)) continue;
    seen.add(url.href); rows.push({title:title.slice(0,500),url:url.href,snippet:field('description').slice(0,1500)});
    if (rows.length >= count) break;
  }
  return rows;
}
