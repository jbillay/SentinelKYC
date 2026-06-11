// GDELT 2.0 DOC API client — the adverse-media news provider.
//
// Replaces the retired Bing News v7 API. The GDELT DOC API is free, requires
// no API key, and indexes global online news. We query the article list
// (mode=ArtList, format=JSON) for "<name>" AND a curated risk-term OR group,
// most-recent-first, over a rolling window (GDELT_TIMESPAN, default 12 months).
//
// Caveats vs the old Bing client:
//   - ArtList returns headlines only — no article snippet/description. `snippet`
//     is therefore always ''. The LLM evaluator judges from title + source
//     domain + date (the evaluate_adverse_media prompt is aware of this).
//   - Results are not language-filtered (GDELT spans ~65 languages); the LLM
//     evaluator dismisses off-context articles.
//   - GDELT returns plain-text errors (e.g. "query was too short") with HTTP
//     200; we detect a non-JSON body and throw, which the screening node
//     catches per-subject.
//
// GDELT enforces a hard public rate limit — "one request every 5 seconds" (it
// answers with HTTP 429 + that message otherwise). So the in-process semaphore
// is strictly serial (1 concurrent) with a 5s minimum spacing between request
// starts. Combined with the per-ISO-week cache in ./cache.js this keeps us
// well-behaved; the per-subject error handling in the screening node absorbs
// the occasional 429 anyway.
//
// Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/

const metrics = require('../metrics');

const DEFAULT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const DEFAULT_TIMESPAN = '12m';
const RISK_TERMS =
  '("money laundering" OR sanction OR sanctions OR fraud OR corruption OR bribery OR embezzlement OR investigation OR indicted OR convicted OR fined OR "regulatory action")';
const USER_AGENT = 'CompanyCardPOC-KYC/1.0 (adverse-media screening)';

let active = 0;
const queue = [];
const MAX_CONCURRENT = 1;
// GDELT's documented limit is "one request every 5 seconds". In practice we
// still see occasional 429s at 5500ms — GDELT meters by request-arrival time
// at their edge, and network jitter routinely eats >500ms, so spacing from
// our process clock under-counts the gap their counter sees. 6000ms gives a
// 1s safety margin; combined with the on-429 retries below the failure rate
// is low enough that the screening node can soft-skip persistent cases.
const MIN_SPACING_MS = 6000;
// On HTTP 429 we sleep without re-acquiring the semaphore (we already own it
// for this request, so other callers continue to wait normally) and retry up
// to twice with increasing backoff. Two retries is enough — beyond that the
// screening node soft-skips the subject (err.code === 'GDELT_RATE_LIMITED')
// rather than surfacing it as a non-fatal error.
const RETRY_429_DELAYS_MS = [6500, 12000];
// Network-level failures (DNS, TCP reset, TLS, connect timeout) come back as
// Node's bare-bones `TypeError: fetch failed` with the real reason buried on
// err.cause. Two short retries cover transient hiccups; persistent failures
// surface with err.cause.code in the message so we can actually diagnose them.
const RETRY_NETWORK_DELAYS_MS = [800, 2500];
let lastStartTs = 0;

function networkErrorMessage(err) {
  const code = err?.cause?.code || err?.cause?.errno || null;
  if (code) return `fetch failed (${code})`;
  return err?.message ? `fetch failed: ${err.message}` : 'fetch failed';
}

async function fetchWithNetworkRetry(url, init) {
  let lastErr = null;
  const attempts = [0, ...RETRY_NETWORK_DELAYS_MS];
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) {
      await new Promise((r) => setTimeout(r, attempts[i]));
    }
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      return { res, text };
    } catch (err) {
      lastErr = err;
      // Continue to the next backoff. Only network-level failures (no HTTP
      // response received) end up in this catch — HTTP errors come back via
      // a non-ok res.
    }
  }
  const wrapped = new Error(networkErrorMessage(lastErr));
  wrapped.code = 'GDELT_FETCH_FAILED';
  wrapped.cause = lastErr?.cause || lastErr;
  throw wrapped;
}

function acquire() {
  return new Promise((resolve) => {
    const tryRun = () => {
      if (active >= MAX_CONCURRENT) return;
      const since = Date.now() - lastStartTs;
      if (since < MIN_SPACING_MS) {
        setTimeout(tryRun, MIN_SPACING_MS - since);
        return;
      }
      active += 1;
      lastStartTs = Date.now();
      resolve(release);
    };
    queue.push(tryRun);
    drain();
  });
}

function release() {
  active = Math.max(0, active - 1);
  drain();
}

function drain() {
  while (queue.length && active < MAX_CONCURRENT) {
    const next = queue.shift();
    next();
  }
}

function buildQuery(name) {
  // Quote the name to keep it as a phrase; GDELT ANDs it with the risk group.
  // Strip characters the GDELT query parser treats specially.
  const safeName = String(name).replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim();
  return `"${safeName}" ${RISK_TERMS}`;
}

function parseSeenDate(s) {
  // GDELT seendate looks like "20240115T123000Z" → ISO-8601.
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
}

function normalizeArticle(item) {
  return {
    title: item.title || '',
    snippet: '', // GDELT ArtList provides no description.
    url: item.url || '',
    publishedAt: parseSeenDate(item.seendate),
    source: item.domain || null,
  };
}

async function searchGdelt(name, opts = {}) {
  const endpoint = process.env.GDELT_DOC_ENDPOINT || DEFAULT_ENDPOINT;
  const timespan = process.env.GDELT_TIMESPAN || DEFAULT_TIMESPAN;
  const count = Math.min(250, Math.max(1, opts.count || 20));
  const query = buildQuery(name);

  const url = new URL(endpoint);
  url.searchParams.set('query', query);
  url.searchParams.set('mode', 'ArtList');
  url.searchParams.set('format', 'json');
  url.searchParams.set('maxrecords', String(count));
  url.searchParams.set('timespan', timespan);
  url.searchParams.set('sort', 'DateDesc');

  const init = {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  };

  const release = await acquire();
  try {
    metrics.inc('gdelt_request_total');
    let { res, text } = await fetchWithNetworkRetry(url, init);

    // Up to two retries on 429 with increasing backoff. Sleep longer than the
    // spacing window so GDELT's rate-limit counter rolls over, then re-issue
    // the same request. We keep the semaphore held throughout — extending our
    // own occupancy is the whole point: pushing the next caller further out
    // too. After both retries fail we throw with code GDELT_RATE_LIMITED so
    // the screening node can soft-skip the subject (not a non-fatal error).
    if (res.status === 429) {
      for (const delay of RETRY_429_DELAYS_MS) {
        lastStartTs = Date.now() + delay;
        await new Promise((r) => setTimeout(r, delay));
        ({ res, text } = await fetchWithNetworkRetry(url, init));
        if (res.status !== 429) break;
      }
    }

    if (res.status === 429) {
      metrics.inc('gdelt_rate_limited_total');
      const err = new Error('GDELT rate-limited after retries');
      err.status = 429;
      err.code = 'GDELT_RATE_LIMITED';
      throw err;
    }

    if (!res.ok) {
      const err = new Error(`GDELT ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // Soft errors (too-short / too-broad query) come back as plain text + 200.
      const msg = text.trim().slice(0, 200) || 'non-JSON response';
      const err = new Error(`GDELT: ${msg}`);
      err.code = 'GDELT_BAD_RESPONSE';
      throw err;
    }
    const items = Array.isArray(json.articles) ? json.articles : [];
    return items.map(normalizeArticle);
  } finally {
    release();
  }
}

module.exports = { searchGdelt, buildQuery, normalizeArticle, parseSeenDate };
