import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync('backend/index.ts','utf8');
const start=source.indexOf('async function loadNews(');
const end=source.indexOf('\nasync function ',start+10);
const original='2026-09-22T10:00:00Z';
const cache=new Map([['2330:TSMC',{fetchedAt:Date.now()-2000,payload:{ok:true,generatedAt:original,items:[{title:'fixture'}]}}]]);
const load=vm.runInNewContext(stripTypeScriptTypes(source.slice(start,end))+';loadNews',{
 Date,newsCache:cache,newsInflight:new Map(),NEWS_CACHE_TTL_MS:1000,NEWS_STALE_TTL_MS:100000,
 fetchText:async()=>{throw Error('upstream unavailable');},FALLBACK_NAMES:{},
});
const result=await load('2330','TSMC');
assert.equal(result.stale,true);assert.equal(result.generatedAt,original);
assert.equal(result.unavailableReason,'upstream');
console.log('PASS: failed news refresh preserves cached evidence timestamp and labels stale data');
