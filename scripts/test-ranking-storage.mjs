import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../backend/index.ts', import.meta.url), 'utf8');
const section = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert(start >= 0 && end > start, `${from} production boundary`);
  return source.slice(start, end);
};
const tables = new Map();
const table = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
let nextId = 0, writes = 0, maxItem = 0, maxRequest = 0, chunkFailure = false, checkpointFailure = null, snapshotFailure = false;
let rejectedMode = null;
const copy = value => JSON.parse(JSON.stringify(value));
function measure(records, envelope) {
  const bytes = Buffer.byteLength(JSON.stringify(envelope));
  maxRequest = Math.max(maxRequest, bytes);
  assert(bytes <= 1024 * 1024, 'SDK request size');
  assert(records.length <= 500, 'SDK element count');
  records.forEach(record => { const size = Buffer.byteLength(JSON.stringify(record)); maxItem = Math.max(maxItem, size); assert(size <= 256 * 1024, 'SDK item size'); });
}
const db = {
  async add(name, records) {
    measure(records, { table: name, records });
    return records.map((record, index) => {
      writes++;
      if ((chunkFailure && name === 'ranking_record_chunks_v1' && index === 1) || (snapshotFailure && name === 'snapshots' && index === 1)) { chunkFailure = false; snapshotFailure = false; return null; }
      const id = `id-${++nextId}`; table(name).set(id, copy(record)); return id;
    });
  },
  async get(name, ids) { measure([], { table: name, ids }); return ids.map(id => table(name).has(id) ? copy(table(name).get(id)) : null); },
  async update(name, entries) {
    measure(entries.map(entry => entry.record), { table: name, entries });
    return entries.map(({ id, record }) => {
      if (!table(name).has(id)) return false;
      const fail = name === 'jobs' && record.currentIndex === 20 && record.status === 'queued' && checkpointFailure;
      if (fail === 'before') { checkpointFailure = null; throw Error('injected pre-commit interruption'); }
      table(name).set(id, copy(record)); writes++;
      if (fail === 'after') { checkpointFailure = null; throw Error('injected lost acknowledgement'); }
      return true;
    });
  },
};
const context = {
  db, TextEncoder, console, structuredClone, MARKET_FEATURE_SCHEMA_VERSION: 'market-features-v7-official-universe',
  RANKING_REFRESH_JOB_TABLE: 'jobs', MARKET_HISTORY_DAY_TABLE: 'days', MARKET_FEATURE_BATCH_TABLE: 'features', RANKING_SNAPSHOT_TABLE: 'snapshots', RANKING_REGISTRY_TABLE: 'registry',
  RANKING_JOB_BATCH_SIZE: 20, RANKING_JOB_CONCURRENCY: 4, RANKING_OUTPUT_LIMIT: 64,
  emptyExternalRequestMetrics: () => ({ total: 0 }), mergeExternalRequestMetrics: () => {},
  loadOfficialHistoryForCodes: async () => new Map(),
  loadValueScore: async code => ({ ok: true, code, detail: 'evidence'.repeat(1200) }),
  compactRankingItem: value => value, withTimeout: value => value,
  settleWithLimit: (values, limit, fn) => Promise.all(values.map(async value => ({ status: 'fulfilled', value: await fn(value) }))),
  compareRankingItems: (a, b) => a.code.localeCompare(b.code), screenerSortValue: () => 1,
  applyRankingEvidenceGate: (payload, mode) => ({ ...payload, ok: mode !== rejectedMode, items: payload.items.slice(0, 64), evidenceGate: { passed: mode !== rejectedMode } }),
  activeRankingRegistry: async () => ({ id: 'active', ...table('registry').get('active') }),
  stableEvidenceId: () => 'test-batch',
};
const code = section('function assertRankingJobResumable(', 'async function loadTaiwanCompanyUniverse(')
  + section('async function readRankingRefreshJob(', 'async function publishMarketThemeSnapshot(')
  + section('async function advanceRankingRefreshJob(', 'function normalizeStockSearchText(')
  + section('async function publishRankingSnapshots(', 'function compactRankingItem(');
const api = runInNewContext(stripTypeScriptTypes(code) + '\n({retryRankingHistory, auditRankingStorage, packRankingRecord, unpackRankingRecord, addRankingRecords, getRankingRecords, readRankingRefreshJob, saveRankingRefreshJob, loadMarketFeatureRows, advanceRankingRefreshJob, publishRankingSnapshots});', context);

for (const count of [1976, 6000]) {
  const profiles = Array.from({ length: count }, (_, i) => ({ code: String(1000 + i), name: '測試公司😀', officialQuote: { close: 100, source: 'fixture'.repeat(60) } }));
  const state = { companyProfiles: profiles, universe: profiles.map(p => p.code),
    historyProfileBatchByCode: Object.fromEntries(profiles.map(p => [p.code, `history-id-${p.code}`])),
    result: { items: profiles.map(p => ({ code: p.code, evidence: '測試'.repeat(100) })) },
    currentIndex: 0, status: 'queued' };
  const [id] = await api.addRankingRecords('jobs', [state]);
  assert(!table('jobs').get(id).companyProfiles, 'Company data must not remain inline');
  let job = await api.readRankingRefreshJob(id);
  assert.equal(JSON.stringify(job.companyProfiles), JSON.stringify(profiles));
  assert.equal(JSON.stringify(job.universe), JSON.stringify(state.universe));
  assert.equal(JSON.stringify(job.historyProfileBatchByCode), JSON.stringify(state.historyProfileBatchByCode));
  assert.equal(JSON.stringify(job.result), JSON.stringify(state.result));
  const priorWrites = writes; job.currentIndex = 20; await api.saveRankingRefreshJob(id, job);
  assert.equal(writes - priorWrites, 1, 'Unchanged chunks must be reused');
  job.companyProfiles[0].name = 'changed'; chunkFailure = true;
  await assert.rejects(() => api.saveRankingRefreshJob(id, job));
  job = await api.readRankingRefreshJob(id);
  assert.equal(job.companyProfiles[0].name, '測試公司😀', 'Partial chunks must not replace checkpoint');
  const descriptor = table('jobs').get(id).rankingStorage.fields.companyProfiles;
  const removed = table('ranking_record_chunks_v1').get(descriptor.ids[0]);
  table('ranking_record_chunks_v1').delete(descriptor.ids[0]);
  await assert.rejects(() => api.readRankingRefreshJob(id), /missing/);
  table('ranking_record_chunks_v1').set(descriptor.ids[0], removed);
}

const historyItems = Array.from({ length: 20 }, (_, i) => ({ code: String(1000 + i), bars: Array.from({ length: 120 }, (_, day) => [`day-${day}`, 100, 110, 90, 105, 1000000]) }));
const [historyId] = await api.addRankingRecords('history', [{ items: historyItems }]);
assert.equal(JSON.stringify((await api.getRankingRecords('history', [historyId]))[0].items), JSON.stringify(historyItems));

for (const failure of ['before', 'after']) {
  const universe = Array.from({ length: 40 }, (_, i) => String(1000 + i));
  const [id] = await api.addRankingRecords('jobs', [{ createdAt: new Date().toISOString(), schemaVersion: context.MARKET_FEATURE_SCHEMA_VERSION,
    phase: 'features', status: 'queued', universe, companyProfiles: universe.map(code => ({ code })), currentIndex: 0, scoredCount: 0, featureBatchIds: {}, performance: {} }]);
  checkpointFailure = failure;
  await api.advanceRankingRefreshJob(id);
  let job = await api.readRankingRefreshJob(id);
  assert.equal(job.currentIndex, failure === 'before' ? 0 : 20);
  while (job.currentIndex < 40) { await api.advanceRankingRefreshJob(id); job = await api.readRankingRefreshJob(id); }
  assert.equal(job.scoredCount, 40, 'Resume must not double-count');
  assert.equal(job.performance.stockAttempts, 40);
  assert.equal((await api.loadMarketFeatureRows(job)).length, 40);
  const featureId = Object.values(job.featureBatchIds)[0];
  const feature = table('features').get(featureId);
  table('features').delete(featureId);
  await assert.rejects(() => api.loadMarketFeatureRows(job), /missing/);
  table('features').set(featureId, feature);
}

table('registry').set('active', { activeByMode: { undervalued: 'old' } });
const payload = { generatedAt: new Date().toISOString(), items: Array.from({ length: 64 }, (_, i) => ({ code: String(1000 + i), evidence: '詳細'.repeat(2500) })) };
snapshotFailure = true;
const beforeRejectedWrites = writes;
rejectedMode = 'growth';
const rejected = await api.publishRankingSnapshots(payload, 'undervalued');
assert.equal(rejected.ok, false);
assert.equal(writes, beforeRejectedWrites, 'A failed secondary mode must block every snapshot write');
assert.equal(rejected.batch.publishedModes.length, 0);
rejectedMode = null;
await assert.rejects(() => api.publishRankingSnapshots(payload, 'undervalued'));
assert.equal(table('registry').get('active').activeByMode.undervalued, 'old', 'Partial snapshot write cannot activate');
await api.publishRankingSnapshots(payload, 'undervalued');
const activeId = table('registry').get('active').activeByMode.undervalued;
const [snapshot] = await api.getRankingRecords('snapshots', [activeId]);
assert.equal(snapshot.payload.items.length, 64);
const priorRegistry = JSON.stringify(table('registry').get('active'));
await api.publishRankingSnapshots(payload, 'undervalued', { activate: false });
assert.equal(JSON.stringify(table('registry').get('active')), priorRegistry, 'Pilot cannot activate a snapshot');
const [legacyId] = await db.add('legacy', [{ items: [{ code: '2330' }] }]);
assert.equal((await api.getRankingRecords('legacy', [legacyId]))[0].items[0].code, '2330');
const [auditDay] = await api.addRankingRecords('days', [{market:'twse',date:'2026-09-18',rows:[['2330',100,110,95,105,1000]]}]);
context.loadOfficialHistoricalMarketDay = async (market,date) => ({market,date,rows:[['2330',100,110,95,105,1000]]});
context.persistOfficialHistoricalMarketDay = async record => (await api.addRankingRecords('days',[record]))[0];
const [retryJob] = await api.addRankingRecords('jobs',[{schemaVersion:context.MARKET_FEATURE_SCHEMA_VERSION,createdAt:new Date().toISOString(),phase:'history',status:'queued',historyErrors:[{market:'twse',date:'2026-07-02',message:'terminated'}],historyDayIds:{},historySessionCounts:{twse:0,tpex:0}}]);
const repaired = await api.retryRankingHistory(retryJob);
assert.equal(repaired.historySessionCounts.twse,1);
assert.equal(repaired.resolvedHistoryErrors.length,1);
assert.equal((await api.retryRankingHistory(retryJob)).historySessionCounts.twse,1);
const quotaJob = table('jobs').get(retryJob);
quotaJob.historyErrors=[{market:'twse',date:'2026-07-01',message:'429 quota'}];
const writesBeforeQuota=writes;
await assert.rejects(()=>api.retryRankingHistory(retryJob),/Quota/);
assert.equal(writes,writesBeforeQuota);
const [auditJob] = await api.addRankingRecords('jobs', [{companyProfiles:[{code:'2330'}],historyDayIds:{'twse:2026-09-18':auditDay}}]);
const audited = await api.auditRankingStorage(auditJob,0);
assert.equal(audited.day.valid,true);
assert.equal(audited.day.rows,1);
assert(audited.storage.chunkCount>0);
assert(audited.day.storage.maxItemBytes>0);
await assert.rejects(()=>api.auditRankingStorage(auditJob,-1),/Invalid/);
table('days').get(auditDay).rows.push(['2330',100,110,95,105,1000]);
await assert.rejects(()=>api.auditRankingStorage(auditJob,0),/duplicate/);
table('days').delete(auditDay);
await assert.rejects(()=>api.auditRankingStorage(auditJob,0),/identity/);
console.log(JSON.stringify({ ok: true, companyCounts: [1976, 6000], maxItemBytes: maxItem, maxRequestBytes: maxRequest,
  checks: ['round-trip', 'unchanged chunk reuse', 'partial chunk failure', 'missing chunk rejection', 'pre/post commit interruption', 'no duplicate scoring', 'snapshot activation guard', 'pilot isolation', 'legacy reads'], limitations: ['mock database; no remote writes', 'single-worker interruption testing; not a distributed concurrency proof', 'failed writes can leave unreferenced chunks; no deletion performed'] }));
