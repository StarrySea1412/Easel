import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRss} from './rss.mjs';
test('RSS keeps real source links, decoded Chinese text and bounded unique results',()=>{
  const xml='<rss><channel><item><title>官方 &amp; 更新</title><link>https://example.com/a?q=1&amp;x=2</link><description><![CDATA[<b>中文</b> 摘要]]></description></item><item><title>重复</title><link>https://example.com/a?q=1&amp;x=2</link></item><item><title>另一个</title><link>https://example.org/</link></item></channel></rss>';
  assert.deepEqual(parseRss(xml,1),[{title:'官方 & 更新',url:'https://example.com/a?q=1&x=2',snippet:'中文 摘要'}]);
  assert.equal(parseRss(xml,10).length,2);
});
test('rejects non-RSS responses and unsafe link schemes without expanding external entities',()=>{
  assert.throws(()=>parseRss('<html>challenge</html>',5),/RSS/);
  assert.deepEqual(parseRss('<rss><item><title>X</title><link>javascript:alert(1)</link></item><item><title>X</title><link>https://user:pass@example.com/</link></item></rss>',5),[]);
});

test('deduplicates tracking URLs and long matching titles while preserving distinct query content',()=>{
  const item=(title,url,date='')=>`<item><title>${title}</title><link>${url}</link>${date?`<pubDate>${date}</pubDate>`:''}</item>`;
  const xml='<rss>'+item('A','https://example.com/a?id=1&amp;utm_source=a')+item('B','https://example.com/a?utm_source=b&amp;id=1')+item('C','https://example.com/a?id=2')+item('相同的新闻报道标题需要避免重复','https://other.com/')+item('相同的新闻报道标题需要避免重复','https://third.com/')+'</rss>';
  assert.equal(parseRss(xml,10).length,3);
});

test('strict recency excludes unknown old and future dates instead of substituting fetch time',()=>{
  const now=Date.parse('2026-10-16T12:00:00Z');
  const xml='<rss>'+[['old','2020-01-01'],['unknown',''],['future','2030-01-01'],['new','2026-10-16T10:00:00Z'],['recent','2026-10-15T10:00:00Z']].map(([title,date])=>`<item><title>${title}</title><link>https://example.com/${title}</link><pubDate>${date}</pubDate></item>`).join('')+'</rss>';
  const rows=parseRss(xml,10,{freshnessDays:7,now});
  assert.deepEqual(rows.map(row=>row.title),['new','recent']);
  assert.ok(rows.every(row=>row.dateSource==='rss_pubDate'));
  assert.equal(parseRss(xml,10,{now}).find(row=>row.title==='unknown').publishedAt,undefined);
  assert.throws(()=>parseRss(xml,10,{freshnessDays:0,now}),/freshness/);
  assert.throws(()=>parseRss('<!DOCTYPE rss><rss/>',1),/declarations/);
});
