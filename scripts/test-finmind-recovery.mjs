import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('../backend/index.ts',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const program=section('type ExternalRequestMetrics =','function recordResponseBytes(')+section('async function requestFinMindDataset(','function sortByDate(');
class FinMindError extends Error {constructor(message,status,code){super(message);this.status=status;this.code=code;}}
const cases=[
  {name:'token first',token:'fixture',statuses:[200],calls:1,recovered:0},
  {name:'anonymous only without token',token:'',statuses:[200],calls:1,recovered:0},
  {name:'quota stops',token:'fixture',statuses:[402,200],calls:1,error:true},
  {name:'auth stops',token:'fixture',statuses:[403,200],calls:1,error:true},
  {name:'server error recovered',token:'fixture',statuses:[500,200],calls:2,recovered:1},
  {name:'transport recovered',token:'fixture',statuses:[0,200],calls:2,recovered:1},
  {name:'transport exhausted',token:'fixture',statuses:[0,0],calls:2,error:true},
  {name:'HTTP200 logical quota',token:'fixture',statuses:[200],payloadStatus:402,calls:1,error:true},
];
for(const test of cases){
 const calls=[];
 const context={URL,URLSearchParams,AbortController,setTimeout,clearTimeout,FinMindError,
  finMindCache:new Map(),finMindInflight:new Map(),FINMIND_PERSISTENT_DATASETS:new Set(),FINMIND_API_URL:'https://api.finmindtrade.com/api/v4/data',
  finMindCacheTtl:()=>86400000,getFinMindToken:async()=>test.token,finMindStartDate:()=> '2025-01-01',
  persistFinMindCache:async()=>{},recordResponseBytes:()=>{},finMindPublicMessage:e=>e.code,
  finMindErrorCode:s=>s===402?'quota_exceeded':s===403?'auth_error':s>=500?'upstream_error':'invalid_response',
  fetch:async(url,init)=>{const status=test.statuses[calls.length];calls.push({auth:init.headers.Authorization});if(!status)throw Error('network failed');return {ok:status===200,status,text:async()=>JSON.stringify({status:test.payloadStatus||status,data:status===200?[{value:1}]:null,msg:'fixture'})};}};
 const api=runInNewContext(stripTypeScriptTypes(program)+'\n({requestFinMindDataset,emptyExternalRequestMetrics,mergeExternalRequestMetrics});',context);
 const metrics=api.emptyExternalRequestMetrics();
 if(test.error)await assert.rejects(()=>api.requestFinMindDataset('TaiwanStockCashFlowsStatement','2330',5000,metrics));
 else assert.equal((await api.requestFinMindDataset('TaiwanStockCashFlowsStatement','2330',5000,metrics)).data.length,1);
 assert.equal(calls.length,test.calls,test.name);
 assert(calls.every(c=>Boolean(c.auth)===Boolean(test.token)),test.name+' identity changed');
 assert.equal(metrics.unresolvedFinMind||0,test.error?1:0,test.name);
 assert.equal(metrics.recoveredFailures||0,test.recovered||0,test.name);
 const merged=api.emptyExternalRequestMetrics();api.mergeExternalRequestMetrics(merged,metrics);
 assert.equal(merged.recoveredFailures,metrics.recoveredFailures||0);
 assert(!JSON.stringify(metrics).includes('fixture'),'No token or raw error body in metrics');
 if(!test.error) assert.equal(metrics.failed-(metrics.recoveredFailures||0),0,'Recovered attempt must not stop runner');
}
console.log(JSON.stringify({ok:true,cases:cases.map(t=>t.name),scope:'production request and metrics functions; mock transport only'}));
