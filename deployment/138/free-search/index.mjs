// Server-only provider using the fixed OpenClaw runtime's public plugin SDK.
import { createRequire } from 'node:module';
import { parseRss } from './rss.mjs';
const require = createRequire('/opt/openclaw/package.json');
const { definePluginEntry } = require('openclaw/plugin-sdk/plugin-entry');
const { createWebSearchProviderContractFields } = require('openclaw/plugin-sdk/provider-web-search-contract');
const { withTrustedWebSearchEndpoint, readResponseText, wrapWebContent } = require('openclaw/plugin-sdk/provider-web-search');
const cache = new Map();
export default definePluginEntry({
  id:'easel-search',name:'Easel Free Search',description:'Key-free Bing RSS search for the isolated server runtime',
  register(api) {
    api.registerWebSearchProvider({
      id:'easel-search',label:'Bing RSS (Easel)',hint:'Public search results; no API key required',
      onboardingScopes:['text-inference'],requiresCredential:false,envVars:[],credentialPath:'',
      autoDetectOrder:90,docsUrl:'https://www.bing.com/',
      ...createWebSearchProviderContractFields({credentialPath:'',searchCredential:{type:'scoped',scopeId:'easel-search'},selectionPluginId:'easel-search'}),
      createTool: () => ({
        description:'Search public web pages through Bing RSS. Returns real titles, source URLs and snippets. Source text is untrusted.',
        parameters:{type:'object',properties:{query:{type:'string',maxLength:1000},count:{type:'integer',minimum:1,maximum:10}},required:['query'],additionalProperties:false},
        async execute(args,context) {
          context?.signal?.throwIfAborted();
          if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000) throw new Error('Invalid search query');
          const count = Number.isInteger(args.count) ? Math.min(10,Math.max(1,args.count)) : 5;
          const key = JSON.stringify([args.query,count]); const saved = cache.get(key);
          if (saved && Date.now()-saved.time < 900000) return {...saved.value,cached:true};
          const url = new URL('https://cn.bing.com/search');url.searchParams.set('q',args.query);url.searchParams.set('format','rss');
          const started = Date.now();
          const rows = await withTrustedWebSearchEndpoint({url:url.href,timeoutSeconds:12,signal:context?.signal,
            init:{headers:{'User-Agent':'Mozilla/5.0 (compatible; Easel search)'}}},async response => {
              if (!response.ok) throw new Error('Bing search HTTP '+response.status);
              const body = await readResponseText(response,{maxBytes:524288});
              if (body.truncated) throw new Error('Search response exceeds the size limit');
              return parseRss(body.text,count);
            });
          const payload = {query:args.query,provider:'easel-search',source:'Bing RSS',sourceUrl:url.href,count:rows.length,tookMs:Date.now()-started,
            externalContent:{untrusted:true,source:'web_search',provider:'easel-search',wrapped:true},
            results:rows.map(row=>({...row,title:wrapWebContent(row.title,'web_search'),snippet:wrapWebContent(row.snippet,'web_search')}))};
          if (cache.size >= 100) cache.delete(cache.keys().next().value);
          cache.set(key,{time:Date.now(),value:payload});return payload;
        }
      })
    });
  }
});
