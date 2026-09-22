import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ID = '932f5348aea14e86a7';
const APP_NAME = 'Taiwan Stock Analysis Agent';
const APP_TYPE = 'frontend+backend';
const APP_DESCRIPTION = 'Taiwan stock analysis with evidence-gated macro risk scanning';
const FRONTEND_URL = 'https://932f5348aea14e86a7.v2.appdeploy.ai/';
const API_PROBE_URL = 'https://api-v2.appdeploy.ai/app/932f5348aea14e86a7/api/macro-risk-scan';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const FORBIDDEN_FILE_PATTERN = /(^|[\\/])(\.appdeploy|\.env(?:\..*)?|secrets?\.[^\\/]+)$/i;
const TERMINAL_STATUSES = new Set(['ready', 'failed', 'deleted']);

function parseArgs(argv) {
  const options = { mode: 'dry-run', files: [], maxRuntimeMinutes: 15, confirmChangedFiles: false };
  for (const argument of argv) {
    if (argument.startsWith('--mode=')) options.mode = argument.slice('--mode='.length);
    else if (argument.startsWith('--file=')) options.files.push(argument.slice('--file='.length));
    else if (argument.startsWith('--max-runtime-minutes=')) options.maxRuntimeMinutes = Number(argument.slice('--max-runtime-minutes='.length));
    else if (argument === '--confirm-changed-files') options.confirmChangedFiles = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!['dry-run', 'transport-test', 'deploy'].includes(options.mode)) throw new Error(`Unsupported mode: ${options.mode}`);
  if (!Number.isFinite(options.maxRuntimeMinutes) || options.maxRuntimeMinutes < 1 || options.maxRuntimeMinutes > 30) {
    throw new Error('--max-runtime-minutes must be between 1 and 30');
  }
  if (options.files.length === 0) throw new Error('At least one --file argument is required');
  if (options.mode === 'deploy' && !options.confirmChangedFiles) {
    throw new Error('Deploy mode requires --confirm-changed-files; unchanged files must not be resent');
  }
  return options;
}

function memoryMb() {
  const usage = process.memoryUsage();
  return { rssMb: Math.round(usage.rss / 1024 / 1024), heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024) };
}

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...details, memory: memoryMb() })}\n`);
}

function limitedText(value, limit = 1000) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]` : text;
}

function parseJsonRpcEnvelope(raw) {
  const dataLines = raw.split(/\r?\n/).filter(line => line.startsWith('data:'));
  const candidate = dataLines.length > 0 ? dataLines.at(-1).slice('data:'.length).trim() : raw.trim();
  return JSON.parse(candidate);
}

function parseToolPayload(envelope) {
  if (envelope.error) throw new Error(`AppDeploy JSON-RPC error: ${limitedText(JSON.stringify(envelope.error))}`);
  const textBlock = envelope.result?.content?.find(block => block?.type === 'text');
  if (!textBlock?.text) return envelope.result ?? null;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return { text: textBlock.text };
  }
}

async function readConfig() {
  const configPath = path.join(PROJECT_ROOT, '.appdeploy');
  const configText = (await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '');
  const config = JSON.parse(configText);
  if (!config.api_key || !config.endpoint) throw new Error('.appdeploy must contain api_key and endpoint');
  return config;
}

function timeoutFor(deadline, capMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Overall deployment deadline exceeded');
  return Math.max(1, Math.min(capMs, remaining));
}

async function fetchText(url, options, deadline, capMs) {
  const timeoutMs = timeoutFor(deadline, capMs);
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  return { response, text };
}

async function rpc(config, name, argumentsValue, deadline, capMs = 30_000) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method: 'tools/call',
    params: { name, arguments: argumentsValue },
  });
  const { response, text } = await fetchText(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.api_key}`,
    },
    body,
  }, deadline, capMs);
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${limitedText(text)}`);
  return parseToolPayload(parseJsonRpcEnvelope(text));
}

async function loadFiles(relativePaths) {
  const files = [];
  const projectPrefix = `${PROJECT_ROOT}${path.sep}`.toLowerCase();
  for (const relativePath of relativePaths) {
    const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
    const absolutePath = path.resolve(PROJECT_ROOT, normalized);
    if (!absolutePath.toLowerCase().startsWith(projectPrefix)) throw new Error(`File escapes project root: ${relativePath}`);
    if (FORBIDDEN_FILE_PATTERN.test(normalized)) throw new Error(`Refusing to deploy protected file: ${relativePath}`);
    const content = await readFile(absolutePath, 'utf8');
    files.push({
      filename: normalized,
      content,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return files;
}

async function inspectRemote(config, deadline) {
  const instructions = await rpc(config, 'get_deploy_instructions', {}, deadline);
  if (instructions.message !== 'Deploy instructions ready.') {
    throw new Error(`AppDeploy preflight blocked (${instructions.code || 'instructions_unavailable'}): ${instructions.message || 'Deployment instructions were not returned'}`);
  }
  const apps = await rpc(config, 'get_apps', {}, deadline);
  const target = apps.apps?.find(app => app.data?.app_id === APP_ID);
  if (!target) throw new Error(`AppDeploy app ${APP_ID} was not found`);
  const source = await rpc(config, 'src_grep', {
    app_id: APP_ID,
    path: 'backend/index.ts',
    pattern: 'MACRO_RISK_SCAN_VERSION|macro-risk-scan-v2',
    output_mode: 'content',
    line_numbers: true,
    context: 1,
  }, deadline);
  if (!source.matches?.some(match => String(match.text).includes('macro-risk-scan-v2'))) {
    throw new Error('Remote source inspection did not find macro-risk-scan-v2');
  }
  log('remote_inspected', { appStatus: target.display?.status, remoteMarker: 'macro-risk-scan-v2' });
}

async function createUpload(config, files, deadline) {
  const slot = await rpc(config, 'upload_assets', {}, deadline);
  if (!slot.upload_url || !slot.upload_id) throw new Error('upload_assets did not return upload_url and upload_id');
  const manifest = JSON.stringify({
    files: files.map(file => ({ filename: file.filename, content: file.content })),
    deletePaths: [],
  });
  const form = new FormData();
  form.append('payload', new Blob([manifest], { type: 'application/json' }), 'manifest.json');
  log('upload_started', { fileCount: files.length, manifestBytes: Buffer.byteLength(manifest) });
  const { response, text } = await fetchText(slot.upload_url, { method: 'PUT', body: form }, deadline, 180_000);
  if (!response.ok) throw new Error(`Asset upload HTTP ${response.status}: ${limitedText(text)}`);
  log('upload_completed', { status: response.status, responseBytes: Buffer.byteLength(text) });
  return slot.upload_id;
}

function statusSummary(payload) {
  return {
    status: payload.deployment?.status ?? 'unknown',
    e2e: payload.e2e_tests?.status ?? null,
    passedJobs: payload.e2e_tests?.passed_jobs ?? null,
    totalJobs: payload.e2e_tests?.total_jobs ?? null,
    frontendErrors: payload.errors?.frontend?.length ?? 0,
    backendErrors: payload.errors?.backend?.length ?? 0,
    qaFrontendErrors: payload.qa_snapshot?.frontend_errors?.length ?? 0,
    qaNetworkErrors: payload.qa_snapshot?.network_errors?.length ?? 0,
  };
}

async function deploy(config, uploadId, deadline) {
  const accepted = await rpc(config, 'deploy_app', {
    app_id: APP_ID,
    app_type: APP_TYPE,
    app_name: APP_NAME,
    description: APP_DESCRIPTION,
    features: ['api', 'database', 'secrets', 'cron'],
    model: 'gpt-6',
    intent: 'Use bounded-memory deployment worker with explicit timeouts and terminal status verification',
    initiator: 'user',
    type: 'chore',
    upload_id: uploadId,
  }, deadline, 180_000);
  log('deploy_accepted', { message: limitedText(accepted.message, 300) });

  while (true) {
    const status = await rpc(config, 'get_app_status', { app_id: APP_ID }, deadline);
    const summary = statusSummary(status);
    log('deploy_status', summary);
    if (TERMINAL_STATUSES.has(summary.status)) {
      if (summary.status !== 'ready') throw new Error(`Deployment ended with status ${summary.status}`);
      if (summary.e2e !== 'passed') throw new Error(`Deployment is ready but E2E status is ${summary.e2e ?? 'missing'}`);
      if (summary.frontendErrors || summary.backendErrors || summary.qaFrontendErrors || summary.qaNetworkErrors) {
        throw new Error(`Deployment is ready but error arrays are not empty: ${JSON.stringify(summary)}`);
      }
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
}

async function probeLive(deadline) {
  const cacheBust = Date.now();
  const frontend = await fetchText(`${FRONTEND_URL}?deploy-check=${cacheBust}`, {
    headers: { 'cache-control': 'no-cache' },
  }, deadline, 30_000);
  const api = await fetchText(`${API_PROBE_URL}?deploy-check=${cacheBust}`, {
    headers: { 'cache-control': 'no-cache' },
  }, deadline, 60_000);
  const apiPayload = JSON.parse(api.text);
  if (!frontend.response.ok || !frontend.text.includes('workspaceTabRisk')) throw new Error('Live frontend probe failed');
  if (!api.response.ok || apiPayload.version !== 'macro-risk-scan-v2') throw new Error('Live API probe failed');
  log('live_probe_passed', { frontendStatus: frontend.response.status, apiStatus: api.response.status, apiVersion: apiPayload.version });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + options.maxRuntimeMinutes * 60_000;
  log('worker_started', { mode: options.mode, maxRuntimeMinutes: options.maxRuntimeMinutes, pid: process.pid });
  const config = await readConfig();
  const files = await loadFiles(options.files);
  log('files_loaded', {
    files: files.map(({ filename, bytes, sha256 }) => ({ filename, bytes, sha256 })),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  });
  await inspectRemote(config, deadline);
  if (options.mode === 'dry-run') {
    log('dry_run_completed', { externalWrite: false });
    return;
  }
  const uploadId = await createUpload(config, files, deadline);
  if (options.mode === 'transport-test') {
    log('transport_test_completed', { deployed: false });
    return;
  }
  await deploy(config, uploadId, deadline);
  await probeLive(deadline);
  log('deployment_completed', { status: 'ready' });
}

main().then(
  () => process.stdout.write('', () => process.exit(0)),
  error => {
    log('worker_failed', { message: limitedText(error?.stack || error?.message || error, 4000) });
    process.stdout.write('', () => process.exit(1));
  },
);
