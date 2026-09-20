import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../backend/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('function buildOfficialRankingUniverse(');
const end = source.indexOf('async function loadTaiwanCompanyUniverse(', start);
assert(start >= 0 && end > start);
const api = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + '\n({knownMarketClosure, buildOfficialRankingUniverse, assertRankingJobResumable, rankingDbWriteBatches});', {
  MARKET_UNIVERSE_MIN_TWSE_COUNT: 900, MARKET_UNIVERSE_MIN_TPEX_COUNT: 700,
  MARKET_UNIVERSE_MIN_LISTED_OTC_COUNT: 1700, MARKET_FEATURE_SCHEMA_VERSION: 'market-features-v7-official-universe', TextEncoder,
});
const now = Date.parse('2026-09-20T12:00:00+08:00');
assert(api.knownMarketClosure('2026-07-10')?.source);
assert(api.knownMarketClosure('2026-06-19')?.source);
assert.equal(api.knownMarketClosure('2026-07-09'), null);
assert.equal(api.knownMarketClosure('2027-07-10'), null);
const row = code => ({ SecuritiesCompanyCode: String(code), CompanyAbbreviation: `Company ${code}`, SecuritiesIndustryCode: '24', Date: '1150919' });
const inputs = [{ market: 'twse', rows: Array.from({ length: 1000 }, (_, i) => row(1000 + i)) }, { market: 'tpex', rows: Array.from({ length: 800 }, (_, i) => row(3000 + i)) }];
const build = items => api.buildOfficialRankingUniverse(items, now);
assert.equal(build(inputs).companies.length, 1800);
assert.equal(JSON.stringify(build(inputs).companies), JSON.stringify(build(inputs.map(i => ({ ...i, rows: [...i.rows].reverse() }))).companies));
for (const broken of [inputs.slice(0, 1), inputs.map(i => ({ ...i, rows: [] })), inputs.map(i => ({ ...i, rows: i.rows.slice(0, 200) }))]) assert.throws(() => build(broken));
for (const date of ['', '1150101', '1151001', 'bad']) {
  const broken = structuredClone(inputs); broken[0].rows[0].Date = date;
  assert.throws(() => build(broken));
}
const duplicate = structuredClone(inputs); duplicate[1].rows.push(row(1000)); assert.throws(() => build(duplicate));
const products = structuredClone(inputs);
products[0].rows.push({ ...row(9103), SecuritiesIndustryCode: '91', CompanyAbbreviation: 'Example-DR' }, row('0050'), row('12345'), { ...row(8888), CompanyAbbreviation: 'Example ETF' }, row(9904));
assert.equal(build(products).companies.length, 1801);
assert(build(products).companies.some(item => item.code === '9904'));
assert(!build(products).companies.some(item => item.code === '9103'));
const validJob = { schemaVersion: 'market-features-v7-official-universe', createdAt: '2026-09-19T00:00:00Z' };
api.assertRankingJobResumable(validJob, now);
for (const job of [{ ...validJob, schemaVersion: 'market-features-v6-exact-ranking' }, { ...validJob, createdAt: '2026-09-07T00:00:00Z', updatedAt: new Date(now).toISOString() }, { ...validJob, createdAt: '' }]) assert.throws(() => api.assertRankingJobResumable(job, now));
const records = Array.from({ length: 12 }, (_, i) => ({ i, data: 'x'.repeat(200000) }));
const batches = api.rankingDbWriteBatches(records);
assert.equal(batches.flat().length, records.length);
assert(batches.every(b => Buffer.byteLength(JSON.stringify(b)) <= 900 * 1024));
assert.throws(() => api.rankingDbWriteBatches([{ data: '中'.repeat(90000) }]));
console.log(JSON.stringify({ ok: true, checks: ['official markets required', 'dynamic counts', 'deterministic ordering', 'freshness', 'duplicates', 'DR/fund exclusion', 'job expiry/schema', 'UTF-8 item and request budgets'] }));

// Optional local fixture audit; never performs network requests or starts a job.
if (process.argv[2]) {
  const dir = process.argv[2];
  const actual = await Promise.all(['twse', 'tpex'].map(async market => ({ market, rows: JSON.parse((await readFile(`${dir}/${market}.json`, 'utf8')).replace(/^\uFEFF/, '')) })));
  const universe = api.buildOfficialRankingUniverse(actual);
  const serializedProfiles = universe.companies.map(company => ({ ...company, officialQuote: { close: 100, open: 99, high: 101, low: 98, volume: 1000, source: 'size estimate' } }));
  const report = { checkedAt: new Date().toISOString(), ...universe, fullJobProfilesBytesEstimate: Buffer.byteLength(JSON.stringify(serializedProfiles)), note: 'Profile-only estimate excludes other job fields; does not prove remote storage capacity.' };
  await writeFile(`${dir}/official-universe-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ counts: universe.counts, total: universe.companies.length, sourceDates: universe.sourceDates, fullJobProfilesBytesEstimate: report.fullJobProfilesBytesEstimate }));
}
