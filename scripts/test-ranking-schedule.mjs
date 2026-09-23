import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync('backend/index.ts','utf8');
const section=source.slice(source.indexOf('const RANKING_SCHEDULE_TABLE ='),source.indexOf('export const handler =')).replace('export async function','async function');
let now=Date.parse('2026-09-22T18:00:00+08:00'), state=null, advances=0, creates=0, used=0, fail=false;
const clone=x=>structuredClone(x);
const pilot={status:'completed',pilotSize:250,requestPolicyVersion:'finmind-auth-first-v1',schemaVersion:'v7',performance:{successRatio:99.6},result:{pilotByMode:Object.fromEntries(Array.from({length:6},(_,i)=>[i,{evidenceGate:{passed:true}}]))}};
let job={id:'full',status:'queued',phase:'features',currentIndex:0,universe:['2330']};
const ctx={Date:class extends Date{static now(){return now;}},AbortSignal,MARKET_FEATURE_SCHEMA_VERSION:'v7',RANKING_JOB_BATCH_SIZE:20,
 listAllDbRecords:async()=>state?[clone(state)]:[],getFinMindToken:async()=> 'test-secret',
 fetch:async()=>({ok:true,json:async()=>({user_count:used,api_request_limit:600,private:'never-persist'})}),
 db:{add:async(t,[r])=>{state={...clone(r),id:'schedule'};return ['schedule'];},update:async(t,[{record}])=>{state={...clone(record),id:'schedule'};return [true];}},
 readRankingRefreshJob:async id=>id==='full'?clone(job):clone(pilot),
 createRankingRefreshJob:async()=>{creates++;return clone(job);},
 advanceRankingRefreshJob:async()=>{advances++;if(fail)throw Error('private source payload');job.currentIndex++;return clone(job);}
};
const api=vm.runInNewContext(stripTypeScriptTypes(section)+';({rankingScheduleWindow,assertScheduledPilot,readFinMindBudget,rankingDailyHandler})',ctx);
const event=id=>({type:'cron',name:'ranking-offpeak',invocationId:id});
assert.equal(api.rankingScheduleWindow(Date.parse('2026-09-23T07:55:00+08:00')).cycleDate,'2026-09-22');
assert.equal(api.rankingScheduleWindow(Date.parse('2026-09-23T08:00:00+08:00')).offPeak,false);
assert.throws(()=>api.assertScheduledPilot({...pilot,status:'rejected'}));
assert.throws(()=>api.assertScheduledPilot({...pilot,result:{pilotByMode:{}}}));
await api.rankingDailyHandler(event('one'));
assert.equal(advances,1);assert.equal(creates,1);assert.equal(state.runningAt,null);
assert(!JSON.stringify(state).includes('private'));assert(!JSON.stringify(state).includes('secret'));
await api.rankingDailyHandler(event('one'));assert.equal(advances,1);
used=500;await api.rankingDailyHandler(event('two'));assert.equal(advances,1);assert.equal(state.status,'waiting-finmind-budget');
used=0;fail=true;await api.rankingDailyHandler(event('three'));assert.equal(state.blocked,true);assert(!state.reason.includes('private'));
await api.rankingDailyHandler(event('four'));assert.equal(advances,2);
state=null;now=Date.parse('2026-09-23T09:00:00+08:00');await api.rankingDailyHandler(event('five'));assert.equal(state,null);
now=Date.parse('2026-09-23T18:00:00+08:00');state={id:'schedule',runningAt:'interrupted'};await api.rankingDailyHandler(event('six'));assert.equal(advances,2);
console.log('PASS: overnight date boundary, pilot gate, one batch, duplicate invocation, budget wait, failure latch, no credential persistence, daytime skip and ambiguous interruption stop');
fail=false;
const blocked=()=>({id:'schedule',jobId:'full',blocked:true,reason:'Scheduled source or storage errors require inspection.',updatedAt:'2026-09-21T00:00:00Z'});
job.phase='history';job.resolvedHistoryErrors=[];state=blocked();
await api.rankingDailyHandler(event('unrepaired'));assert.equal(advances,2);assert.equal(state.blocked,true);
job.resolvedHistoryErrors=[{resolvedAt:'2026-09-22T00:00:00Z'}];job.historyErrors=[{message:'still missing'}];
await api.rankingDailyHandler(event('partial-repair'));assert.equal(advances,2);
job.historyErrors=[];state=blocked();await api.rankingDailyHandler(event('verified-repair'));
assert.equal(advances,3);assert.equal(state.blocked,false);assert.equal(state.recoveryAudit.length,1);assert.equal(creates,1);
state={...blocked(),reason:'FinMind usage check HTTP 429'};await api.rankingDailyHandler(event('quota-stays-blocked'));assert.equal(advances,3);
console.log('PASS: only verified post-stop history repair resumes the same job; unresolved and quota failures stay blocked');
