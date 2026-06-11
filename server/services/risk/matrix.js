// Risk matrix registry — versioned, append-only, singleton-active.
// Mirrors services/prompts.js. Postgres is the source of truth; this module
// is the single read path with an in-process cache for the active matrix.

// db/repo is required lazily inside the DB-touching functions so the pure
// half of this module (validateMatrix etc.) stays importable without a
// DATABASE_URL — db/client.js throws at require-time when it is unset.
const DEFAULT_MATRIX = require('./defaults/matrix.json');

const KNOWN_KNOCKOUT_TAGS = ['screeningProhibited', 'screeningHighOverride', 'screeningMediumFloor'];
const REQUIRED_WEIGHT_KEYS = ['geographic', 'entityType', 'structuralComplexity', 'industry'];

let activeCache = null; // { versionId, version, body, notes, updatedAt }

function defaultMatrixBody() {
  return JSON.parse(JSON.stringify(DEFAULT_MATRIX));
}

// Returns an array of human-readable error strings. Empty array = valid.
function validateMatrix(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['matrix body must be a JSON object'];
  }

  const isScore = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

  // --- weights -------------------------------------------------------------
  const w = body.weights;
  if (!w || typeof w !== 'object' || Array.isArray(w)) {
    errors.push('missing weights object');
  } else {
    for (const k of REQUIRED_WEIGHT_KEYS) {
      if (typeof w[k] !== 'number' || !Number.isFinite(w[k])) errors.push(`weights.${k} must be a number`);
      else if (w[k] < 0 || w[k] > 1) errors.push(`weights.${k} must be in [0,1] (got ${w[k]})`);
    }
    const sum = REQUIRED_WEIGHT_KEYS.reduce((a, k) => a + (typeof w[k] === 'number' ? w[k] : 0), 0);
    if (Math.abs(sum - 1) > 0.001) errors.push(`weights_sum must be 1.0 ±0.001 (got ${sum})`);
  }

  // --- factors -------------------------------------------------------------
  const f = body.factors || {};

  // geographic
  const geo = f.geographic;
  if (!geo || typeof geo !== 'object') {
    errors.push('missing factors.geographic');
  } else {
    if (!isScore(geo.default)) errors.push('factors.geographic.default must be a score 0-100');
    if (!geo.scores || typeof geo.scores !== 'object' || Array.isArray(geo.scores)) {
      errors.push('factors.geographic.scores must be an object');
    } else {
      for (const [iso, v] of Object.entries(geo.scores)) {
        if (!isScore(v)) errors.push(`factors.geographic.scores.${iso} must be a score 0-100`);
      }
    }
  }

  // entityType
  const et = f.entityType;
  if (!et || typeof et !== 'object') {
    errors.push('missing factors.entityType');
  } else {
    if (!isScore(et.default)) errors.push('factors.entityType.default must be a score 0-100');
    if (!et.scores || typeof et.scores !== 'object' || Array.isArray(et.scores)) {
      errors.push('factors.entityType.scores must be an object');
    } else {
      for (const [k, v] of Object.entries(et.scores)) {
        if (!isScore(v)) errors.push(`factors.entityType.scores.${k} must be a score 0-100`);
      }
    }
  }

  // structuralComplexity
  const sc = f.structuralComplexity;
  if (!sc || typeof sc !== 'object') {
    errors.push('missing factors.structuralComplexity');
  } else {
    if (sc.combineRule !== 'max') errors.push("factors.structuralComplexity.combineRule must be 'max'");
    for (const sub of ['corporatePscCount', 'shareholderLayers']) {
      const s = sc[sub];
      if (!s || !Array.isArray(s.tiers) || s.tiers.length === 0) {
        errors.push(`factors.structuralComplexity.${sub}.tiers must be a non-empty array`);
        continue;
      }
      let prevUpTo = -Infinity;
      for (let i = 0; i < s.tiers.length; i++) {
        const t = s.tiers[i] || {};
        if (!isScore(t.score)) errors.push(`factors.structuralComplexity.${sub}.tiers[${i}].score must be a score 0-100`);
        const isOpen = t.upTo === null || t.upTo === undefined;
        if (isOpen) {
          if (i !== s.tiers.length - 1) errors.push(`factors.structuralComplexity.${sub}: open-ended tier (upTo:null) must be last`);
        } else if (typeof t.upTo !== 'number' || !Number.isFinite(t.upTo)) {
          errors.push(`factors.structuralComplexity.${sub}.tiers[${i}].upTo must be a number or null`);
        } else if (t.upTo <= prevUpTo) {
          errors.push(`factors.structuralComplexity.${sub}.tiers must have strictly ascending upTo`);
        } else {
          prevUpTo = t.upTo;
        }
      }
      const last = s.tiers[s.tiers.length - 1] || {};
      if (last.upTo !== null && last.upTo !== undefined) {
        errors.push(`factors.structuralComplexity.${sub}: last tier must be open-ended (upTo:null)`);
      }
    }
  }

  // industry
  const ind = f.industry;
  if (!ind || typeof ind !== 'object') {
    errors.push('missing factors.industry');
  } else {
    if (ind.combineRule !== 'max') errors.push("factors.industry.combineRule must be 'max'");
    if (!isScore(ind.default)) errors.push('factors.industry.default must be a score 0-100');
    if (!Array.isArray(ind.prefixes)) {
      errors.push('factors.industry.prefixes must be an array');
    } else {
      for (let i = 0; i < ind.prefixes.length; i++) {
        const p = ind.prefixes[i] || {};
        if (typeof p.prefix !== 'string' || p.prefix.length === 0) errors.push(`factors.industry.prefixes[${i}].prefix must be a non-empty string`);
        if (!isScore(p.score)) errors.push(`factors.industry.prefixes[${i}].score must be a score 0-100`);
      }
    }
  }

  // --- thresholds ----------------------------------------------------------
  const th = body.thresholds;
  if (!Array.isArray(th) || th.length === 0) {
    errors.push('thresholds must be a non-empty array');
  } else {
    let prevMax = -Infinity;
    let structureOk = true;
    for (let i = 0; i < th.length; i++) {
      const t = th[i] || {};
      if (typeof t.tier !== 'string' || t.tier.length === 0) errors.push(`thresholds[${i}].tier must be a non-empty string`);
      if (typeof t.min !== 'number' || typeof t.max !== 'number' || !Number.isFinite(t.min) || !Number.isFinite(t.max)) {
        errors.push(`thresholds[${i}] must have numeric min and max`);
        structureOk = false;
        continue;
      }
      if (t.min > t.max) errors.push(`thresholds[${i}]: min must be <= max`);
      if (t.min <= prevMax) errors.push(`thresholds must be ascending and non-overlapping (thresholds[${i}].min=${t.min} <= previous max=${prevMax})`);
      prevMax = t.max;
    }
    if (structureOk) {
      if (th[0].min !== 0) errors.push('thresholds must start at min=0');
      if (th[th.length - 1].max < 100) errors.push('thresholds must cover up to 100');
    }
  }

  // --- knockouts -----------------------------------------------------------
  const ko = body.knockouts;
  if (!ko || typeof ko !== 'object' || Array.isArray(ko)) {
    errors.push('missing knockouts object');
  } else {
    for (const k of Object.keys(ko)) {
      if (!KNOWN_KNOCKOUT_TAGS.includes(k)) errors.push(`unknown_knockout: '${k}' (known: ${KNOWN_KNOCKOUT_TAGS.join(', ')})`);
      else if (typeof ko[k] !== 'boolean') errors.push(`knockouts.${k} must be a boolean`);
    }
  }

  // --- trajectory ----------------------------------------------------------
  const tr = body.trajectory;
  if (!tr || typeof tr !== 'object' || Array.isArray(tr)) {
    errors.push('missing trajectory object');
  } else if (typeof tr.deltaFlagThreshold !== 'number' || !Number.isFinite(tr.deltaFlagThreshold) || tr.deltaFlagThreshold < 0) {
    errors.push('trajectory.deltaFlagThreshold must be a non-negative number');
  }

  return errors;
}

function assertValidMatrix(body) {
  const errs = validateMatrix(body);
  if (errs.length) {
    const err = new Error(`Invalid risk matrix: ${errs.join('; ')}`);
    err.validationErrors = errs;
    throw err;
  }
}

function invalidate() {
  activeCache = null;
}

async function loadActiveMatrix() {
  if (activeCache) return activeCache;
  const repo = require('../../db/repo');
  const row = await repo.getActiveRiskMatrix();
  if (row && row.body) {
    activeCache = {
      versionId: row.versionId,
      version: row.version,
      body: row.body,
      notes: row.notes ?? null,
      updatedAt: row.updatedAt ?? null,
    };
    return activeCache;
  }
  // Not seeded yet — serve the bundled default without caching so the next
  // call picks up the seeded row.
  return {
    versionId: null,
    version: 0,
    body: defaultMatrixBody(),
    notes: 'bundled default (not yet seeded)',
    updatedAt: null,
  };
}

async function loadMatrixVersion(id) {
  const repo = require('../../db/repo');
  return repo.getRiskMatrixVersion(id);
}

async function listMatrixVersions() {
  const repo = require('../../db/repo');
  return repo.listRiskMatrixVersions();
}

async function createMatrixVersion(body, notes) {
  assertValidMatrix(body);
  const repo = require('../../db/repo');
  return repo.createRiskMatrixVersion({ body, notes: notes ?? null });
}

async function setActiveMatrix(versionId) {
  const repo = require('../../db/repo');
  const row = await repo.setActiveRiskMatrix(versionId);
  invalidate();
  return row;
}

module.exports = {
  DEFAULT_MATRIX,
  KNOWN_KNOCKOUT_TAGS,
  defaultMatrixBody,
  validateMatrix,
  assertValidMatrix,
  invalidate,
  loadActiveMatrix,
  loadMatrixVersion,
  listMatrixVersions,
  createMatrixVersion,
  setActiveMatrix,
};
