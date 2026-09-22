import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync('backend/index.ts','utf8');
const fn=source.slice(source.indexOf('async function requestFinMindDataset('),source.indexOf('function sortByDate('));
let saved, requested;
const old=[{stock_id:'2330',date:'2025-01-01',close:1},{stock_id:'2330',date:'2026-08-01',close:100},{stock_id:'2330',date:'2026-09-18',close:105}];
const context={URLSearchParams,AbortController,setTimeout,clearTimeout,finMindCache:new Map(),finMindInflight:new Map(),FINMIND_PERSISTENT_DATASETS:new Set(['TaiwanStockPrice']),
 FINMIND_API_URL:'https://api.finmindtrade.com/api/v4/data',finMindCacheTtl:()=>1000,
 readPersistentFinMindCache:async()=>({data:old,fetchedAt:Date.now()-5000}),finMindStartDate:()=> '2026-01-01',getFinMindToken:async()=> 'fixture',
 persistFinMindCache:async(key,dataset,code,entry)=>{saved=entry;return true;},recordResponseBytes:()=>{},
 measuredFetch:async(url)=>{requested=new URL(url);return {ok:true,status:200,text:async()=>JSON.stringify({status:200,data:[{stock_id:'2330',date:'2026-09-18',close:106},{stock_id:'2330',date:'2026-09-21',close:107}]})};}
};
const request=vm.runInNewContext(stripTypeScriptTypes(fn)+';requestFinMindDataset',context);
const result=await request('TaiwanStockPrice','2330');
assert.equal(requested.searchParams.get('start_date'),'2026-09-11');
assert.equal(result.data.length,3);
assert.equal(result.data[0].date,'2026-08-01');
assert.equal(result.data[1].close,106);
assert.equal(result.data[2].close,107);
assert.equal(saved.data.length,3);
assert.equal(result.persisted,true);
console.log('PASS: persistent cold read, seven-day overlap, revised row replacement, retained history and canonical pruning');
