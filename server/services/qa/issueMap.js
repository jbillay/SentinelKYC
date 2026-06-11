// Phase 5 / Q2 — issue-code → UI metadata map.
//
// Severity drives banner colour priority; anchor is the id of the
// matching section on DossierViewPage so the highlight chip can deep-link.
// Codes that aren't in the map fall back to a sensible default so a new
// check added without an entry here still renders.

const ISSUE_MAP = {
  // completeness — missing fields
  registry_record: {
    severity: 'high',
    message: 'Registry record is missing — Companies House profile was not captured.',
    anchor: '#identity',
  },
  ubo_list_empty: {
    severity: 'medium',
    message: 'No ultimate beneficial owners were identified.',
    anchor: '#identity',
  },
  screening_results: {
    severity: 'high',
    message: 'Screening report is missing — sanctions / adverse-media checks did not run.',
    anchor: '#screening',
  },
  risk_score: {
    severity: 'high',
    message: 'Risk score is missing — risk assessment did not complete.',
    anchor: '#risk',
  },
  risk_narrative: {
    severity: 'medium',
    message: 'Risk rationale is missing — the assessment has no narrative.',
    anchor: '#risk',
  },

  // completeness — soft warnings
  document_status: {
    severity: 'low',
    message: 'One or more filings failed to extract.',
    anchor: '#documents',
  },

  // consistency
  ubo_not_screened: {
    severity: 'high',
    message: 'One or more UBOs are not present in the screening results.',
    anchor: '#screening',
  },
  tier_too_low_for_sanction_hit: {
    severity: 'high',
    message: 'Confirmed sanctions hit but risk tier is not High.',
    anchor: '#risk',
  },
  tier_too_low_for_knockout: {
    severity: 'high',
    message: 'Screening knockout was triggered but risk tier is not High.',
    anchor: '#risk',
  },
  status_contradiction_registry: {
    severity: 'medium',
    message: 'Registry company status disagrees with the KYC card identity status.',
    anchor: '#identity',
  },
  status_contradiction_document: {
    severity: 'high',
    message: 'A filing implies the company is dissolved, but the registry shows active.',
    anchor: '#documents',
  },
};

function describe(code) {
  if (!code) return null;
  // Match the `document_status:<category>:failed` warning prefix.
  if (code.startsWith('document_status:')) {
    const parts = code.split(':');
    const category = parts[1] || 'document';
    return {
      ...ISSUE_MAP.document_status,
      message: `Filing "${category}" failed to extract.`,
    };
  }
  return ISSUE_MAP[code] || {
    severity: 'medium',
    message: code,
    anchor: '#identity',
  };
}

// Build the UI-ready highlightedIssues array from raw check output.
function buildHighlightedIssues({ missing = [], warnings = [], issues = [] } = {}) {
  const out = [];
  for (const code of missing) {
    const desc = describe(code);
    out.push({ code, severity: desc.severity, message: desc.message, anchor: desc.anchor });
  }
  for (const code of warnings) {
    const desc = describe(code);
    out.push({ code, severity: desc.severity, message: desc.message, anchor: desc.anchor });
  }
  for (const it of issues) {
    const desc = describe(it.code);
    out.push({
      code: it.code,
      severity: desc.severity,
      message: it.message || desc.message,
      anchor: desc.anchor,
      evidence: it.evidence,
    });
  }
  return out;
}

module.exports = {
  ISSUE_MAP,
  describe,
  buildHighlightedIssues,
};
