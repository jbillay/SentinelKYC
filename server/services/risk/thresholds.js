// Score → tier band. The matrix thresholds are integer-keyed and may leave a
// 1-point seam between bands (e.g. Low 0–35, Medium 36–70); rounding the score
// to the nearest integer bridges that seam.

function scoreToTier(score, matrix) {
  const thresholds = (matrix && matrix.thresholds) || [];
  if (!Array.isArray(thresholds) || thresholds.length === 0) return 'Low';
  const s = Math.round(Number(score) || 0);
  for (const t of thresholds) {
    if (s >= t.min && s <= t.max) return t.tier;
  }
  const last = thresholds[thresholds.length - 1];
  if (s > last.max) return last.tier;
  return thresholds[0].tier;
}

module.exports = { scoreToTier };
