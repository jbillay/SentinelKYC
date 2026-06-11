// Graph compilation + cache. Topology comes from graph/assemble.js,
// parameterized by the enabled-agent set (Settings → Agents); this module
// compiles assemblies against the shared SQLite checkpointer and caches them
// by (preset, enabled-set signature). Saving agent config invalidates the
// cache, so the next dispatched run picks the new topology — no restart.
//
// Caveat (documented, accepted for v0.1): a run paused at an interrupt
// resumes on the graph that the CURRENT enabled set produces. If an agent
// was toggled while the run was paused, the resumed half runs the new
// topology. state.agentStatus still reflects the dispatch-time snapshot.

const path = require('path');
const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite');

const { CHECKPOINT_DIR } = require('../lib/dataDirs');
const { assembleGraph } = require('./assemble');
const agentConfig = require('../agents/config');

const checkpointer = SqliteSaver.fromConnString(
  path.join(CHECKPOINT_DIR, 'graph-checkpoints.db')
);

const compiledCache = new Map(); // `${preset}|${signature}` → compiled graph

agentConfig.onConfigChange(() => compiledCache.clear());

// Async, enabled-set-aware entry point — what runDispatch/resumeReconciler use.
// key: 'full' | 'screening'
async function getGraph(key = 'full') {
  const preset = key === 'screening' ? 'screening' : 'full';
  const enabled = await agentConfig.enabledMap();
  const signature = agentConfig.enabledSignature(enabled);
  const cacheKey = `${preset}|${signature}`;
  if (!compiledCache.has(cacheKey)) {
    compiledCache.set(cacheKey, assembleGraph({ preset, enabled }).compile({ checkpointer }));
  }
  return { graph: compiledCache.get(cacheKey), enabled, signature };
}

// Legacy all-enabled exports. Kept for topology introspection (routes/meta)
// and the qa-integration smoke; the run pipeline goes through getGraph().
const ALL_ENABLED = {};
const compiledGraph = assembleGraph({ preset: 'full', enabled: ALL_ENABLED }).compile({
  checkpointer,
});
const compiledScreeningOnlyGraph = assembleGraph({
  preset: 'screening',
  enabled: ALL_ENABLED,
}).compile({ checkpointer });

module.exports = { getGraph, compiledGraph, compiledScreeningOnlyGraph };
