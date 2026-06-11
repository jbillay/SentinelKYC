#!/usr/bin/env node
// Eval harness runner (R3). Iterates the golden corpus, calls the EXACT
// production code paths (extractStructured with the real extractor schema/prompt;
// the factored screening evaluators), scores against the golden labels, and
// emits a JSON report + a human summary.
//
// Usage:
//   node eval/run.js                         # all types, active prompts
//   node eval/run.js --type sanctions        # one type
//   node eval/run.js --prompt screening.evaluate_sanctions_hit=42
//                                            # A/B: score version 42 vs the active baseline (per-metric delta)
//   node eval/run.js --json out/report.json  # also write the JSON report
//   node eval/run.js --golden /path/to/dir   # alternative corpus root
//
// Offline by design: extraction reads frozen OCR/text fixtures, sanctions +
// adverse-media read frozen entries/articles. Only the reasoning LLM is called.
// It is therefore reproducible and free apart from local LLM time.

const fs = require('fs');
const path = require('path');

const { extractStructured } = require('../services/llm');
const { getExtractor } = require('../graph/extractors');
const { loadPrompt, loadPromptVersion } = require('../services/prompts');
const {
  evaluateSanctionsHit,
} = require('../services/screening/evaluateSanctionsHit');
const {
  evaluateAdverseMediaHit,
} = require('../services/screening/evaluateAdverseMediaHit');
const { validateCase, CASE_TYPES } = require('./labels.schema');
const score = require('./score');

const GOLDEN_ROOT = path.join(__dirname, 'golden');

// Which registry prompt key drives each case type / extraction category. The
// A/B override and the baseline both resolve through this map.
const CATEGORY_PROMPT_KEY = {
  'confirmation-statement': 'extract.confirmation_statement',
  accounts: 'extract.accounts',
  incorporation: 'extract.incorporation',
};
const SANCTIONS_PROMPT_KEY = 'screening.evaluate_sanctions_hit';
const ADVERSE_MEDIA_PROMPT_KEY = 'screening.evaluate_adverse_media';

function parseArgs(argv) {
  const opts = { types: null, overrides: {}, json: null, golden: GOLDEN_ROOT, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--type') {
      const v = argv[++i];
      opts.types = (opts.types || []).concat(v.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a === '--prompt') {
      const v = argv[++i] || '';
      const eq = v.indexOf('=');
      if (eq < 0) throw new Error(`--prompt expects key=versionId, got "${v}"`);
      const key = v.slice(0, eq).trim();
      const id = v.slice(eq + 1).trim();
      opts.overrides[key] = id;
    } else if (a === '--json') {
      opts.json = argv[++i];
    } else if (a === '--golden') {
      opts.golden = argv[++i];
    } else if (a === '--quiet') {
      opts.quiet = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (opts.types) {
    for (const t of opts.types) {
      if (!CASE_TYPES.includes(t)) throw new Error(`Unknown --type ${t} (one of ${CASE_TYPES.join(', ')})`);
    }
  }
  return opts;
}

// dir name on disk per type
const TYPE_DIR = { extraction: 'extraction', sanctions: 'sanctions', adverse_media: 'adverse_media' };

function loadGoldenCases(root, types) {
  const wanted = types && types.length ? types : CASE_TYPES;
  const cases = [];
  for (const type of wanted) {
    const dir = path.join(root, TYPE_DIR[type]);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const full = path.join(dir, f);
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (err) {
        throw new Error(`Failed to parse golden case ${full}: ${err.message}`);
      }
      const parsed = validateCase(raw); // throws on malformed
      parsed.__file = full;
      cases.push(parsed);
    }
  }
  return cases;
}

function readInputText(c) {
  if (c.inputText != null) return c.inputText;
  const p = path.isAbsolute(c.inputTextFile)
    ? c.inputTextFile
    : path.join(path.dirname(c.__file), c.inputTextFile);
  return fs.readFileSync(p, 'utf8');
}

// A prompt resolver closes over the override map: active baseline unless an
// override version is set for that key.
function makeResolver(overrides) {
  const cache = new Map();
  return async function resolve(key) {
    if (cache.has(key)) return cache.get(key);
    const body =
      overrides[key] != null ? await loadPromptVersion(key, overrides[key]) : await loadPrompt(key);
    cache.set(key, body);
    return body;
  };
}

// Produce the model's prediction for one case via the production code path.
async function produce(c, resolve) {
  if (c.type === 'extraction') {
    const extractor = getExtractor(c.category);
    if (!extractor) throw new Error(`No extractor for category ${c.category}`);
    const promptKey = CATEGORY_PROMPT_KEY[c.category];
    const prompt = await resolve(promptKey);
    const text = readInputText(c);
    return extractStructured(text, extractor.schema, prompt);
  }
  if (c.type === 'sanctions') {
    const prompt = await resolve(SANCTIONS_PROMPT_KEY);
    return evaluateSanctionsHit(c.subject, c.hit, { prompt });
  }
  if (c.type === 'adverse_media') {
    const prompt = await resolve(ADVERSE_MEDIA_PROMPT_KEY);
    return evaluateAdverseMediaHit(c.subject, c.hit, { prompt });
  }
  throw new Error(`produce: unknown case type ${c.type}`);
}

// Run one pass (one resolver) over the cases; returns per-type results.
async function runPass(cases, resolve, { onProgress } = {}) {
  const byType = {};
  for (const type of CASE_TYPES) byType[type] = { perCase: [], failures: [] };

  for (const c of cases) {
    let predicted;
    try {
      predicted = await produce(c, resolve);
    } catch (err) {
      byType[c.type].failures.push({ id: c.id, error: err.message });
      if (onProgress) onProgress(c, { error: err.message });
      continue;
    }
    const metrics = score.scoreCase(c.type, c, predicted);
    byType[c.type].perCase.push({ id: c.id, metrics, predicted });
    if (onProgress) onProgress(c, { metrics });
  }

  const result = {};
  for (const type of CASE_TYPES) {
    const bucket = byType[type];
    if (!bucket.perCase.length && !bucket.failures.length) continue;
    result[type] = {
      caseCount: bucket.perCase.length + bucket.failures.length,
      failures: bucket.failures,
      aggregate: bucket.perCase.length ? score.aggregate(type, bucket.perCase) : null,
      cases: bucket.perCase.map((p) => ({ id: p.id, metrics: p.metrics })),
    };
  }
  return result;
}

// Compute baseline→candidate deltas on the headline metrics per type.
const HEADLINE_METRICS = {
  extraction: ['recordPrecision', 'recordRecall', 'recordF1', 'fieldAccuracy', 'exactRecordMatchRate', 'scalarAccuracy'],
  sanctions: ['accuracy'],
  adverse_media: ['decisionAccuracy', 'categoryAccuracy', 'categoryMacroF1', 'severityAccuracy'],
};

function diffMetric(a, b) {
  if (a == null || b == null) return null;
  return score.round(b - a);
}

function computeDeltas(baseline, candidate) {
  const out = {};
  for (const type of CASE_TYPES) {
    const ba = baseline[type] && baseline[type].aggregate;
    const ca = candidate[type] && candidate[type].aggregate;
    if (!ba || !ca) continue;
    out[type] = {};
    for (const m of HEADLINE_METRICS[type]) {
      out[type][m] = { baseline: ba[m] ?? null, candidate: ca[m] ?? null, delta: diffMetric(ba[m], ca[m]) };
    }
  }
  return out;
}

async function runHarness(opts = {}) {
  const overrides = opts.overrides || {};
  const cases = loadGoldenCases(opts.golden || GOLDEN_ROOT, opts.types);
  const abMode = Object.keys(overrides).length > 0;

  const baseline = await runPass(cases, makeResolver({}), { onProgress: opts.onProgress });
  const report = {
    generatedAt: new Date().toISOString(),
    caseCount: cases.length,
    types: opts.types || CASE_TYPES,
    mode: abMode ? 'ab' : 'baseline',
    baseline,
  };
  if (abMode) {
    report.overrides = overrides;
    report.candidate = await runPass(cases, makeResolver(overrides), { onProgress: opts.onProgress });
    report.deltas = computeDeltas(baseline, report.candidate);
  }
  return report;
}

// --- human-readable summary ----------------------------------------------

function fmt(n) {
  return n == null ? '   —' : n.toFixed(4);
}

function printAggregate(label, type, agg, failures) {
  if (!agg) {
    console.log(`  ${label}: no scored cases${failures && failures.length ? ` (${failures.length} failed)` : ''}`);
    return;
  }
  if (type === 'extraction') {
    console.log(`  ${label}: cases=${agg.caseCount} record P/R/F1=${fmt(agg.recordPrecision)}/${fmt(agg.recordRecall)}/${fmt(agg.recordF1)} field=${fmt(agg.fieldAccuracy)} exact=${fmt(agg.exactRecordMatchRate)} scalar=${fmt(agg.scalarAccuracy)}`);
  } else if (type === 'sanctions') {
    const c = agg.confirmed;
    console.log(`  ${label}: scored=${agg.scored} accuracy=${fmt(agg.accuracy)} confirmed P/R/F1=${fmt(c.precision)}/${fmt(c.recall)}/${fmt(c.f1)} (tp=${c.tp} fp=${c.fp} fn=${c.fn})`);
  } else if (type === 'adverse_media') {
    console.log(`  ${label}: cases=${agg.caseCount} decision=${fmt(agg.decisionAccuracy)} category=${fmt(agg.categoryAccuracy)} catF1=${fmt(agg.categoryMacroF1)} severity=${fmt(agg.severityAccuracy)}`);
  }
  if (failures && failures.length) {
    console.log(`     failures: ${failures.map((f) => `${f.id} (${f.error})`).join('; ')}`);
  }
}

function printSummary(report) {
  console.log('');
  console.log(`Eval report — ${report.generatedAt} — mode=${report.mode} — ${report.caseCount} case(s)`);
  console.log('='.repeat(72));
  for (const type of report.types) {
    const b = report.baseline[type];
    if (!b) continue;
    console.log(`\n[${type}]`);
    printAggregate(report.mode === 'ab' ? 'baseline' : 'active', type, b.aggregate, b.failures);
    if (report.mode === 'ab' && report.candidate[type]) {
      printAggregate('candidate', type, report.candidate[type].aggregate, report.candidate[type].failures);
    }
  }
  if (report.mode === 'ab') {
    console.log('\nDeltas (candidate − baseline):');
    for (const type of Object.keys(report.deltas)) {
      const ds = report.deltas[type];
      const parts = Object.entries(ds)
        .filter(([, v]) => v.delta != null)
        .map(([m, v]) => `${m} ${v.delta >= 0 ? '+' : ''}${v.delta}`);
      console.log(`  [${type}] ${parts.length ? parts.join('  ') : '(no comparable metrics)'}`);
    }
    console.log(`\nOverrides: ${Object.entries(report.overrides).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log('');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[eval] ${err.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log('Usage: node eval/run.js [--type t1,t2] [--prompt key=versionId] [--json out.json] [--golden dir] [--quiet]');
    process.exit(0);
  }

  console.log('[eval] loading golden corpus…');
  const report = await runHarness({
    ...opts,
    onProgress: opts.quiet
      ? undefined
      : (c, res) => {
          if (res.error) console.log(`  · ${c.type}/${c.id} → ERROR ${res.error}`);
          else console.log(`  · ${c.type}/${c.id} → ok`);
        },
  });

  printSummary(report);

  if (opts.json) {
    const outPath = path.isAbsolute(opts.json) ? opts.json : path.join(process.cwd(), opts.json);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`[eval] report written to ${outPath}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[eval] fatal:', err);
    process.exit(1);
  });
}

module.exports = {
  runHarness,
  runPass,
  loadGoldenCases,
  makeResolver,
  produce,
  computeDeltas,
  CATEGORY_PROMPT_KEY,
  SANCTIONS_PROMPT_KEY,
  ADVERSE_MEDIA_PROMPT_KEY,
};
