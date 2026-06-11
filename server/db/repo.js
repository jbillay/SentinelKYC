// db/repo.js — facade over the aggregate-root modules in db/repo/*.
// Split per CODE_REVIEW §6.5; call sites keep requiring '../db/repo' and see
// the exact same export surface. New query helpers go in the module that owns
// the aggregate, NOT here.
module.exports = {
  ...require('./repo/dossiers'),
  ...require('./repo/runs'),
  ...require('./repo/fragments'),
  ...require('./repo/runEvents'),
  ...require('./repo/screening'),
  ...require('./repo/risk'),
  ...require('./repo/qa'),
  ...require('./repo/parties'),
  ...require('./repo/users'),
};
