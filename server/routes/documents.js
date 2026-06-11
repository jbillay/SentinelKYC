// CH document binary proxy. The dossier viewer iframes this URL to render a
// stored filing without exposing the CH API key to the browser.
const { getDocumentBinary, SAFE_DOCUMENT_ID } = require('../services/ch');

function register(app) {
  app.get('/api/documents/:documentId', async (req, res, next) => {
    const { documentId } = req.params;
    // Use the canonical SAFE_DOCUMENT_ID shape from services/ch.js so the
    // route and the downstream client agree on what's valid. Real CH doc IDs
    // contain underscores and hyphens — the tightened alphanumeric-only
    // pattern rejected legitimate filings.
    if (!SAFE_DOCUMENT_ID.test(documentId)) {
      return res.status(400).json({ error: 'invalid documentId' });
    }
    try {
      const buf = await getDocumentBinary(documentId);
      const txid = req.query.transactionId
        ? String(req.query.transactionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
        : null;
      const filename = txid ? `${txid}.pdf` : `${documentId}.pdf`;
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${filename}"`);
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(buf);
    } catch (err) {
      if (err.response?.status) {
        return res.status(err.response.status).json({ error: 'upstream_error' });
      }
      next(err);
    }
  });
}

module.exports = { register };
