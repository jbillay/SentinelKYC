// OFAC SDN Enhanced XML download.
// Public URL — no API key required.
const { iterEntries } = require('../parsers/ofac_xml');

const SDN_ENHANCED_URL =
  process.env.OFAC_SDN_ENHANCED_URL ||
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ENHANCED.XML';

const SOURCE_ID = 'ofac_sdn';

async function download() {
  const res = await fetch(SDN_ENHANCED_URL, {
    headers: { Accept: 'application/xml,text/xml,*/*' },
  });
  if (!res.ok) {
    throw new Error(`ofac: download failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return { text, fetchedAt: new Date() };
}

function deriveVersion(xmlText, fetchedAt) {
  // The enhanced XML carries a Publish_Date; if we can sniff it, use as version.
  const m = xmlText.match(/<Publish_Date>([^<]+)<\/Publish_Date>/i);
  if (m && m[1]) return m[1].trim();
  return fetchedAt.toISOString();
}

async function* fetchEntries() {
  const { text, fetchedAt } = await download();
  const version = deriveVersion(text, fetchedAt);
  yield { __meta: { source: SOURCE_ID, version, fetchedAt } };
  for (const entry of iterEntries(text)) {
    yield entry;
  }
}

module.exports = { fetchEntries, SOURCE_ID };
