const ch = require('../../services/ch');
const { traceEvent, errorEvent } = require('../state');
const { withFragment } = require('../fragments');

function mapSearchHit(hit, idx) {
  return {
    companyNumber: hit.company_number,
    title: hit.title,
    address: hit.address_snippet,
    postcode: hit.address?.postal_code,
    status: hit.company_status,
    incorporationDate: hit.date_of_creation,
    sicCodes: hit.sic_codes,
    type: hit.company_type,
    apiRank: idx,
    score: 0,
  };
}

function profileToCandidate(profile) {
  return {
    companyNumber: profile.company_number,
    title: profile.company_name,
    address: [
      profile.registered_office_address?.address_line_1,
      profile.registered_office_address?.locality,
      profile.registered_office_address?.postal_code,
    ]
      .filter(Boolean)
      .join(', '),
    postcode: profile.registered_office_address?.postal_code,
    status: profile.company_status,
    incorporationDate: profile.date_of_creation,
    sicCodes: profile.sic_codes,
    type: profile.type,
    apiRank: 0,
    score: 0,
  };
}

const searchCh = withFragment('search_ch', async function searchCh(state, config) {
  const { input } = state;
  const forceFresh = !!config?.configurable?.forceFresh;

  if (input.companyNumber) {
    try {
      const profile = await ch.getProfile(input.companyNumber, { forceFresh });
      if (!profile) {
        return {
          candidates: [],
          resolution: {
            status: 'not_found',
            reason: `company ${input.companyNumber} not found in Companies House`,
          },
          trace: [
            traceEvent('search_ch', 'company number not found', {
              companyNumber: input.companyNumber,
            }),
          ],
          __fragment: {
            status: 'failed',
            summary: `Company number ${input.companyNumber} not found in Companies House`,
            inputs: { companyNumber: input.companyNumber },
            outputs: { found: false },
          },
        };
      }
      const candidate = profileToCandidate(profile);
      return {
        candidates: [candidate],
        trace: [
          traceEvent('search_ch', 'resolved by company number', {
            companyNumber: candidate.companyNumber,
          }),
        ],
        __fragment: {
          summary: `Resolved directly by company number ${candidate.companyNumber} → ${candidate.title}`,
          inputs: { companyNumber: input.companyNumber },
          outputs: { candidates: 1, title: candidate.title },
        },
      };
    } catch (err) {
      return {
        candidates: [],
        errors: [errorEvent('search_ch', err.message)],
        trace: [traceEvent('search_ch', 'profile lookup failed')],
        __fragment: {
          status: 'failed',
          summary: `Profile lookup failed: ${err.message}`,
          error: err.message,
          inputs: { companyNumber: input.companyNumber },
        },
      };
    }
  }

  if (!input.name) {
    return {
      candidates: [],
      trace: [traceEvent('search_ch', 'no name and no company number')],
      __fragment: {
        status: 'skipped',
        summary: 'No name or company number provided — search skipped',
      },
    };
  }

  try {
    const result = await ch.searchCompanies(input.name, 20, { forceFresh });
    const items = (result?.items || []).map(mapSearchHit);
    return {
      candidates: items,
      trace: [
        traceEvent('search_ch', `found ${items.length} candidates`, {
          query: input.name,
        }),
      ],
      __fragment: {
        summary: `Companies House search for "${input.name}" returned ${items.length} candidate(s)`,
        inputs: { name: input.name },
        outputs: { candidates: items.length, top: items.slice(0, 3).map((c) => ({ companyNumber: c.companyNumber, title: c.title })) },
      },
    };
  } catch (err) {
    return {
      candidates: [],
      errors: [errorEvent('search_ch', err.message)],
      trace: [traceEvent('search_ch', 'search failed')],
      __fragment: {
        status: 'failed',
        summary: `Search failed: ${err.message}`,
        error: err.message,
        inputs: { name: input.name },
      },
    };
  }
});

module.exports = { searchCh };
