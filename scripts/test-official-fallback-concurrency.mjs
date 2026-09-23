import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
const s=fs.readFileSync('backend/index.ts','utf8');
const from=s.indexOf('  const financialNeedsFallback =');
const to=s.indexOf('  if (financialNeedsFallback)',from);
const calls=[],release=[];
const ctx={code:'2330',options:{evidenceMinimum:true},assetType:'stock',data:{},
 loadOfficialFinancialFallback:()=>new Promise(r=>{calls.push('financial');release.push(()=>r({profitability:1}));}),
 loadOfficialRevenueFallback:()=>new Promise((r,j)=>{calls.push('revenue');release.push(()=>j(Error('fixture failure')));}),
 loadOfficialValuationFallback:()=>new Promise(r=>{calls.push('valuation');release.push(()=>r({valuation:1}));})};
const run=vm.runInNewContext('(async()=>{'+stripTypeScriptTypes(s.slice(from,to))+';return officialFallbackResults;})',ctx);
const pending=run();
assert.deepEqual(calls,['financial','revenue','valuation']);
release.forEach(r=>r());
const result=await pending;
assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');assert.equal(result[2].status,'fulfilled');
calls.length=0;
ctx.data={profitability:{},balanceSheet:{},revenue:{},valuation:{per:1,pbr:1,dividendYield:0}};
await run();assert.equal(calls.length,0);
console.log('PASS: independent sources start together, failures stay isolated, complete evidence makes no fallback requests');
