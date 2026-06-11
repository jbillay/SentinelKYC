// Read-only introspection endpoints powering the Settings → "Data model" and
// "Process" tabs. Everything is re-derived on every request — no caching, no
// writes. See server/services/meta.js for the introspection logic.
const meta = require('../services/meta');
const metrics = require('../services/metrics');
const { compiledGraph, compiledScreeningOnlyGraph } = require('../graph/build');

function register(app) {
  // GET /api/metrics — R7 in-process counters/histograms as JSON. Sits behind
  // the global auth gate like every other /api route. Per-process: in queue
  // mode node/LLM series accumulate in the worker (which logs periodic
  // snapshots), so this endpoint reflects the web process only.
  app.get('/api/metrics', (_req, res) => {
    res.json({ process: 'web', ...metrics.snapshot() });
  });
  // GET /api/meta/data-model
  // → { state: { jsonSchema, fields[] }, persisted: [{label, tables[]}], fragmentsByNode[] }
  app.get('/api/meta/data-model', async (_req, res, next) => {
    try {
      const state = meta.introspectStateSchema();
      const persisted = meta.introspectDrizzleSchema();
      const fragmentsByNode = await meta.getFragmentsByNode({ perNodeLimit: 50 });
      res.json({ state, persisted, fragmentsByNode });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/meta/process
  // → { graphs: [{ label, nodes[], edges[], mermaid }] }
  app.get('/api/meta/process', async (_req, res, next) => {
    try {
      const graphs = [
        meta.introspectGraph(compiledGraph, { label: 'main' }),
        meta.introspectGraph(compiledScreeningOnlyGraph, { label: 'screening_only' }),
      ];
      res.json({ graphs });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register };
