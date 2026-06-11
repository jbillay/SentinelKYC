// Phase 2 — graph assembler topology smoke (node-only tier: no Postgres, no
// LLM). Asserts that disabling an agent removes exactly its segment and the
// spine re-stitches around it, for both presets.
//
// Dummy env keeps require-time asserts in the node import chain happy on CI
// runners with no .env: db/client.js (DATABASE_URL) and services/ch.js
// (CH_API_KEY) both throw at module load. Nothing here ever connects or
// calls out (assembly + compile are pure in-memory — compile() is called
// WITHOUT the sqlite checkpointer).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:5/smoke';
process.env.CH_API_KEY = process.env.CH_API_KEY || 'smoke-dummy-key';

const { assembleGraph } = require('../graph/assemble');

let failures = 0;
function ok(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures += 1;
}

function topology({ preset, enabled }) {
  const compiled = assembleGraph({ preset, enabled }).compile();
  const g = compiled.getGraph();
  const nodes = new Set(
    (g.nodes instanceof Map ? [...g.nodes.keys()] : Object.keys(g.nodes || {})).filter(
      (id) => id !== '__start__' && id !== '__end__'
    )
  );
  const edges = (g.edges || []).map((e) => `${e.source}->${e.target}`);
  return { nodes, edges };
}

const ALL = {};

console.log('[agents-assemble:smoke] full preset, all agents enabled');
{
  const { nodes, edges } = topology({ preset: 'full', enabled: ALL });
  ok('has the complete 21-node pipeline', nodes.size === 21);
  for (const n of ['gather_input', 'select_documents', 'resolve_parties', 'compile_screening_list', 'assess_risk', 'qa_check', 'auto_finalize', 'await_decision']) {
    ok(`node ${n} present`, nodes.has(n));
  }
  ok('no qa_skipped stamp', !nodes.has('qa_skipped'));
  ok('docs feed synthesis', edges.includes('process_documents->synthesize_card'));
}

console.log('[agents-assemble:smoke] document-manager disabled');
{
  const { nodes, edges } = topology({ preset: 'full', enabled: { 'document-manager': false } });
  ok('document nodes removed', !nodes.has('select_documents') && !nodes.has('download_documents') && !nodes.has('process_documents'));
  ok('fetch_apis re-stitched to synthesize_card', edges.includes('fetch_apis->synthesize_card'));
  ok('rest of pipeline intact', nodes.has('resolve_parties') && nodes.has('qa_check'));
}

console.log('[agents-assemble:smoke] screening disabled');
{
  const { nodes, edges } = topology({ preset: 'full', enabled: { screening: false } });
  for (const n of ['compile_screening_list', 'screen_sanctions', 'evaluate_sanctions_hits', 'screen_adverse_media', 'evaluate_adverse_media', 'compile_screening_report']) {
    ok(`screening node ${n} removed`, !nodes.has(n));
  }
  ok('resolver re-stitched to risk', edges.includes('resolve_parties->assess_risk'));
}

console.log('[agents-assemble:smoke] ubo-structure disabled');
{
  const { nodes, edges } = topology({ preset: 'full', enabled: { 'ubo-structure': false } });
  ok('resolve_parties removed', !nodes.has('resolve_parties'));
  ok('synthesis re-stitched to screening', edges.includes('synthesize_card->compile_screening_list'));
}

console.log('[agents-assemble:smoke] risk disabled');
{
  const { nodes, edges } = topology({ preset: 'full', enabled: { 'risk-assessment': false } });
  ok('assess_risk removed', !nodes.has('assess_risk'));
  ok('screening report re-stitched to qa', edges.includes('compile_screening_report->qa_check'));
}

console.log('[agents-assemble:smoke] qa disabled → qa_skipped stamp, no auto-approve path');
{
  const { nodes, edges } = topology({ preset: 'full', enabled: { qa: false } });
  ok('qa_check/qa_narrative removed', !nodes.has('qa_check') && !nodes.has('qa_narrative'));
  ok('auto_finalize removed (fail toward review)', !nodes.has('auto_finalize'));
  ok('qa_skipped stamp present', nodes.has('qa_skipped'));
  ok('stamp routes to await_decision', edges.includes('qa_skipped->await_decision'));
}

console.log('[agents-assemble:smoke] everything optional disabled at once');
{
  const { nodes } = topology({
    preset: 'full',
    enabled: { 'document-manager': false, 'ubo-structure': false, screening: false, 'risk-assessment': false, qa: false },
  });
  ok('minimal spine survives (head + synthesis + stamp + decision)', nodes.size === 8);
  ok('await_decision still terminal', nodes.has('await_decision'));
}

console.log('[agents-assemble:smoke] screening preset (rescreen)');
{
  const all = topology({ preset: 'screening', enabled: ALL });
  ok('starts at resolver, no CH/doc nodes', all.nodes.has('resolve_parties') && !all.nodes.has('gather_input') && !all.nodes.has('select_documents'));
  const noUbo = topology({ preset: 'screening', enabled: { 'ubo-structure': false } });
  ok('ubo-disabled rescreen starts at screening', !noUbo.nodes.has('resolve_parties') && noUbo.nodes.has('compile_screening_list'));
}

if (failures > 0) {
  console.error(`[agents-assemble:smoke] FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('[agents-assemble:smoke] all assertions passed');
