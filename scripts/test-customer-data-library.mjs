import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../backend/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('const CUSTOMER_DATASETS:');
const end = source.indexOf('function finMindErrorCode(', start);
assert(start >= 0 && end > start, 'Customer data production functions were not found');

const upstreamRows = Array.from({ length: 1105 }, (_, index) => ({
  date: new Date(Date.UTC(2023, 0, 1 + index)).toISOString().slice(0, 10),
  stock_id: '2330',
  close: index + 1,
  open: index,
  formula_like: index === 1090 ? '=2+2' : '',
}));
const requests = [];
const context = {
  FinMindError: class FinMindError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  requestFinMindDataset: async (dataset, code, timeoutMs, metrics, options) => {
    requests.push({ dataset, code, timeoutMs, options });
    return {
      dataset,
      data: upstreamRows,
      fetchedAt: '2026-09-21T00:00:00.000Z',
      cached: true,
      cacheSource: 'persistent',
      stale: false,
      persisted: true,
    };
  },
  finMindStartDate: dataset => dataset === 'TaiwanStockPrice' ? '2025-08-17' : '2024-03-05',
  FINMIND_SOURCE_URL: 'https://finmind.github.io/',
};
const program = stripTypeScriptTypes(source.slice(start, end))
  + '\n({ CUSTOMER_DATASETS, strictIsoDate, customerDatasetColumns, loadCustomerDataset });';
const api = runInNewContext(program, context);

assert.deepEqual(Array.from(Object.keys(api.CUSTOMER_DATASETS)), [
  'price', 'revenue', 'financials', 'balance', 'cashflow', 'valuation',
]);
assert.equal(api.strictIsoDate('2026-02-29'), '');
assert.equal(api.strictIsoDate('2024-02-29'), '2024-02-29');

const result = await api.loadCustomerDataset('2330', 'price', '2026-01-01', '2026-12-31');
assert.equal(result.ok, true);
assert.equal(result.code, '2330');
assert.equal(result.dataset, 'TaiwanStockPrice');
assert.equal(result.cache.source, 'persistent');
assert.equal(result.cache.stale, false);
assert.equal(result.cache.persisted, true);
assert(result.rows.every(row => row.date >= '2026-01-01' && row.date <= '2026-12-31'));
assert(result.rows.length <= 1000);
assert.deepEqual(Array.from(result.columns.slice(0, 4)), ['date', 'stock_id', 'open', 'close']);
assert.equal(result.latestDataDate, result.rows.at(-1)?.date || null);
await api.loadCustomerDataset('2330', 'price', '2020-01-01', '2020-12-31');
assert.deepEqual({ ...requests.at(-1).options }, { startDate:'2020-01-01', endDate:'2020-12-31', persist:false });
await assert.rejects(() => api.loadCustomerDataset('2330', 'unknown', '2026-01-01', '2026-12-31'));

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert(html.includes('/api/data-library?code='));
assert(html.includes('customerDataDownloadBtn'));
assert(html.includes('/^[=+\\-@\\t\\r]/'));
assert(!html.includes('FINMIND_TOKEN'));

console.log(JSON.stringify({
  ok: true,
  datasets: Object.keys(api.CUSTOMER_DATASETS),
  rows: result.rows.length,
  cacheSource: result.cache.source,
  scope: 'production customer data filtering, metadata, bounded response, and frontend CSV guard',
}));
