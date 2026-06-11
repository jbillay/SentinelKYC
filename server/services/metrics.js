// P1 R7 — in-process metrics registry.
//
// Deliberately tiny: counters + histograms in a Map, exposed as JSON via
// GET /api/metrics (routes/meta.js). No Prometheus/OTel collector — the POC
// bans that infra — but the snapshot shape is Prometheus-ish (name + labels +
// buckets) so a later exporter swap is mechanical.
//
// Queue-mode caveat: metrics are per-process. Graph-node and LLM series
// accumulate in whichever process executes the graph (web in inline mode,
// worker in queue mode). The worker logs a periodic snapshot (worker.js);
// /api/metrics reports the web process only. Cross-process aggregation is
// deliberately deferred.

const LATENCY_BUCKETS_MS = [50, 200, 1000, 5000, 30000, 120000];

const counters = new Map(); // key → { name, labels, value }
const histograms = new Map(); // key → { name, labels, count, sum, min, max, buckets: number[] }

function seriesKey(name, labels) {
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
  return `${name}{${sorted}}`;
}

function inc(name, labels = {}, by = 1) {
  const key = seriesKey(name, labels);
  let c = counters.get(key);
  if (!c) {
    c = { name, labels: { ...labels }, value: 0 };
    counters.set(key, c);
  }
  c.value += by;
}

function observe(name, value, labels = {}) {
  if (!Number.isFinite(value)) return;
  const key = seriesKey(name, labels);
  let h = histograms.get(key);
  if (!h) {
    h = {
      name,
      labels: { ...labels },
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), // le-bucket counts + overflow
    };
    histograms.set(key, h);
  }
  h.count += 1;
  h.sum += value;
  if (value < h.min) h.min = value;
  if (value > h.max) h.max = value;
  let i = LATENCY_BUCKETS_MS.findIndex((b) => value <= b);
  if (i === -1) i = LATENCY_BUCKETS_MS.length;
  h.buckets[i] += 1;
}

function snapshot() {
  return {
    bucketsMs: LATENCY_BUCKETS_MS,
    counters: [...counters.values()].map((c) => ({ ...c, labels: { ...c.labels } })),
    histograms: [...histograms.values()].map((h) => ({
      name: h.name,
      labels: { ...h.labels },
      count: h.count,
      sum: Math.round(h.sum),
      mean: h.count ? Math.round(h.sum / h.count) : 0,
      min: h.count ? h.min : null,
      max: h.count ? h.max : null,
      buckets: [...h.buckets],
    })),
  };
}

// Test hook — smokes can reset between phases.
function resetAll() {
  counters.clear();
  histograms.clear();
}

module.exports = { inc, observe, snapshot, resetAll, LATENCY_BUCKETS_MS };
