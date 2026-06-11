// Client-side country / nationality helpers for the party identity card.
//
// Companies House stores nationality as a demonym ("British", "Irish") and
// country fields as names ("United Kingdom", "United States"). flag-icons
// keys on lowercase ISO-3166-1 alpha-2 codes (`fi-gb`, `fi-us`), so we map
// both forms to ISO-2. Unknowns resolve to null → the flag component shows a
// neutral globe glyph and just the text. This is a pragmatic, offline map —
// not exhaustive, but covers the nationalities/countries that actually turn
// up in UK KYC data.

function normKey(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
}

// Nationality demonym → ISO-2.
const DEMONYM_TO_ISO2 = {
  british: 'gb', english: 'gb', scottish: 'gb', welsh: 'gb', 'northern irish': 'gb',
  irish: 'ie', american: 'us', canadian: 'ca', mexican: 'mx', brazilian: 'br',
  argentine: 'ar', argentinian: 'ar', chilean: 'cl', colombian: 'co', peruvian: 'pe',
  french: 'fr', german: 'de', italian: 'it', spanish: 'es', portuguese: 'pt',
  dutch: 'nl', belgian: 'be', luxembourgish: 'lu', swiss: 'ch', austrian: 'at',
  danish: 'dk', swedish: 'se', norwegian: 'no', finnish: 'fi', icelandic: 'is',
  polish: 'pl', czech: 'cz', slovak: 'sk', hungarian: 'hu', romanian: 'ro',
  bulgarian: 'bg', greek: 'gr', croatian: 'hr', slovenian: 'si', serbian: 'rs',
  ukrainian: 'ua', russian: 'ru', estonian: 'ee', latvian: 'lv', lithuanian: 'lt',
  turkish: 'tr', cypriot: 'cy', maltese: 'mt', israeli: 'il', lebanese: 'lb',
  egyptian: 'eg', moroccan: 'ma', algerian: 'dz', tunisian: 'tn', 'south african': 'za',
  nigerian: 'ng', ghanaian: 'gh', kenyan: 'ke', ethiopian: 'et', ugandan: 'ug',
  emirati: 'ae', saudi: 'sa', qatari: 'qa', kuwaiti: 'kw', bahraini: 'bh', omani: 'om',
  indian: 'in', pakistani: 'pk', bangladeshi: 'bd', 'sri lankan': 'lk', nepalese: 'np',
  chinese: 'cn', 'hong kong': 'hk', taiwanese: 'tw', japanese: 'jp', korean: 'kr',
  'south korean': 'kr', vietnamese: 'vn', thai: 'th', filipino: 'ph', malaysian: 'my',
  singaporean: 'sg', indonesian: 'id', australian: 'au', 'new zealander': 'nz', 'new zealand': 'nz',
}

// Country name / alias → ISO-2.
const COUNTRY_TO_ISO2 = {
  'united kingdom': 'gb', 'united kingdom of great britain and northern ireland': 'gb',
  'great britain': 'gb', britain: 'gb', uk: 'gb', 'u.k': 'gb', gb: 'gb', gbr: 'gb',
  england: 'gb', scotland: 'gb', wales: 'gb', 'northern ireland': 'gb',
  ireland: 'ie', 'republic of ireland': 'ie', eire: 'ie',
  'united states': 'us', 'united states of america': 'us', usa: 'us', 'u.s.a': 'us',
  'u.s': 'us', us: 'us', america: 'us',
  canada: 'ca', mexico: 'mx', brazil: 'br', argentina: 'ar', chile: 'cl',
  colombia: 'co', peru: 'pe', venezuela: 've', uruguay: 'uy', panama: 'pa',
  france: 'fr', germany: 'de', italy: 'it', spain: 'es', portugal: 'pt',
  netherlands: 'nl', 'the netherlands': 'nl', holland: 'nl', belgium: 'be',
  luxembourg: 'lu', switzerland: 'ch', austria: 'at', denmark: 'dk', sweden: 'se',
  norway: 'no', finland: 'fi', iceland: 'is', poland: 'pl', 'czech republic': 'cz',
  czechia: 'cz', slovakia: 'sk', hungary: 'hu', romania: 'ro', bulgaria: 'bg',
  greece: 'gr', croatia: 'hr', slovenia: 'si', serbia: 'rs', ukraine: 'ua',
  russia: 'ru', 'russian federation': 'ru', estonia: 'ee', latvia: 'lv',
  lithuania: 'lt', turkey: 'tr', 'türkiye': 'tr', cyprus: 'cy', malta: 'mt',
  israel: 'il', lebanon: 'lb', 'united arab emirates': 'ae', uae: 'ae',
  'saudi arabia': 'sa', qatar: 'qa', kuwait: 'kw', bahrain: 'bh', oman: 'om',
  egypt: 'eg', morocco: 'ma', algeria: 'dz', tunisia: 'tn', 'south africa': 'za',
  nigeria: 'ng', ghana: 'gh', kenya: 'ke', ethiopia: 'et', uganda: 'ug',
  india: 'in', pakistan: 'pk', bangladesh: 'bd', 'sri lanka': 'lk', nepal: 'np',
  china: 'cn', 'hong kong': 'hk', taiwan: 'tw', japan: 'jp',
  'south korea': 'kr', 'korea, republic of': 'kr', vietnam: 'vn', thailand: 'th',
  philippines: 'ph', malaysia: 'my', singapore: 'sg', indonesia: 'id',
  australia: 'au', 'new zealand': 'nz',
  jersey: 'je', guernsey: 'gg', 'isle of man': 'im', gibraltar: 'gi',
  'cayman islands': 'ky', bermuda: 'bm', 'british virgin islands': 'vg',
  'virgin islands, british': 'vg', 'channel islands': 'je',
  luxemburg: 'lu',
}

function looksLikeIso2(key) {
  return /^[a-z]{2}$/.test(key)
}

// Nationality demonym → lowercase ISO-2 (or null).
export function nationalityIso2(raw) {
  const key = normKey(raw)
  if (!key) return null
  if (DEMONYM_TO_ISO2[key]) return DEMONYM_TO_ISO2[key]
  if (COUNTRY_TO_ISO2[key]) return COUNTRY_TO_ISO2[key]
  if (looksLikeIso2(key)) return key
  return null
}

// Country name → lowercase ISO-2 (or null).
export function countryIso2(raw) {
  const key = normKey(raw)
  if (!key) return null
  if (COUNTRY_TO_ISO2[key]) return COUNTRY_TO_ISO2[key]
  if (DEMONYM_TO_ISO2[key]) return DEMONYM_TO_ISO2[key]
  if (looksLikeIso2(key)) return key
  return null
}

// Approximate age from a year (+ optional month). Month-precision data means
// the result can be off by at most a few months around a birthday, so it's
// "as of this month". Returns null for missing/implausible years.
export function calcAge(year, month) {
  const y = Number(year)
  if (!y || y < 1900 || y > new Date().getFullYear()) return null
  const now = new Date()
  let age = now.getFullYear() - y
  const m = Number(month)
  if (m >= 1 && m <= 12) {
    // Birthday this year hasn't happened yet if the birth month is later.
    if (now.getMonth() + 1 < m) age -= 1
  }
  return age >= 0 && age < 130 ? age : null
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// "April 1962" / "1962" depending on what's known.
export function formatDob(year, month) {
  const y = Number(year)
  if (!y) return null
  const m = Number(month)
  if (m >= 1 && m <= 12) return `${MONTHS[m - 1]} ${y}`
  return String(y)
}
