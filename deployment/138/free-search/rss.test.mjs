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
