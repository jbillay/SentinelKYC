const ch = require('../../services/ch');
const { traceEvent, errorEvent } = require('../state');
const { withFragment } = require('../fragments');

async function downloadOne(doc, companyNumber, { forceFresh = false } = {}) {
  try {
    const { path: filePath, cached } = await ch.downloadDocumentToFile(
      doc.documentId,
      companyNumber,
      doc.transactionId,
      { forceFresh }
    );
    return {
      doc: { ...doc, path: filePath, status: 'downloaded' },
      trace: traceEvent(
        'download_documents',
        `${cached ? 'cached' : 'downloaded'} ${doc.category} (${doc.transactionId})`,
        { category: doc.category, transactionId: doc.transactionId, path: filePath, cached }
      ),
    };
  } catch (err) {
    return {
      doc: { ...doc, status: 'failed', error: err.message },
      trace: traceEvent('download_documents', `failed ${doc.category} (${doc.transactionId})`, {
        category: doc.category,
        transactionId: doc.transactionId,
      }),
      error: errorEvent('download_documents', `${doc.transactionId}: ${err.message}`),
    };
  }
}

const downloadDocuments = withFragment('download_documents', async function downloadDocuments(state, config) {
  const { documents, companyNumber } = state;
  const forceFresh = !!config?.configurable?.forceFresh;

  if (!documents || documents.length === 0) {
    return {
      trace: [traceEvent('download_documents', 'no documents to download')],
      __fragment: {
        status: 'skipped',
        summary: 'No documents to download',
      },
    };
  }
  if (!companyNumber) {
    return {
      errors: [errorEvent('download_documents', 'companyNumber missing')],
      __fragment: {
        status: 'failed',
        summary: 'Cannot download — companyNumber missing from state',
        error: 'companyNumber missing',
      },
    };
  }

  const results = await Promise.all(
    documents.map((d) => downloadOne(d, companyNumber, { forceFresh }))
  );

  const updatedDocs = results.map((r) => r.doc);
  const traces = results.map((r) => r.trace);
  const errors = results.map((r) => r.error).filter(Boolean);

  const succeeded = updatedDocs.filter((d) => d.status === 'downloaded').length;
  const cachedCount = traces.filter((t) => t.extra?.cached).length;
  traces.push(
    traceEvent('download_documents', `done: ${succeeded}/${documents.length} downloaded`)
  );

  // Status semantics: all-ok / all-failed / partial. Previously "partial" was
  // silently reported as 'ok' which painted the trail green even when half the
  // PDFs never arrived. The status enum is ok/failed/skipped, so a mixed
  // outcome uses 'failed' with a summary that surfaces the partial count.
  let fragStatus = 'ok';
  if (succeeded === 0) fragStatus = 'failed';
  else if (succeeded < documents.length) fragStatus = 'failed';
  const update = {
    documents: updatedDocs,
    trace: traces,
    __fragment: {
      status: fragStatus,
      summary: `Downloaded ${succeeded}/${documents.length} document PDF(s)${cachedCount ? ` — ${cachedCount} from cache` : ''}`,
      inputs: { documentCount: documents.length, companyNumber },
      outputs: {
        succeeded,
        cached: cachedCount,
        failed: documents.length - succeeded,
        documents: updatedDocs.map((d) => ({
          category: d.category,
          transactionId: d.transactionId,
          status: d.status,
        })),
      },
    },
  };
  if (errors.length) update.errors = errors;
  return update;
});

module.exports = { downloadDocuments };
