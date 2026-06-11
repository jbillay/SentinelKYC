// Phase 3 — data comes through the registry port (services/registry):
// Companies House base + configured enrichment vendors. Enriched records
// carry `_vendorAttribution` (field → vendorId); surfaced on the fragment.
const registry = require('../../services/registry');
const { traceEvent, errorEvent } = require('../state');
const { withFragment } = require('../fragments');

const fetchApis = withFragment('fetch_apis', async function fetchApis(state, config) {
  const { companyNumber } = state;
  const forceFresh = !!config?.configurable?.forceFresh;

  if (!companyNumber) {
    return {
      errors: [errorEvent('fetch_apis', 'no companyNumber in state')],
      trace: [traceEvent('fetch_apis', 'skipped — no companyNumber')],
      __fragment: {
        status: 'skipped',
        summary: 'Skipped — no companyNumber in state',
      },
    };
  }

  const started = Date.now();

  const [profileRes, officersRes, pscRes, filingsRes] = await Promise.allSettled([
    registry.getProfile(companyNumber, { forceFresh }),
    registry.getOfficers(companyNumber, { forceFresh }),
    registry.getOwnership(companyNumber, { forceFresh }),
    registry.getFilings(companyNumber, 100, { forceFresh }),
  ]);

  const update = {};
  const errors = [];
  const extra = {};

  if (profileRes.status === 'fulfilled') {
    update.profile = profileRes.value;
    extra.profile = profileRes.value ? 'ok' : 'not_found';
  } else {
    errors.push(errorEvent('fetch_apis', `profile: ${profileRes.reason?.message}`));
    extra.profile = 'error';
  }

  if (officersRes.status === 'fulfilled') {
    update.officers = officersRes.value;
    extra.officers = officersRes.value ? `ok (${officersRes.value.items?.length ?? 0})` : 'not_found';
  } else {
    errors.push(errorEvent('fetch_apis', `officers: ${officersRes.reason?.message}`));
    extra.officers = 'error';
  }

  if (pscRes.status === 'fulfilled') {
    update.psc = pscRes.value;
    extra.psc = pscRes.value ? `ok (${pscRes.value.items?.length ?? 0})` : 'not_found';
  } else {
    errors.push(errorEvent('fetch_apis', `psc: ${pscRes.reason?.message}`));
    extra.psc = 'error';
  }

  if (filingsRes.status === 'fulfilled') {
    update.filingHistory = filingsRes.value;
    extra.filings = filingsRes.value ? `ok (${filingsRes.value.items?.length ?? 0})` : 'not_found';
  } else {
    errors.push(errorEvent('fetch_apis', `filing-history: ${filingsRes.reason?.message}`));
    extra.filings = 'error';
  }

  const ms = Date.now() - started;
  const profileMissing = profileRes.status === 'fulfilled' && profileRes.value == null;

  const officersCount = update.officers?.items?.length ?? 0;
  const pscCount = update.psc?.items?.length ?? 0;
  const filingsCount = update.filingHistory?.items?.length ?? 0;

  if (profileMissing) {
    update.resolution = {
      ...(state.resolution || {}),
      status: 'not_found',
      reason: `company ${companyNumber} not found in Companies House`,
    };
    update.trace = [
      traceEvent('fetch_apis', `company ${companyNumber} not found`, {
        ...extra,
        companyNumber,
        ms,
      }),
    ];
    update.__fragment = {
      status: 'failed',
      summary: `Company ${companyNumber} disappeared from Companies House between confirmation and fetch`,
      inputs: { companyNumber },
      outputs: { profile: null, ms },
    };
  } else {
    // Per-endpoint failures (officers/psc/filings 5xx) used to be swallowed
    // silently — the fragment landed green and downstream screening ran on a
    // half-empty subject list. Mark the fragment failed when any non-profile
    // endpoint errored and surface a short note in the summary so the trail
    // makes the gap visible. See CODE_REVIEW §4.3.
    const failedEndpoints = Object.entries(extra)
      .filter(([k, v]) => k !== 'profile' && v === 'error')
      .map(([k]) => k);
    const fragStatus = failedEndpoints.length ? 'failed' : 'ok';
    const summary = failedEndpoints.length
      ? `Fetched profile in ${ms}ms — ${officersCount} officer(s), ${pscCount} PSC(s), ${filingsCount} filing(s); ${failedEndpoints.join(', ')} failed`
      : `Fetched 4 Companies House endpoints in ${ms}ms — ${officersCount} officer(s), ${pscCount} PSC(s), ${filingsCount} filing(s)`;
    update.trace = [
      traceEvent('fetch_apis', `fetched 4 endpoints in ${ms}ms`, { ...extra, companyNumber }),
    ];
    // Per-field vendor attribution from the enrichment merge — part of the
    // audit trail: a reviewer can see exactly which vendor supplied what.
    const attribution = {};
    for (const [key, rec] of Object.entries({ profile: update.profile, officers: update.officers, psc: update.psc })) {
      if (rec?._vendorAttribution) attribution[key] = rec._vendorAttribution;
    }
    update.__fragment = {
      status: fragStatus,
      summary,
      inputs: { companyNumber },
      outputs: {
        ms,
        officers: officersCount,
        psc: pscCount,
        filings: filingsCount,
        endpoints: extra,
        failedEndpoints,
        ...(Object.keys(attribution).length ? { vendorAttribution: attribution } : {}),
      },
    };
  }

  if (errors.length) update.errors = errors;

  return update;
});

module.exports = { fetchApis };
