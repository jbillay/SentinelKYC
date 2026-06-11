// db/repo/util.js — shared SQL string helpers.
// Split from the monolithic db/repo.js (CODE_REVIEW §6.5).

// backslash as the default LIKE escape character.
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

function pgTextArrayLiteral(arr) {
  if (!Array.isArray(arr)) return null;
  const escaped = arr.map((s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
  return '{' + escaped.join(',') + '}';
}

module.exports = {
  escapeLike,
  pgTextArrayLiteral,
};
