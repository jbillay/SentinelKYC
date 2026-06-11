// UK HMT (OFSI) Consolidated List — CSV download.
// Public URL — no API key required.
const { iterEntries } = require('../parsers/uk_hmt_csv');

const HMT_CSV_URL =
  process.env.UK_HMT_CSV_URL ||
  'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv';

const SOURCE_ID = 'uk_hmt';

async function download() {
  const res = await fetch(HMT_CSV_URL, {
    headers: { Accept: 'text/csv,*/*' },
  });
  if (!res.ok) {
    throw new Error(`uk_hmt: download failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return { text, fetchedAt: new Date() };
}

async function* fetchEntries() {
  const { text, fetchedAt } = await download();
  // HMT CSV has no embedded version; use fetched_at.
  const version = fetchedAt.toISOString();
  yield { __meta: { source: SOURCE_ID, version, fetchedAt } };
  for (const entry of iterEntries(text)) {
    yield entry;
  }
}

module.exports = { fetchEntries, SOURCE_ID };
