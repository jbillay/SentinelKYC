const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { PDFParse } = require('pdf-parse');

// Page PNG path is derived from the source PDF path. This function is safe
// only because every caller obtains `absPath` from
// services/ch.js#downloadDocumentToFile, which validates companyNumber and
// transactionId against /^[A-Z0-9]{6,10}$/ and /^[A-Za-z0-9_-]{1,64}$/
// respectively and confirms the resulting path is inside TMP_ROOT. Do not
// call this with an externally-supplied path.
function pageFilePath(absPath, pageNumber) {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  return path.join(dir, `${base}.p${pageNumber}.png`);
}

async function extractText(absPath) {
  const data = await fsp.readFile(absPath);
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const result = await parser.getText({ pageJoiner: '\n\n' });
    const text = result.text || '';
    const pageCount = result.total || result.pages?.length || 0;
    const charsPerPage = pageCount > 0 ? text.length / pageCount : 0;
    return { text, pageCount, charsPerPage };
  } finally {
    await parser.destroy();
  }
}

// X1 — per-page keyword scores from the text layer (cheap, no LLM). Used by
// the OCR page-relevance selector: the shareholder table of a confirmation
// statement is often NOT in the first 5 pages, so "which 5 pages get OCR'd"
// should follow the text-layer hints when one exists. Returns [] when the PDF
// has no usable text layer (scanned) — caller falls back to first-N.
async function pageTextHints(absPath, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return [];
  const data = await fsp.readFile(absPath);
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const result = await parser.getText();
    const pages = result.pages || [];
    const lowered = keywords.map((k) => String(k).toLowerCase());
    return pages.map((p, idx) => {
      const text = String(p.text || '').toLowerCase();
      let score = 0;
      for (const k of lowered) {
        let pos = 0;
        while ((pos = text.indexOf(k, pos)) !== -1) {
          score += 1;
          pos += k.length;
        }
      }
      return { pageNumber: p.pageNumber ?? idx + 1, score };
    });
  } finally {
    await parser.destroy();
  }
}

// Second arg: a page COUNT (first-N, legacy form) or an array of 1-based page
// numbers (X1 relevance selection). Returned file list follows the requested
// order.
async function rasterizePages(absPath, pagesOrMax = 5, scale = 2) {
  const pageNumbers = Array.isArray(pagesOrMax)
    ? pagesOrMax
    : Array.from({ length: pagesOrMax }, (_, i) => i + 1);
  const expected = pageNumbers.map((n) => ({ pageNumber: n, file: pageFilePath(absPath, n) }));

  const missing = expected.filter((e) => !fs.existsSync(e.file));
  if (missing.length === 0) {
    return expected.map((e) => e.file);
  }

  const data = await fsp.readFile(absPath);
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const result = await parser.getScreenshot({
      partial: missing.map((m) => m.pageNumber),
      scale,
      imageBuffer: true,
      imageDataUrl: false,
    });

    const wrote = new Set();
    for (const page of result.pages) {
      const target = pageFilePath(absPath, page.pageNumber);
      if (page.data) {
        await fsp.writeFile(target, Buffer.from(page.data));
        wrote.add(target);
      }
    }

    return expected
      .filter((e) => fs.existsSync(e.file) || wrote.has(e.file))
      .map((e) => e.file);
  } finally {
    await parser.destroy();
  }
}

function fileHash(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

module.exports = { extractText, rasterizePages, pageTextHints, fileHash };
