#!/usr/bin/env node

const API_BASE = "https://api-v2.appdeploy.ai/app/932f5348aea14e86a7";
const PILOT_SIZE = 250;
const MAX_RUNTIME_MS = 90 * 60 * 1000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, method = "GET", body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}: ${payload.message || text.slice(0, 200)}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function summary(job) {
  const result = job.result || {};
  const pilotByMode = result.pilotByMode || {};
  return {
    ok: job.status === "completed",
    jobId: job.jobId,
    status: job.status,
    scope: job.scope,
    pilot: job.pilot,
    progress: job.progress,
    message: job.message,
    universeMeta: result.universeMeta || null,
    performance: job.performance || null,
    modes: Object.fromEntries(Object.entries(pilotByMode).map(([mode, value]) => [mode, {
      displayed: value?.items?.length || 0,
      evidenceGate: value?.evidenceGate || null,
    }])),
    snapshotStatus: result.snapshotStatus || null,
    publicActivation: result.batch?.publishedModes || [],
  };
}

async function main() {
  assert(process.argv.includes("--execute"), "Safety stop: pass --execute to create and run the remote 250-stock pilot.");
  const startedAt = Date.now();
  let job = await request("/api/screener/refresh", "POST", { mode: "undervalued", pilotSize: PILOT_SIZE });
  assert(job?.pilot?.enabled && job.pilot.size === PILOT_SIZE, `Remote endpoint did not create a ${PILOT_SIZE}-stock pilot; refusing to continue.`);
  assert(job.scope === `twse-tpex-pilot-${PILOT_SIZE}`, `Unexpected remote scope ${job.scope}; refusing to continue.`);
  let lastMarker = "";
  let stagnant = 0;
  while (!job.done) {
    if (Date.now() - startedAt > MAX_RUNTIME_MS) throw new Error("Remote pilot exceeded the 90-minute safety limit; progress remains persisted.");
    const marker = `${job.phase}|${job.progress?.processed}|${job.progress?.scored}|${job.status}`;
    stagnant = marker === lastMarker ? stagnant + 1 : 0;
    lastMarker = marker;
    if (stagnant >= 12) throw new Error(`Remote pilot made no progress for 12 advance cycles: ${job.message || marker}`);
    process.stderr.write(`[pilot] ${job.phase || "unknown"} ${job.progress?.processed || 0}/${job.progress?.total || 0} scored=${job.progress?.scored || 0} failed=${job.progress?.failed || 0}\n`);
    job = await request(`/api/screener/refresh/jobs/${encodeURIComponent(job.jobId)}/advance`, "POST");
    if (!job.done) await new Promise(resolve => setTimeout(resolve, Math.max(300, Number(job.pollAfterMs || 700))));
  }
  const final = summary(job);
  assert(final.pilot?.enabled && final.pilot.size === PILOT_SIZE, "Completed job lost its pilot-only label.");
  assert(final.snapshotStatus !== "complete", "Pilot incorrectly returned a formal complete snapshot status.");
  assert(final.publicActivation.length === 0, "Pilot incorrectly activated one or more public ranking snapshots.");
  process.stdout.write(`${JSON.stringify(final, null, 2)}\n`);
  if (job.status !== "completed") process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
