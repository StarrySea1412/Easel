// Bounded RSS parsing without DTD/entity expansion or executing source markup.
export function parseRss(text, count, { freshnessDays, now = Date.now() } = {}) {
  if (!/<rss\b/i.test(text)) throw new Error('Search source did not return RSS');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('RSS declarations are not supported');
  if (freshnessDays != null && (!Number.isInteger(freshnessDays) || freshnessDays < 1 || freshnessDays > 366)) throw new Error('Invalid freshness window');
  count = Number.isInteger(count) ? Math.min(100, Math.max(1, count)) : 5;
  const decode = value => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
      const named = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
      if (named[entity]) return named[entity];
      const number = entity.startsWith('&#x') ? parseInt(entity.slice(3,-1),16) : parseInt(entity.slice(2,-1),10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    }).replace(/\s+/g,' ').trim();
  const rows = []; const seen = new Set(); const titles = new Set();
  for (const match of text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const field = name => decode(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i').exec(match[1])?.[1] || '');
    const title = field('title'); const raw = field('link'); let url;
    try {url = new URL(raw);} catch {continue;}
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !title) continue;
    const canonical = new URL(url.href); canonical.hash = '';
    for (const name of [...canonical.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|msclkid$)/i.test(name)) canonical.searchParams.delete(name);
    canonical.searchParams.sort();
    const titleKey = title.normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
    if (seen.has(canonical.href) || (titleKey.length >= 12 && titles.has(titleKey))) continue;
    const stamp = Date.parse(field('pubDate'));
    const dated = Number.isFinite(stamp) && stamp > 0 && stamp <= now + 300000;
    // Never substitute retrieval time for publication time. A strict recency
    // query cannot certify undated results as recent news.
    if (freshnessDays && (!dated || now - stamp > freshnessDays * 86400000)) continue;
    seen.add(canonical.href); titles.add(titleKey);
    rows.push({title:title.slice(0,500),url:url.href,snippet:field('description').slice(0,1500),
      ...(dated ? {publishedAt:new Date(stamp).toISOString(),dateSource:'rss_pubDate'} : {})});
    if (rows.length >= count) break;
  }
  return freshnessDays ? rows.sort((a,b) => Date.parse(b.publishedAt)-Date.parse(a.publishedAt)) : rows;
}
