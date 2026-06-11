const { z } = require('zod');
const { extractStructured } = require('../../services/llm');
const { loadPrompt } = require('../../services/prompts');
const { traceEvent, errorEvent } = require('../state');
const { withFragment } = require('../fragments');

const SYNTHESIS_SCHEMA = z.object({
  identity: z.object({
    name: z.string(),
    companyNumber: z.string(),
    type: z.string().optional(),
    status: z.string().optional(),
    incorporationDate: z.string().optional(),
    countryOfIncorporation: z.string().optional(),
    sicCodes: z.array(z.string()).optional(),
  }),
  addresses: z
    .object({ registered: z.string().optional() })
    .optional(),
  officers: z
    .array(
      z.object({
        name: z.string(),
        role: z.string().optional(),
        appointedOn: z.string().optional(),
        resignedOn: z.string().optional(),
      })
    )
    .default(() => []),
  psc: z
    .array(
      z.object({
        name: z.string(),
        kind: z.string().optional(),
        naturesOfControl: z.array(z.string()).optional(),
        notifiedOn: z.string().optional(),
      })
    )
    .default(() => []),
  shareholders: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(['individual', 'corporate']).optional(),
        shares: z.number().optional(),
        percentage: z.number().optional(),
        shareClass: z.string().optional(),
      })
    )
    .default(() => []),
  financials: z
    .object({
      periodEnd: z.string().optional(),
      turnover: z.number().optional(),
      profit: z.number().optional(),
      totalAssets: z.number().optional(),
      netAssets: z.number().optional(),
      employees: z.number().optional(),
    })
    .optional(),
  redFlags: z.array(z.string()).default(() => []),
});

function pickApi(profile) {
  if (!profile) return null;
  return {
    name: profile.company_name,
    companyNumber: profile.company_number,
    type: profile.type,
    status: profile.company_status,
    incorporationDate: profile.date_of_creation,
    sicCodes: profile.sic_codes,
    registeredAddress: profile.registered_office_address,
  };
}

function summarizeOfficers(officers) {
  const items = officers?.items || [];
  return items.slice(0, 20).map((o) => ({
    name: o.name,
    role: o.officer_role,
    appointedOn: o.appointed_on,
    resignedOn: o.resigned_on,
  }));
}

function summarizePsc(psc) {
  const items = psc?.items || [];
  return items.slice(0, 20).map((p) => ({
    name: p.name,
    kind: p.kind,
    naturesOfControl: p.natures_of_control,
    notifiedOn: p.notified_on,
  }));
}

function buildContext(state) {
  const apiIdentity = pickApi(state.profile);
  const officersSummary = summarizeOfficers(state.officers);
  const pscSummary = summarizePsc(state.psc);

  const docExtractions = (state.documents || [])
    .filter((d) => d.status === 'processed' && d.extracted)
    .map((d) => ({
      category: d.category,
      date: d.date,
      processedBy: d.processedBy,
      extracted: d.extracted,
    }));

  return JSON.stringify(
    {
      api: {
        identity: apiIdentity,
        officers: officersSummary,
        psc: pscSummary,
      },
      documents: docExtractions,
    },
    null,
    2
  );
}

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function classifyKind(name, kind) {
  if (!kind) return 'individual';
  if (kind.includes('corporate') || kind.includes('legal-person')) return 'corporate';
  if (kind.includes('individual-person')) return 'individual';
  return 'individual';
}

const CORPORATE_NAME_RE = /\b(ltd|limited|plc|llp|inc|incorporated|gmbh|s\.?a\.?|n\.?v\.?|corp(oration)?|company|holdings?|group|trust(ees?)?|nominees?|partners?(hip)?)\b/i;

function titleCaseRole(role) {
  if (!role) return undefined;
  return String(role)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildShareholderGraph(state, kycCard) {
  const companyName = kycCard.identity?.name || state.profile?.company_name || 'Company';
  const companyNumber = kycCard.identity?.companyNumber || state.companyNumber || 'company';

  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const nodeIdByKey = new Map();

  const companyId = `co:${companyNumber}`;
  nodes.push({ data: { id: companyId, label: companyName, kind: 'company' } });
  nodeIds.add(companyId);

  function ensureNode(key, label, kind, preferredId) {
    if (nodeIdByKey.has(key)) return nodeIdByKey.get(key);
    const id = preferredId;
    nodes.push({ data: { id, label, kind } });
    nodeIds.add(id);
    nodeIdByKey.set(key, id);
    return id;
  }

  const seenOwners = new Map();

  const pscItems = state.psc?.items || [];
  for (const p of pscItems) {
    if (!p.name) continue;
    const key = normalizeName(p.name);
    const id = ensureNode(key, p.name, classifyKind(p.name, p.kind), `p:${key}`);
    seenOwners.set(key, { id, source: 'psc', notes: p.natures_of_control });
  }

  for (const sh of kycCard.shareholders || []) {
    if (!sh.name) continue;
    const key = normalizeName(sh.name);
    const existing = seenOwners.get(key);
    if (!existing) {
      const kind = sh.type === 'corporate' ? 'corporate' : 'individual';
      const id = ensureNode(key, sh.name, kind, `s:${key}`);
      seenOwners.set(key, { id, source: 'doc', shareholder: sh });
    } else {
      existing.shareholder = sh;
    }
  }

  let edgeIdx = 0;
  for (const [, owner] of seenOwners) {
    if (!nodeIds.has(owner.id)) continue;
    const sh = owner.shareholder;
    let label;
    if (sh) {
      const parts = [];
      if (sh.percentage != null) parts.push(`${sh.percentage}%`);
      if (sh.shares != null) parts.push(`${sh.shares} shares`);
      if (sh.shareClass) parts.push(sh.shareClass);
      label = parts.join(' · ') || undefined;
    } else if (owner.notes?.length) {
      label = owner.notes.slice(0, 1).join(', ');
    }
    edges.push({
      data: {
        id: `e${edgeIdx++}`,
        source: owner.id,
        target: companyId,
        label,
        rel: 'owns',
      },
    });
  }

  // Officers / directors — active appointments only (resigned officers are dropped).
  const officerItems = state.officers?.items || [];
  for (const o of officerItems) {
    if (!o.name || o.resigned_on) continue;
    const key = normalizeName(o.name);
    const isCorporate = !!o.identification || CORPORATE_NAME_RE.test(o.name);
    const id = ensureNode(key, o.name, isCorporate ? 'corporate' : 'individual', `o:${key}`);
    edges.push({
      data: {
        id: `e${edgeIdx++}`,
        source: id,
        target: companyId,
        label: titleCaseRole(o.officer_role) || 'Officer',
        rel: 'officer',
      },
    });
  }

  return { nodes, edges };
}

function buildSourceTrace(state) {
  // Find the fragment id of the fetch_apis run (one per run) and the per-doc process_documents fragments
  const fragments = state.fragments || [];
  const fetchFragmentId = fragments.find((f) => f.nodeId === 'fetch_apis' && f.status === 'ok')?.id;
  const docFragmentByCategory = {};
  for (const f of fragments) {
    if (f.nodeId === 'process_documents' && f.status === 'ok' && f.inputs?.category) {
      docFragmentByCategory[f.inputs.category] = f.id;
    }
  }

  const apiSource = (kind) => ({ source: 'api', kind, fragmentId: fetchFragmentId });
  const docSource = (category) => ({
    source: 'doc',
    kind: category,
    fragmentId: docFragmentByCategory[category],
  });

  const trace = {};
  if (state.profile) {
    for (const f of [
      'identity.name',
      'identity.companyNumber',
      'identity.type',
      'identity.status',
      'identity.incorporationDate',
      'identity.sicCodes',
      'addresses.registered',
    ]) {
      trace[f] = apiSource('profile');
    }
  }
  if (state.officers?.items?.length) trace.officers = apiSource('officers');
  if (state.psc?.items?.length) trace.psc = apiSource('psc');

  for (const d of state.documents || []) {
    if (d.status !== 'processed' || !d.extracted) continue;
    if (d.category === 'confirmation-statement' && d.extracted.shareholders?.length) {
      trace.shareholders = docSource('confirmation-statement');
    }
    if (d.category === 'accounts' && d.extracted.periodEnd) {
      trace.financials = docSource('accounts');
    }
  }
  return trace;
}

function summarizeDocs(state) {
  return (state.documents || []).map((d) => ({
    category: d.category,
    date: d.date,
    transactionId: d.transactionId,
    documentId: d.documentId,
    processedBy: d.processedBy,
    // X1 — truncation surfacing for the UI.
    truncated: d.truncated,
    pagesProcessed: d.pagesProcessed,
    pagesTotal: d.pagesTotal,
  }));
}

function fillRegisteredAddress(card, profile) {
  if (card.addresses?.registered) return;
  const a = profile?.registered_office_address;
  if (!a) return;
  const parts = [a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code, a.country]
    .filter(Boolean)
    .join(', ');
  if (parts) {
    card.addresses = card.addresses || {};
    card.addresses.registered = parts;
  }
}

// Companies House is the UK registry — every company it returns is UK-incorporated.
// Country of incorporation is a critical KYC field, so always populate it; default
// to "United Kingdom" since the data originated from Companies House.
function fillCountryOfIncorporation(card) {
  card.identity = card.identity || {};
  if (!card.identity.countryOfIncorporation) {
    card.identity.countryOfIncorporation = 'United Kingdom';
  }
}

// Prompt-injection defence: identity, officers, and psc are sourced from the
// Companies House API — never from documents. Document text is fed to the LLM
// alongside API data, so a poisoned PDF could otherwise persuade the model to
// rewrite an officer name or company number. After the LLM returns, overwrite
// these fields from `state.profile/officers/psc` directly so the API stays
// authoritative even under adversarial input. Shareholders / financials /
// redFlags remain LLM-shaped — those genuinely come from documents.
function overrideFromApi(card, state) {
  const profile = state.profile || {};
  card.identity = {
    name: profile.company_name ?? card.identity?.name,
    companyNumber: profile.company_number ?? card.identity?.companyNumber,
    type: profile.type ?? card.identity?.type,
    status: profile.company_status ?? card.identity?.status,
    incorporationDate: profile.date_of_creation ?? card.identity?.incorporationDate,
    countryOfIncorporation: card.identity?.countryOfIncorporation,
    sicCodes: profile.sic_codes ?? card.identity?.sicCodes,
  };
  card.officers = summarizeOfficers(state.officers);
  card.psc = summarizePsc(state.psc);
}

// R6 — re-attach extraction honesty flags after the LLM merge. The synthesis
// schema doesn't carry provenance/confidence, so the model drops them; restore
// them from the pre-merge document extractions by normalized-name match (the
// same re-assertion pattern overrideFromApi uses). Officers/PSC/identity are
// API-sourced by construction and don't need flags.
function reattachExtractionFlags(card, state) {
  const flagsByName = new Map();
  for (const d of state.documents || []) {
    if (d.status !== 'processed' || !d.extracted) continue;
    const records = [
      ...(d.extracted.shareholders || []),
      ...(d.extracted.initialSubscribers || []),
    ];
    for (const rec of records) {
      if (!rec?.name) continue;
      flagsByName.set(normalizeName(rec.name), {
        provenance: rec.provenance ?? d.processedBy,
        confidence: rec.confidence,
      });
    }
  }
  for (const sh of card.shareholders || []) {
    const flags = flagsByName.get(normalizeName(sh.name));
    if (flags) {
      if (flags.provenance) sh.provenance = flags.provenance;
      if (flags.confidence) sh.confidence = flags.confidence;
    }
  }
  // Financials come from the accounts extraction (scalar record — flags live
  // at the top level of the extracted object).
  if (card.financials) {
    const accounts = (state.documents || []).find(
      (d) => d.category === 'accounts' && d.status === 'processed' && d.extracted,
    );
    if (accounts) {
      card.financials.provenance = accounts.extracted.provenance ?? accounts.processedBy;
      if (accounts.extracted.confidence) card.financials.confidence = accounts.extracted.confidence;
    }
  }
}

const synthesizeCard = withFragment('synthesize_card', async function synthesizeCard(state) {
  if (!state.profile) {
    return {
      trace: [traceEvent('synthesize_card', 'no profile, skipping')],
      errors: [errorEvent('synthesize_card', 'profile missing from state')],
      __fragment: {
        status: 'failed',
        summary: 'Cannot synthesize KYC card — profile missing from state',
        error: 'profile missing',
      },
    };
  }

  try {
    const context = buildContext(state);
    const synthesisPrompt = await loadPrompt('kyc.synthesis');
    const card = await extractStructured(context, SYNTHESIS_SCHEMA, synthesisPrompt);

    fillRegisteredAddress(card, state.profile);
    fillCountryOfIncorporation(card);
    overrideFromApi(card, state);
    reattachExtractionFlags(card, state);

    // Surface document-pipeline failures as red flags. A partial-failure run
    // (e.g. confirmation statement OCR died) used to produce an empty
    // shareholder list with no visible warning. The reviewer needs to see that
    // the absence of shareholders may reflect a missing input, not a real-world
    // absence of shareholders. See CODE_REVIEW §4.3.
    const failedDocs = (state.documents || []).filter((d) => d.status === 'failed');
    if (failedDocs.length) {
      const cats = [...new Set(failedDocs.map((d) => d.category))].join(', ');
      card.redFlags = [
        ...(card.redFlags || []),
        `Document processing failed for: ${cats}. Downstream extraction (shareholders / financials / subscribers) may be incomplete.`,
      ];
    }

    // X1 — OCR truncation is a correctness-of-omission risk distinct from a
    // failed document: the output LOOKS complete. One red flag per truncated
    // doc, with the page counts, so "shareholders dropped" is never silently
    // read as "shareholders absent".
    for (const d of (state.documents || []).filter((doc) => doc.truncated)) {
      card.redFlags = [
        ...(card.redFlags || []),
        `OCR truncated: processed ${d.pagesProcessed ?? '?'} of ${d.pagesTotal ?? '?'} pages of the ${d.category} — extracted lists (shareholders / subscribers) may be incomplete.`,
      ];
    }

    const docs = summarizeDocs(state);
    const sourceTrace = buildSourceTrace(state);
    const fullCard = { ...card, documents: docs, sourceTrace };

    const shareholderGraph = buildShareholderGraph(state, fullCard);

    return {
      kycCard: fullCard,
      shareholderGraph,
      trace: [
        traceEvent('synthesize_card', 'kyc card synthesized', {
          shareholders: fullCard.shareholders?.length || 0,
          officers: fullCard.officers?.length || 0,
          psc: fullCard.psc?.length || 0,
          graphNodes: shareholderGraph.nodes.length,
          graphEdges: shareholderGraph.edges.length,
        }),
      ],
      __fragment: {
        summary: `KYC card built — ${fullCard.officers?.length || 0} officer(s), ${fullCard.psc?.length || 0} PSC(s), ${fullCard.shareholders?.length || 0} shareholder(s); ${fullCard.redFlags?.length || 0} red flag(s)`,
        inputs: {
          hasProfile: !!state.profile,
          officersFromApi: state.officers?.items?.length || 0,
          pscFromApi: state.psc?.items?.length || 0,
          processedDocs: (state.documents || []).filter((d) => d.status === 'processed').length,
        },
        outputs: {
          identity: fullCard.identity,
          counts: {
            officers: fullCard.officers?.length || 0,
            psc: fullCard.psc?.length || 0,
            shareholders: fullCard.shareholders?.length || 0,
            redFlags: fullCard.redFlags?.length || 0,
          },
          graph: {
            nodes: shareholderGraph.nodes.length,
            edges: shareholderGraph.edges.length,
          },
          redFlags: fullCard.redFlags || [],
        },
      },
    };
  } catch (err) {
    return {
      trace: [traceEvent('synthesize_card', `failed: ${err.message}`)],
      errors: [errorEvent('synthesize_card', err.message)],
      __fragment: {
        status: 'failed',
        summary: `KYC card synthesis failed: ${err.message}`,
        error: err.message,
      },
    };
  }
});

module.exports = {
  synthesizeCard,
  buildShareholderGraph,
  // Exported for extraction-confidence-smoke (pure, no I/O).
  _reattachExtractionFlags: reattachExtractionFlags,
};
