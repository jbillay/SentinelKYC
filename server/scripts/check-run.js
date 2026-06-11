const repo = require('../db/repo');
const { pool } = require('../db/client');

(async () => {
  try {
    const d = await repo.getDossier('00048839');
    const run = d?.runs[0];
    if (!run) {
      console.log('no run');
      return;
    }
    const full = await repo.getRun(run.id);
    console.log(`status=${run.status}  trigger=${run.trigger}  fragments=${full.fragments.length}`);
    if (run.status !== 'running') {
      console.log('finalKycCard:', !!run.finalKycCard);
      console.log('finalShareholderGraph:', !!run.finalShareholderGraph);
      console.log('finalDocuments:', Array.isArray(run.finalDocuments) ? run.finalDocuments.length : 'n/a');
    }
  } finally {
    await pool.end();
  }
})();
