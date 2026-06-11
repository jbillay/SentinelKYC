const { documentIdFromMetadataLink } = require('../../services/ch');
const { traceEvent } = require('../state');
const { withFragment } = require('../fragments');

const TARGET_CATEGORIES = ['confirmation-statement', 'accounts', 'incorporation'];

function pickLatest(items, category) {
  return items
    .filter((it) => it.category === category)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
}

const selectDocuments = withFragment('select_documents', async function selectDocuments(state) {
  const items = state.filingHistory?.items || [];

  if (items.length === 0) {
    return {
      documents: [],
      trace: [traceEvent('select_documents', 'no filing history items')],
      __fragment: {
        status: 'skipped',
        summary: 'No filing history available — nothing to select',
        outputs: { selected: 0 },
      },
    };
  }

  const picked = TARGET_CATEGORIES
    .map((cat) => pickLatest(items, cat))
    .filter(Boolean)
    .slice(0, 3);

  const documents = [];
  const skipped = [];

  for (const filing of picked) {
    const documentId = documentIdFromMetadataLink(filing.links?.document_metadata);
    if (!documentId) {
      skipped.push({ category: filing.category, reason: 'no document_metadata link' });
      continue;
    }
    documents.push({
      transactionId: filing.transaction_id,
      category: filing.category,
      type: filing.type,
      date: filing.date,
      documentId,
      path: null,
      status: 'selected',
    });
  }

  const summary = documents.length
    ? `Selected ${documents.length} document(s): ${documents.map((d) => `${d.category} (${d.date || 'no date'})`).join(', ')}`
    : 'No documents could be selected from filing history';

  return {
    documents,
    trace: [
      traceEvent('select_documents', `selected ${documents.length} document(s)`, {
        picks: documents.map((d) => `${d.category}:${d.date}`),
        skipped,
      }),
    ],
    __fragment: {
      summary,
      inputs: {
        filingHistoryCount: items.length,
        targetCategories: TARGET_CATEGORIES,
      },
      outputs: {
        selected: documents.length,
        documents: documents.map((d) => ({
          category: d.category,
          date: d.date,
          transactionId: d.transactionId,
        })),
        skipped,
      },
    },
  };
});

module.exports = { selectDocuments };
