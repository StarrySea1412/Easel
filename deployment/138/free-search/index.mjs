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
        parameters:{type:'object',properties:{query:{type:'string',maxLength:1000},count:{type:'integer',minimum:1,maximum:10},freshnessDays:{type:'integer',minimum:1,maximum:366,description:'Strict publication-date window. Undated results are excluded; retrieval time is never treated as publication time.'}},required:['query'],additionalProperties:false},
        async execute(args,context) {
          context?.signal?.throwIfAborted();
          if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000) throw new Error('Invalid search query');
          const count = Number.isInteger(args.count) ? Math.min(10,Math.max(1,args.count)) : 5;
          if (args.freshnessDays != null && (!Number.isInteger(args.freshnessDays) || args.freshnessDays < 1 || args.freshnessDays > 366)) throw new Error('Invalid freshness window');
          const key = JSON.stringify([args.query,count,args.freshnessDays]); const saved = cache.get(key);
          if (saved && Date.now()-saved.time < (args.freshnessDays ? 60000 : 900000)) return {...saved.value,cached:true};
          const url = new URL('https://cn.bing.com/search');url.searchParams.set('q',args.query);url.searchParams.set('format','rss');
          const started = Date.now();
          const rows = await withTrustedWebSearchEndpoint({url:url.href,timeoutSeconds:12,signal:context?.signal,
            init:{headers:{'User-Agent':'Mozilla/5.0 (compatible; Easel search)'}}},async response => {
              if (!response.ok) throw new Error('Bing search HTTP '+response.status);
              const body = await readResponseText(response,{maxBytes:524288});
              if (body.truncated) throw new Error('Search response exceeds the size limit');
              return parseRss(body.text,args.freshnessDays ? 100 : count,{freshnessDays:args.freshnessDays}).slice(0,count);
            });
          const payload = {query:args.query,provider:'easel-search',source:'Bing RSS',sourceUrl:url.href,count:rows.length,tookMs:Date.now()-started,retrievedAt:new Date().toISOString(),
            freshnessDays:args.freshnessDays ?? null,dateNote:'Publication dates are source-provided and unverified; missing dates are unknown. An empty strict-date result does not prove there is no recent news.',
            externalContent:{untrusted:true,source:'web_search',provider:'easel-search',wrapped:true},
            results:rows.map(row=>({...row,title:wrapWebContent(row.title,'web_search'),snippet:wrapWebContent(row.snippet,'web_search')}))};
          if (cache.size >= 100) cache.delete(cache.keys().next().value);
          cache.set(key,{time:Date.now(),value:payload});return payload;
        }
      })
    });
  }
});
