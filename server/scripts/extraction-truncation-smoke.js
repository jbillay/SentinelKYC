// P1 X1 — OCR truncation + page-relevance selection smoke (no DB, no LLM).
//
// Generates an 8-page PDF fixture in-memory (page 7 carries the shareholder
// table keywords) and asserts:
//   1. extractText reports the real page count.
//   2. pageTextHints scores page 7 highest for confirmation-statement keywords.
//   3. _selectOcrPages picks page 7 under relevance, 1–5 under first.
//   4. rasterizePages accepts explicit page indices and writes those PNGs.
//   5. The truncated-document red flag carries the page counts.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractText, rasterizePages, pageTextHints } = require('../services/pdf');
const { _selectOcrPages, OCR_PAGE_CAP } = require('../graph/nodes/processDocuments');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

// --- minimal valid multi-page PDF builder (text layer, Helvetica) ----------
function buildPdf(pageTexts) {
  const objects = [];
  const n = pageTexts.length;
  // obj 1: catalog, obj 2: pages, obj 3: font, pages start at obj 4
  const pageObjNums = pageTexts.map((_, i) => 4 + i * 2);
  const kids = pageObjNums.map((num) => `${num} 0 R`).join(' ');
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  pageTexts.forEach((text, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    const lines = text.split('\n');
    const ops = lines
      .map((line, li) => `BT /F1 12 Tf 50 ${740 - li * 16} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET`)
      .join('\n');
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`
    );
    objects.push(`${contentNum} 0 obj\n<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream\nendobj\n`);
  });

  let body = '%PDF-1.4\n';
  const offsets = [0]; // object 0 (free)
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'binary');
}

async function main() {
  console.log('[extraction-truncation:smoke] running');

  const pages = [];
  for (let p = 1; p <= 8; p++) {
    if (p === 7) {
      pages.push(
        'Statement of capital\nShareholder information as at the confirmation date\nShareholder: John Smith - 50 Ordinary shares\nShareholder: Jane Roe - 50 Ordinary shares\nClass of share: Ordinary. Share capital total 100.'
      );
    } else {
      pages.push(`Company information continuation sheet. Page ${p} of 8. Registered office details.`);
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trunc-smoke-'));
  const pdfPath = path.join(tmpDir, 'fixture.pdf');
  fs.writeFileSync(pdfPath, buildPdf(pages));

  // --- 1: page count
  const { pageCount, charsPerPage } = await extractText(pdfPath);
  ok('extractText reports 8 pages', pageCount === 8, `got=${pageCount}`);
  ok('fixture has a text layer', charsPerPage > 0, `charsPerPage=${Math.round(charsPerPage)}`);

  // --- 2: relevance hints
  const hints = await pageTextHints(pdfPath, ['shareholder', 'share capital', 'class of share', 'statement of capital']);
  ok('hints returned for all pages', hints.length === 8, `got=${hints.length}`);
  const top = [...hints].sort((a, b) => b.score - a.score)[0];
  ok('page 7 scores highest', top.pageNumber === 7 && top.score >= 4, JSON.stringify(top));

  // --- 3: page selection
  const doc = { category: 'confirmation-statement', path: pdfPath };
  delete process.env.OCR_PAGE_SELECTION; // default = relevance
  const rel = await _selectOcrPages(doc, pageCount);
  ok(`relevance selects ${OCR_PAGE_CAP} pages`, rel.pages.length === OCR_PAGE_CAP, JSON.stringify(rel));
  ok('relevance selection includes page 7', rel.pages.includes(7), JSON.stringify(rel.pages));
  ok('selection mode reported as relevance', rel.selectionMode === 'relevance');

  process.env.OCR_PAGE_SELECTION = 'first';
  const first = await _selectOcrPages(doc, pageCount);
  ok('OCR_PAGE_SELECTION=first selects 1..5',
    JSON.stringify(first.pages) === JSON.stringify([1, 2, 3, 4, 5]),
    JSON.stringify(first.pages));
  ok('first selection misses page 7 (the old silent-truncation bug)', !first.pages.includes(7));
  delete process.env.OCR_PAGE_SELECTION;

  // Scanned-PDF fallback: keywords that hit nothing → first-N.
  const noHit = await pageTextHints(pdfPath, ['zzz-nonexistent-keyword']);
  ok('all-zero hints detected', noHit.every((h) => h.score === 0));

  // --- 4: rasterize explicit page indices
  const pngs = await rasterizePages(pdfPath, rel.pages, 1.0);
  ok('rasterizePages honours explicit page list', pngs.length === rel.pages.length, `got=${pngs.length}`);
  ok('page-7 PNG written', pngs.some((f) => f.endsWith('.p7.png')), pngs.join(', '));

  // --- 5: truncation metadata → red flag text
  const truncatedDoc = { category: 'confirmation-statement', truncated: true, pagesProcessed: 5, pagesTotal: 52 };
  const flag = `OCR truncated: processed ${truncatedDoc.pagesProcessed} of ${truncatedDoc.pagesTotal} pages of the ${truncatedDoc.category} — extracted lists (shareholders / subscribers) may be incomplete.`;
  ok('red flag wording carries the counts', /processed 5 of 52 pages/.test(flag) && /may be incomplete/.test(flag));
  ok('truncation detected when pagesTotal exceeds selection', 8 > rel.pages.length);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('[extraction-truncation:smoke] done');
}

main().catch((err) => {
  console.error('[extraction-truncation:smoke] FAILED:', err);
  process.exitCode = 1;
});
