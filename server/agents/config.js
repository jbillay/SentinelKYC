// Agent-config façade — the single read/write path for per-agent runtime
// configuration. Combines the pure definitions (defs.js), the dumb versioned
// store (services/config/store.js), and at-rest secret encryption
// (services/config/secrets.js).
//
// Read path (hot, in-process cached): loadAgentConfig(id) → defaults merged
// under the active DB body, secret fields decrypted. Unseeded agents serve
// their defaults uncached (matrix.js precedent) so the next call picks up a
// seeded row. Save invalidates the cache AND the assembled-graph cache (the
// graph topology depends on the enabled set — see graph/build.js).

const defs = require('./defs');
const store = require('../services/config/store');
const {
  encryptSecret,
  decryptSecret,
  UNCHANGED_SENTINEL,
} = require('../services/config/secrets');

const cache = new Map(); // agentId → resolved config body (decrypted)
const invalidationListeners = new Set();

function onConfigChange(fn) {
  invalidationListeners.add(fn);
}

function invalidate(agentId) {
  if (agentId) cache.delete(agentId);
  else cache.clear();
  for (const fn of invalidationListeners) {
    try {
      fn(agentId);
    } catch {
      /* listener errors must not break config writes */
    }
  }
}

function decryptBody(def, body) {
  const out = { ...body };
  for (const key of defs.secretFieldKeys(def)) {
    if (typeof out[key] === 'string' && out[key]) out[key] = decryptSecret(out[key]);
  }
  return out;
}

async function loadAgentConfig(agentId) {
  if (cache.has(agentId)) return cache.get(agentId);
  const def = defs.getAgentDef(agentId);

  const active = await store.getActiveBody(agentId);
  const merged = { ...def.defaults, ...((active && active.body) || {}) };
  if (def.required) merged.enabled = true;

  const parsed = def.schema.safeParse(merged);
  // A schema-drifted stored body (e.g. a field renamed in code) must not take
  // the pipeline down — fall back to defaults and let the next save repair it.
  const resolved = parsed.success ? decryptBody(def, parsed.data) : { ...def.defaults };

  if (active) cache.set(agentId, resolved); // unseeded → uncached (matrix.js precedent)
  return resolved;
}

async function isAgentEnabled(agentId) {
  const def = defs.getAgentDef(agentId);
  if (def.required) return true;
  const cfg = await loadAgentConfig(agentId);
  return cfg.enabled !== false;
}

// { agentId → boolean } for every defined agent, plus a stable signature used
// to key the assembled-graph cache.
async function enabledMap() {
  const out = {};
  for (const def of defs.listAgentDefs()) {
    out[def.id] = await isAgentEnabled(def.id);
  }
  return out;
}

function enabledSignature(map) {
  return Object.keys(map)
    .sort()
    .map((id) => `${id}=${map[id] ? 1 : 0}`)
    .join(',');
}

// Validate + persist a full config body as a new active version. Secret
// fields: UNCHANGED_SENTINEL keeps the stored ciphertext; any other value is
// encrypted before persisting. Plaintext never reaches Postgres.
async function saveAgentConfig(agentId, body, { actor = null, notes = null } = {}) {
  const def = defs.getAgentDef(agentId);
  const candidate = { ...def.defaults, ...(body || {}) };
  if (def.required) candidate.enabled = true;

  const secretKeys = defs.secretFieldKeys(def);
  if (secretKeys.length) {
    const current = await store.getActiveBody(agentId);
    for (const key of secretKeys) {
      if (candidate[key] === UNCHANGED_SENTINEL) {
        candidate[key] = current?.body?.[key] ?? '';
      }
    }
  }

  const parsed = def.schema.safeParse(candidate);
  if (!parsed.success) {
    const err = new Error('invalid agent config');
    err.code = 'invalid_config';
    err.validationErrors = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`
    );
    throw err;
  }

  const toStore = { ...parsed.data };
  for (const key of secretKeys) {
    if (toStore[key] && !String(toStore[key]).startsWith('enc:v1:')) {
      toStore[key] = encryptSecret(toStore[key]);
    }
  }

  const row = await store.createAndActivate(agentId, toStore, { notes, actor });
  invalidate(agentId);
  return row;
}

// Convenience for the enable/disable toggle: new version with just `enabled`
// flipped, auto-noted. Refuses on required agents.
async function setAgentEnabled(agentId, enabled, { actor = null } = {}) {
  const def = defs.getAgentDef(agentId);
  if (def.required && !enabled) {
    const err = new Error(`agent ${agentId} is required and cannot be disabled`);
    err.code = 'agent_required';
    throw err;
  }
  const current = await loadAgentConfig(agentId);
  return saveAgentConfig(
    agentId,
    { ...current, enabled: !!enabled },
    { actor, notes: enabled ? 'agent enabled' : 'agent disabled' }
  );
}

function maskSecrets(def, body) {
  const out = { ...body };
  for (const key of defs.secretFieldKeys(def)) {
    out[key] = { set: !!out[key] };
  }
  return out;
}

// UI listing: definition metadata + active (masked) config + version info.
async function listAgents() {
  const out = [];
  for (const def of defs.listAgentDefs()) {
    const cfg = await loadAgentConfig(def.id);
    const active = await store.getActiveBody(def.id);
    out.push({
      id: def.id,
      name: def.name,
      description: def.description,
      required: !!def.required,
      enabled: def.required ? true : cfg.enabled !== false,
      fields: def.fields,
      io: def.io,
      config: maskSecrets(def, cfg),
      activeVersion: active?.version ?? null,
      updatedAt: active?.createdAt ?? null,
    });
  }
  return out;
}

async function getAgentDetail(agentId) {
  const def = defs.getAgentDef(agentId);
  const cfg = await loadAgentConfig(agentId);
  const active = await store.getActiveBody(agentId);
  const versions = await store.listVersions(agentId);
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    required: !!def.required,
    enabled: def.required ? true : cfg.enabled !== false,
    fields: def.fields,
    io: def.io,
    config: maskSecrets(def, cfg),
    activeVersion: active?.version ?? null,
    versions,
  };
}

// Boot seeding (idempotent): any agent with no active row gets its defaults
// as version 1, so the Settings page always has a concrete version to show.
async function seedAgentConfigs() {
  for (const def of defs.listAgentDefs()) {
    const active = await store.getActiveBody(def.id);
    if (!active) {
      await store.createAndActivate(def.id, { ...def.defaults }, {
        notes: 'seeded default',
        actor: 'system',
      });
    }
  }
  invalidate();
}

module.exports = {
  loadAgentConfig,
  isAgentEnabled,
  enabledMap,
  enabledSignature,
  saveAgentConfig,
  setAgentEnabled,
  listAgents,
  getAgentDetail,
  seedAgentConfigs,
  invalidate,
  onConfigChange,
};
