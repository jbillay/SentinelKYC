// LLM provider reachability probe — refreshed in the background and surfaced
// to the web shell as a status banner. The probe runs on a timer so /api/health
// is a memory read, not an outbound call.
const { checkProviders } = require('../services/llm');

const HEALTH_INTERVAL_MS = 15_000;

const state = {
  llmHealth: { ok: false, ocr: null, reasoning: null, checkedAt: null },
};

async function refreshLlmHealth() {
  const result = await checkProviders();
  state.llmHealth = { ...result, checkedAt: Date.now() };
  return state.llmHealth;
}

function register(app) {
  app.get('/api/health', async (_req, res) => {
    // Per-agent enablement (Phase 2). Best-effort: a DB hiccup must not take
    // the health endpoint down with it.
    let agents = null;
    try {
      const { listAgentDefs } = require('../agents/defs');
      const { enabledMap } = require('../agents/config');
      const enabled = await enabledMap();
      agents = listAgentDefs().map((d) => ({
        id: d.id,
        name: d.name,
        required: !!d.required,
        enabled: enabled[d.id] !== false,
      }));
    } catch {
      /* agents block omitted on failure */
    }
    res.json({
      ok: state.llmHealth.ok,
      llm: state.llmHealth,
      ...(agents ? { agents } : {}),
      server: { uptime: process.uptime(), now: Date.now() },
    });
  });
}

function startProbeLoop() {
  setInterval(() => {
    refreshLlmHealth().catch(() => {});
  }, HEALTH_INTERVAL_MS).unref();
}

module.exports = { register, refreshLlmHealth, startProbeLoop, state, HEALTH_INTERVAL_MS };
