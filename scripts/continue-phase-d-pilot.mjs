import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = Object.fromEntries(process.argv.slice(2).filter(arg=>arg.includes('=')).map(arg=>arg.replace(/^--/,'').split('=')));
assert(process.argv.includes('--execute'), 'Pass --execute to advance the authorized pilot');
assert(/^[a-f0-9-]{36}$/.test(args.job || ''), 'An existing pilot job ID is required');
const out = path.resolve(args.output || `outputs/phase-d-run-${Date.now()}`);
await mkdir(out,{recursive:true});
const base='https://api-v2.appdeploy.ai/app/932f5348aea14e86a7';
const jobPath='/api/screener/refresh/jobs/'+args.job;
let sequence=0;
const deadline=Date.now()+90*60*1000;
async function request(route,method='GET') {
  const res=await fetch(base+route,{method,headers:{Accept:'application/json'},signal:AbortSignal.timeout(70000)});
  const text=await res.text();
  await writeFile(path.join(out,`${String(++sequence).padStart(3,'0')}-${method}.json`),text);
  let value; try {value=JSON.parse(text);} catch {throw Error(`Non-JSON HTTP ${res.status}`);}
  assert(res.ok && value.ok!==false,`HTTP ${res.status}: ${value.message}`);
  return value;
}
function validate(job) {
  assert.equal(job.schemaVersion,'market-features-v7-official-universe');
  assert.equal(job.scope,'twse-tpex-pilot-250');
  assert.equal(job.pilot?.size,250);
  assert(!job.historyErrors?.length,`Historical source errors: ${JSON.stringify(job.historyErrors)}`);
  assert(!job.batchErrors?.length,`Batch errors: ${JSON.stringify(job.batchErrors)}`);
  assert(!job.performance?.externalRequests?.failed, 'Provider failure encountered; preserve evidence and stop');
}
async function auditDays() {
  const audits=[];
  for(let index=0;index<240;index++) {
    const audit=await request(jobPath+'/storage-audit?dayIndex='+index);
    assert(audit.universeMeta?.directorySourceDates?.twse && audit.universeMeta?.directorySourceDates?.tpex,'Missing official source dates');
    assert(audit.universeMeta?.sampleFingerprint,'Missing sample fingerprint');
    if(audit.totalDays) assert(audit.day?.valid,'History validation missing');
    audits.push(audit);
    if(audit.nextDayIndex===null) break;
  }
  await writeFile(path.join(out,`audit-${audits.length}-days.json`),JSON.stringify(audits,null,2));
  console.log(JSON.stringify({auditDays:audits.length,maxItemBytes:Math.max(...audits.flatMap(a=>[a.storage.maxItemBytes,a.day?.storage.maxItemBytes||0]))}));
}
try {
  let job=await request(jobPath); validate(job);
  await auditDays();
  for(let batch=0;batch<180 && !job.done;batch++) {
    assert(Date.now()<deadline,'90-minute limit reached');
    const before=job;
    job=await request(jobPath+'/advance','POST');
    validate(job);
    const readback=await request(jobPath);
    assert.deepEqual(readback,job,'Persisted checkpoint differs');
    console.log(JSON.stringify({batch,phase:job.phase,progress:job.progress,message:job.message}));
    assert(job.status!=='failed',job.message);
    if(before.phase==='history' && job.phase!=='history') await auditDays();
    assert(JSON.stringify(before)!==JSON.stringify(job),'No progress; do not retry silently');
  }
  assert(job.done,'Batch limit reached');
  await writeFile(path.join(out,'final.json'),JSON.stringify(job,null,2));
  assert.equal(job.status,'completed','Pilot did not complete');
  assert(!job.result?.batch?.publishedModes?.length,'Pilot must not publish');
  const modes=Object.values(job.result?.pilotByMode || {});
  assert.equal(modes.length,6,'Six mode results required');
  assert(modes.every(mode=>mode.evidenceGate?.passed),'Not all six modes passed evidence gates');
  console.log('Pilot acceptance passed; full-market remains a separate execution step.');
} catch(error) {
  await writeFile(path.join(out,'stop.json'),JSON.stringify({at:new Date().toISOString(),jobId:args.job,message:error.message,requests:sequence},null,2));
  console.error(error.message); process.exitCode=1;
}
