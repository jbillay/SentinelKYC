const { extractText, rasterizePages, pageTextHints } = require('../../services/pdf');
const { ocrPage, extractStructured } = require('../../services/llm');
const { getExtractor } = require('../extractors');
const { traceEvent, errorEvent } = require('../state');
const { withFragment } = require('../fragments');

const { loadAgentConfig } = require('../../agents/config');

const OCR_PAGE_CAP = 5; // default when agent config is unseeded
const TEXT_DENSITY_THRESHOLD = 200;
const OCR_RASTER_SCALE = 1.5;

function shouldOcr(extractor, charsPerPage) {
  if (extractor.ocrPolicy === 'always') return true;
  if (extractor.ocrPolicy === 'ifLowText' && charsPerPage < TEXT_DENSITY_THRESHOLD) return true;
  return false;
}

// X1 slice 2 — which pages deserve the OCR budget. The cap stays at
// OCR_PAGE_CAP; relevance selection changes WHICH pages get it: a
// confirmation statement's shareholder table is often past page 5. Keywords
// are matched against the text layer (cheap, no LLM); all-zero scores (a
// scanned PDF has no text layer) fall back to first-N, as does
// OCR_PAGE_SELECTION=first. Incorporation docs front-load their content —
// no keyword list → first-N.
const RELEVANCE_KEYWORDS = {
  'confirmation-statement': [
    'shareholder', 'subscriber', 'allotment', 'share capital',
    'statement of capital', 'class of share',
  ],
  accounts: ['balance sheet', 'profit and loss', 'total assets', 'net assets'],
};

async function selectOcrPages(doc, pageCount) {
  // Cap + selection mode come from the document-manager agent config
  // (Settings → Agents). pageCapEnabled=false lifts the per-document limit
  // entirely (every page gets the OCR budget — slow, deliberate opt-in).
  // OCR_PAGE_SELECTION env stays as an explicit override for smokes.
  const cfg = await loadAgentConfig('document-manager');
  const capEnabled = cfg.pageCapEnabled !== false;
  const cap = capEnabled ? (cfg.pageCap ?? OCR_PAGE_CAP) : Math.max(1, pageCount || OCR_PAGE_CAP);
  const firstN = Array.from({ length: Math.min(pageCount || cap, cap) }, (_, i) => i + 1);
  const mode = String(process.env.OCR_PAGE_SELECTION || cfg.pageSelection || 'relevance').toLowerCase();
  const keywords = RELEVANCE_KEYWORDS[doc.category];
  if (mode === 'first' || !keywords || (pageCount || 0) <= cap) {
    return { pages: firstN, selectionMode: 'first' };
  }
  try {
    const hints = await pageTextHints(doc.path, keywords);
    if (!hints.length || hints.every((h) => h.score === 0)) {
      return { pages: firstN, selectionMode: 'first' };
    }
    const pages = [...hints]
      .sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber)
      .slice(0, cap)
      .map((h) => h.pageNumber)
      .sort((a, b) => a - b); // OCR in reading order
    return { pages, selectionMode: 'relevance' };
  } catch {
    return { pages: firstN, selectionMode: 'first' };
  }
}

function noopProgress() {}

async function processOne(doc, idx, total, traces, errors, emitProgress, fragments, opts = {}) {
  const forceFresh = !!opts.forceFresh;
  const docStartedAt = Date.now();
  const baseProgress = {
    transactionId: doc.transactionId,
    category: doc.category,
    date: doc.date || null,
    docIndex: idx,
    docTotal: total,
  };

  if (doc.status !== 'downloaded' || !doc.path) {
    traces.push(
      traceEvent('process_documents', `skip ${doc.category} (status=${doc.status})`, {
        transactionId: doc.transactionId,
      })
    );
    emitProgress({ ...baseProgress, stage: 'skipped' });
    fragments.push({
      nodeId: 'process_documents',
      kind: 'decision',
      status: 'skipped',
      startedAt: docStartedAt,
      durationMs: Date.now() - docStartedAt,
      summary: `Skipped ${doc.category} (status=${doc.status})`,
      inputs: { transactionId: doc.transactionId, category: doc.category },
    });
    return doc;
  }

  const extractor = getExtractor(doc.category);
  if (!extractor) {
    traces.push(
      traceEvent('process_documents', `no extractor for ${doc.category}, skipping`, {
        transactionId: doc.transactionId,
      })
    );
    emitProgress({ ...baseProgress, stage: 'skipped' });
    fragments.push({
      nodeId: 'process_documents',
      kind: 'decision',
      status: 'skipped',
      startedAt: docStartedAt,
      durationMs: Date.now() - docStartedAt,
      summary: `No extractor available for ${doc.category} — skipped`,
      inputs: { transactionId: doc.transactionId, category: doc.category },
    });
    return doc;
  }

  try {
    emitProgress({ ...baseProgress, stage: 'preparing', message: 'Reading PDF…' });
    const { text, charsPerPage, pageCount } = await extractText(doc.path);
    const useOcr = shouldOcr(extractor, charsPerPage);

    let inputText;
    let processedBy;
    let ocrPagesProcessed = 0;
    let ocrPagesAttempted = 0;
    // X1 — truncation surfacing + page selection metadata.
    let truncated = false;
    let pagesSelected;
    const pagesTotal = pageCount || 0;

    if (useOcr) {
      const { pages: selected, selectionMode } = await selectOcrPages(doc, pageCount);
      pagesSelected = selected;
      truncated = pagesTotal > selected.length;
      if (truncated) {
        traces.push(
          traceEvent(
            'process_documents',
            `OCR truncated for ${doc.category}: processing ${selected.length} of ${pagesTotal} pages (selection=${selectionMode})`,
            { transactionId: doc.transactionId, pagesTotal, pagesSelected: selected }
          )
        );
      }
      emitProgress({
        ...baseProgress,
        stage: 'rasterizing',
        message: `Rasterizing ${selected.length} page(s) for OCR…`,
        pages: selected.length,
        pagesTotal,
        truncated,
      });
      const pngs = await rasterizePages(doc.path, selected, OCR_RASTER_SCALE);
      traces.push(
        traceEvent('process_documents', `OCR ${doc.category} (${pngs.length} page(s))`, {
          transactionId: doc.transactionId,
          pages: pngs.length,
          pagesSelected: selected,
          selectionMode,
          charsPerPage: Math.round(charsPerPage),
        })
      );

      const parts = [];
      let okPages = 0;
      const pageDurations = [];
      for (let i = 0; i < pngs.length; i++) {
        const pageStart = Date.now();
        emitProgress({
          ...baseProgress,
          stage: 'ocr_page',
          page: i + 1,
          pages: pngs.length,
          message: `OCR page ${i + 1} of ${pngs.length}…`,
          pageDurations: [...pageDurations],
        });
        try {
          const result = await ocrPage(pngs[i], { forceFresh });
          parts.push(`--- page ${pagesSelected?.[i] ?? i + 1} ---\n${result.text}`);
          okPages += 1;
          const dur = Date.now() - pageStart;
          pageDurations.push(dur);
          emitProgress({
            ...baseProgress,
            stage: 'ocr_page_done',
            page: i + 1,
            pages: pngs.length,
            cached: !!result.cached,
            pageDurationMs: dur,
            pageDurations: [...pageDurations],
            message: result.cached
              ? `Page ${i + 1} cached`
              : `Page ${i + 1} done`,
          });
        } catch (pageErr) {
          const cause = pageErr.cause?.code || pageErr.cause?.message || '';
          errors.push(
            errorEvent(
              'process_documents',
              `${doc.transactionId} page ${i + 1} OCR failed: ${pageErr.message}${cause ? ` (${cause})` : ''}`
            )
          );
          parts.push(`--- page ${pagesSelected?.[i] ?? i + 1} (OCR failed) ---`);
          emitProgress({
            ...baseProgress,
            stage: 'ocr_page_failed',
            page: i + 1,
            pages: pngs.length,
            message: `Page ${i + 1} failed`,
          });
        }
      }
      if (okPages === 0) {
        throw new Error(`OCR failed on all ${pngs.length} page(s)`);
      }
      inputText = parts.join('\n\n');
      processedBy = 'ocr';
      ocrPagesProcessed = okPages;
      ocrPagesAttempted = pngs.length;
    } else {
      traces.push(
        traceEvent('process_documents', `text ${doc.category}`, {
          transactionId: doc.transactionId,
          charsPerPage: Math.round(charsPerPage),
        })
      );
      emitProgress({
        ...baseProgress,
        stage: 'text_extracted',
        message: `Text layer extracted (${Math.round(charsPerPage)} chars/page)`,
      });
      inputText = text;
      processedBy = 'text';
    }

    emitProgress({
      ...baseProgress,
      stage: 'extracting',
      message: `Structured extraction (${processedBy})…`,
      processedBy,
    });
    const extractorPrompt = await extractor.getPrompt();
    const extracted = await extractStructured(inputText, extractor.schema, extractorPrompt);

    // R6 — stamp provenance (text vs ocr) onto every extracted record so the
    // card can mark "from OCR" honestly. Model-reported `confidence` (if the
    // active prompt asked for it) rides along untouched — advisory only.
    if (extracted && typeof extracted === 'object') {
      for (const value of Object.values(extracted)) {
        if (Array.isArray(value)) {
          for (const rec of value) {
            if (rec && typeof rec === 'object' && !rec.provenance) rec.provenance = processedBy;
          }
        }
      }
      // Scalar-record extractions (accounts) get a top-level stamp the card
      // builder lifts onto financials.
      if (!extracted.provenance) extracted.provenance = processedBy;
    }

    traces.push(
      traceEvent('process_documents', `extracted ${doc.category}`, {
        transactionId: doc.transactionId,
        processedBy,
      })
    );
    emitProgress({
      ...baseProgress,
      stage: 'done',
      processedBy,
      message: `Extracted ${doc.category}`,
    });

    const extractedSummary = summarizeExtraction(doc.category, extracted);
    fragments.push({
      nodeId: 'process_documents',
      kind: 'decision',
      status: 'ok',
      startedAt: docStartedAt,
      durationMs: Date.now() - docStartedAt,
      summary: `Processed ${doc.category} (${doc.date || 'no date'}) via ${processedBy} — ${extractedSummary}`,
      inputs: {
        transactionId: doc.transactionId,
        category: doc.category,
        date: doc.date,
        processedBy,
        ocrPolicy: extractor.ocrPolicy,
      },
      outputs: {
        processedBy,
        extracted,
        ocrPagesProcessed,
        ocrPagesAttempted,
        truncated,
        pagesTotal,
        pagesSelected,
      },
    });

    return {
      ...doc,
      status: 'processed',
      processedBy,
      extracted,
      // X1 — surfaced so synthesize_card can raise the truncation red flag
      // and the UI can show "processed N of M pages".
      truncated,
      pagesProcessed: processedBy === 'ocr' ? ocrPagesProcessed : pagesTotal,
      pagesTotal,
      pagesSelected,
    };
  } catch (err) {
    errors.push(errorEvent('process_documents', `${doc.transactionId}: ${err.message}`));
    traces.push(
      traceEvent('process_documents', `failed ${doc.category}: ${err.message}`, {
        transactionId: doc.transactionId,
      })
    );
    emitProgress({
      ...baseProgress,
      stage: 'failed',
      message: err.message,
    });
    fragments.push({
      nodeId: 'process_documents',
      kind: 'decision',
      status: 'failed',
      startedAt: docStartedAt,
      durationMs: Date.now() - docStartedAt,
      summary: `Failed ${doc.category}: ${err.message}`,
      error: err.message,
      inputs: {
        transactionId: doc.transactionId,
        category: doc.category,
      },
    });
    return {
      ...doc,
      status: 'failed',
      processedBy: 'failed',
      error: err.message,
    };
  }
}

function summarizeExtraction(category, extracted) {
  if (!extracted) return 'no fields extracted';
  switch (category) {
    case 'confirmation-statement':
      return `${extracted.shareholders?.length || 0} shareholder(s) extracted`;
    case 'accounts': {
      const fields = [];
      if (extracted.turnover != null) fields.push(`turnover £${extracted.turnover}`);
      if (extracted.netAssets != null) fields.push(`net assets £${extracted.netAssets}`);
      if (extracted.periodEnd) fields.push(`period ${extracted.periodEnd}`);
      return fields.length ? fields.join(', ') : 'financial fields extracted';
    }
    case 'incorporation':
      return `${extracted.initialSubscribers?.length || 0} initial subscriber(s) extracted`;
    default:
      return 'fields extracted';
  }
}

const processDocuments = withFragment('process_documents', async function processDocuments(state, config) {
  const documents = state.documents || [];
  if (documents.length === 0) {
    return {
      trace: [traceEvent('process_documents', 'no documents to process')],
      __fragment: {
        status: 'skipped',
        summary: 'No documents to process',
      },
    };
  }

  const emitProgress = config?.configurable?.emitProgress || noopProgress;
  const forceFresh = !!config?.configurable?.forceFresh;
  const traces = [];
  const errors = [];
  const updated = [];
  const docFragments = [];

  emitProgress({ stage: 'batch_start', docTotal: documents.length, message: `Processing ${documents.length} document(s)` });

  // Run the per-document pipeline in parallel. Ollama internally serialises
  // generation requests so we don't gain on the OCR step itself, but pdf-parse
  // + raster + structured extraction overlap usefully, and the wall-clock for
  // the document phase drops by roughly the number of docs (typically 2-3x).
  // We preserve trace/error/fragment ORDER by sorting after the fact by the
  // doc's original index — concat-reducer state has no ordering guarantee for
  // mid-run streams, but the trail looks tidier when child fragments cluster
  // by document. See CODE_REVIEW §4.4.
  const indexed = await Promise.all(
    documents.map(async (doc, i) => {
      const localTraces = [];
      const localErrors = [];
      const localFragments = [];
      const updatedDoc = await processOne(doc, i, documents.length, localTraces, localErrors, emitProgress, localFragments, { forceFresh });
      return { i, updatedDoc, localTraces, localErrors, localFragments };
    }),
  );
  indexed.sort((a, b) => a.i - b.i);
  for (const r of indexed) {
    updated.push(r.updatedDoc);
    traces.push(...r.localTraces);
    errors.push(...r.localErrors);
    docFragments.push(...r.localFragments);
  }

  const processed = updated.filter((d) => d.status === 'processed').length;
  traces.push(
    traceEvent('process_documents', `done: ${processed}/${documents.length} processed`)
  );
  emitProgress({ stage: 'batch_done', docTotal: documents.length, processed });

  const update = {
    documents: updated,
    trace: traces,
    __fragments: docFragments,
  };
  if (errors.length) update.errors = errors;
  return update;
});

module.exports = {
  processDocuments,
  // Exported for extraction-truncation-smoke (no LLM needed).
  _selectOcrPages: selectOcrPages,
  OCR_PAGE_CAP,
};
