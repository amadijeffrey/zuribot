#!/usr/bin/env node
/**
 * Load simulation for GET /api/users/plans
 *
 * Default scenario: 20 concurrent virtual users hammering the endpoint
 * continuously for 5 minutes.
 *
 * Usage:
 *   TOKEN="eyJ..." node loadtest.mjs
 *
 * Env knobs:
 *   URL         target endpoint         (default: https://zuribot.vercel.app/api/users/plans)
 *   TOKEN       bearer token            (required)
 *   CONCURRENCY virtual users           (default: 20)
 *   DURATION    seconds of test         (default: 300)
 *   THINK       ms sleep between calls per user (default: 0 = as fast as possible)
 *   TOTAL       if set, send exactly N requests spread evenly over DURATION
 *               instead of looping flat-out (e.g. TOTAL=20 => 20 calls / 5 min)
 *   TIMEOUT     per-request timeout ms  (default: 15000)
 */

const URL_ = process.env.URL || '';
const TOKEN = process.env.TOKEN || '';
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const DURATION_MS = Number(process.env.DURATION || 300) * 1000;
const THINK_MS = Number(process.env.THINK || 0);
const TOTAL = process.env.TOTAL ? Number(process.env.TOTAL) : null;
const TIMEOUT_MS = Number(process.env.TIMEOUT || 15000);

if (!TOKEN) {
  console.error('Missing TOKEN env var. Run:  TOKEN="eyJ..." node loadtest.mjs');
  process.exit(1);
}

// --- sanity: is the JWT already expired? -----------------------------------
try {
  const payload = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64url'));
  if (payload.exp) {
    const secsLeft = payload.exp - Math.floor(Date.now() / 1000);
    if (secsLeft <= 0) {
      console.error(`Token expired ${Math.abs(secsLeft)}s ago — grab a fresh one.`);
      process.exit(1);
    }
    if (secsLeft * 1000 < DURATION_MS) {
      console.warn(`WARNING: token expires in ${secsLeft}s, before the ${DURATION_MS / 1000}s run ends. Expect 401s near the end.`);
    }
  }
} catch {
  console.warn('Could not decode token payload — continuing anyway.');
}

const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  authorization: `Bearer ${TOKEN}`,
  origin: 'https://www.zuricirclenetwork.com',
  referer: 'https://www.zuricirclenetwork.com/',
  'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'cross-site',
  'user-agent':
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  // NOTE: the original curl had `if-none-match`. It's omitted on purpose so every
  // request returns a full 200 body instead of a cheap 304. Set MATCH=1 to include it.
  ...(process.env.MATCH ? { 'if-none-match': 'W/"794-3cIFiA5+UHUDFRDsGCV2nxZ+pSU"' } : {}),
};

// --- stats -----------------------------------------------------------------
const latencies = [];
const statusCounts = new Map();
const errorCounts = new Map();
let sent = 0;
let bytes = 0;
let stopping = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

async function callOnce() {
  const started = performance.now();
  sent++;
  try {
    const res = await fetch(URL_, {
      method: 'GET',
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    const body = await res.arrayBuffer(); // drain so the socket is reusable
    bytes += body.byteLength;
    latencies.push(performance.now() - started);
    bump(statusCounts, res.status);
    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      if (ra) bump(errorCounts, `429 retry-after:${ra}`);
    }
  } catch (err) {
    latencies.push(performance.now() - started);
    bump(errorCounts, err.name === 'TimeoutError' ? 'timeout' : `${err.name}: ${err.message}`);
  }
}

// --- workers ---------------------------------------------------------------
async function flatOutWorker(deadline) {
  while (!stopping && Date.now() < deadline) {
    await callOnce();
    if (THINK_MS) await sleep(THINK_MS);
  }
}

// TOTAL mode: N requests evenly spaced across DURATION, capped at CONCURRENCY in flight.
async function pacedRun() {
  const gap = DURATION_MS / TOTAL;
  const inFlight = new Set();
  for (let i = 0; i < TOTAL && !stopping; i++) {
    while (inFlight.size >= CONCURRENCY) await Promise.race(inFlight);
    const p = callOnce().finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (i < TOTAL - 1) await sleep(gap);
  }
  await Promise.allSettled(inFlight);
}

// --- reporting -------------------------------------------------------------
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}
const ms = (n) => `${n.toFixed(0)}ms`;

function report(elapsedMs) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const done = sorted.length;
  const secs = elapsedMs / 1000;
  const ok = [...statusCounts.entries()]
    .filter(([s]) => s >= 200 && s < 400)
    .reduce((a, [, c]) => a + c, 0);

  console.log('\n' + '='.repeat(52));
  console.log(`Target        ${URL_}`);
  console.log(`Mode          ${TOTAL ? `${TOTAL} reqs paced over ${secs.toFixed(0)}s` : `${CONCURRENCY} concurrent users, flat out`}`);
  console.log(`Duration      ${secs.toFixed(1)}s`);
  console.log(`Requests      ${done} (${(done / secs).toFixed(2)} req/s)`);
  console.log(`Success       ${ok} (${done ? ((ok / done) * 100).toFixed(1) : 0}%)`);
  console.log(`Downloaded    ${(bytes / 1024).toFixed(1)} KB`);
  console.log('-'.repeat(52));
  console.log('Latency');
  console.log(`  min ${ms(sorted[0] || 0)}   p50 ${ms(pct(sorted, 50))}   p90 ${ms(pct(sorted, 90))}`);
  console.log(`  p95 ${ms(pct(sorted, 95))}   p99 ${ms(pct(sorted, 99))}   max ${ms(sorted[done - 1] || 0)}`);
  console.log(`  avg ${ms(done ? sorted.reduce((a, b) => a + b, 0) / done : 0)}`);
  console.log('-'.repeat(52));
  console.log('Status codes');
  [...statusCounts.entries()].sort((a, b) => a[0] - b[0]).forEach(([s, c]) =>
    console.log(`  ${s}  ${c}`)
  );
  if (errorCounts.size) {
    console.log('Errors');
    [...errorCounts.entries()].forEach(([e, c]) => console.log(`  ${c}x  ${e}`));
  }
  console.log('='.repeat(52));
}

// --- run -------------------------------------------------------------------
const startedAt = Date.now();
const deadline = startedAt + DURATION_MS;

process.on('SIGINT', () => {
  console.log('\nStopping…');
  stopping = true;
});

const ticker = setInterval(() => {
  const el = (Date.now() - startedAt) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  process.stdout.write(
    `[${el.toFixed(0).padStart(3)}s] sent=${sent} done=${sorted.length} ` +
      `rps=${(sorted.length / el).toFixed(1)} p95=${ms(pct(sorted, 95))} ` +
      `errs=${[...errorCounts.values()].reduce((a, b) => a + b, 0)}\n`
  );
}, 10_000);

console.log(
  TOTAL
    ? `Sending ${TOTAL} requests over ${DURATION_MS / 1000}s (max ${CONCURRENCY} in flight)…`
    : `Running ${CONCURRENCY} concurrent users for ${DURATION_MS / 1000}s…`
);

try {
  if (TOTAL) {
    await pacedRun();
  } else {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => flatOutWorker(deadline))
    );
  }
} finally {
  clearInterval(ticker);
  report(Date.now() - startedAt);
}