<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  card: { type: Object, required: true },
  // Phase 4 — list of parties linked to this dossier (passed by
  // DossierViewPage after fetching /api/parties?dossier_id=...). Each
  // party carries `linked_dossier_count` so we can render a "Also in N
  // other dossiers" chip on each officer/PSC row.
  parties: { type: Array, default: () => [] },
})

// Build a lookup: token-sorted lowercase name → party. The matcher's
// name_canonical column is exactly this (sorted, lowercased), so it's the
// most stable join key between the un-canonicalised name in the KYC card
// and the party master row.
function tokenKey(name) {
  if (!name) return ''
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

const partyByName = computed(() => {
  const m = new Map()
  for (const p of props.parties || []) {
    if (p?.name_canonical) m.set(p.name_canonical, p)
    if (p?.full_name) m.set(tokenKey(p.full_name), p)
  }
  return m
})

function partyFor(name) {
  return partyByName.value.get(tokenKey(name)) || null
}

// Returns N-1 because the chip's wording is "also in N OTHER dossiers" —
// excluding the dossier currently being viewed. Null when this party has
// no cross-dossier presence (or no party row at all).
function otherDossierCount(name) {
  const p = partyFor(name)
  if (!p) return 0
  const n = Number(p.linked_dossier_count || 0) - 1
  return n > 0 ? n : 0
}

// Label for the party link. Every resolved person/entity links to its party
// page; the wording just changes when the party is shared across dossiers.
function partyLinkLabel(name) {
  const n = otherDossierCount(name)
  if (n > 0) return `Also in ${n} other ${n === 1 ? 'dossier' : 'dossiers'}`
  return 'View party'
}

function partyLinkTitle(name) {
  const n = otherDossierCount(name)
  if (n > 0) return `Open party — appears on ${n + 1} dossiers in total`
  return 'Open party profile'
}

const trace = computed(() => props.card.sourceTrace || {})

// Country of incorporation is a critical KYC field. All data here originates from
// Companies House (the UK registry), so default to "United Kingdom" for older
// dossiers persisted before this field was added.
const countryOfIncorporation = computed(
  () => props.card.identity?.countryOfIncorporation || 'United Kingdom'
)

function sourceFor(key) {
  return trace.value[key] || null
}

function isOcr(src) {
  return src?.source === 'doc'
}

function sourceTitle(src) {
  if (!src) return ''
  if (src.source === 'api') return 'Source: Companies House API'
  if (src.source === 'doc') return `Source: ${src.kind || 'document'}`
  return ''
}

function fmtMoney(n) {
  if (n == null) return '—'
  return '£' + Number(n).toLocaleString('en-GB')
}

function fmtNumber(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('en-GB')
}

function dash(v) {
  return v == null || v === '' ? '—' : v
}

const hasFinancials = computed(() => {
  const f = props.card.financials
  if (!f) return false
  return Object.values(f).some((v) => v != null)
})

const failedDocCount = computed(
  () => (props.card.documents || []).filter((d) => d.processedBy === 'failed').length
)

// An officer is "active" while they have no resignation date. Resigned
// officers are hidden by default — they're historical and clutter the
// common case — but a toggle reveals them, visually distinct from active ones.
const activeOfficers = computed(() =>
  (props.card.officers || []).filter((o) => !o.resignedOn)
)
const resignedOfficers = computed(() =>
  (props.card.officers || []).filter((o) => o.resignedOn)
)
const showResignedOfficers = ref(false)
// What we actually render: always the active officers, plus the resigned ones
// only when the toggle is on. Active first so the list reads chronologically
// from "current" to "former".
const visibleOfficers = computed(() =>
  showResignedOfficers.value
    ? [...activeOfficers.value, ...resignedOfficers.value]
    : activeOfficers.value
)

// R6 — extraction honesty affordances. `confidence` is model-reported and
// advisory only (never drives routing); `provenance: 'ocr'` marks records
// read by the vision model rather than the PDF text layer.
const lowConfidenceCount = computed(() => {
  let n = (props.card.shareholders || []).filter(
    (s) => s.confidence && s.confidence !== 'high'
  ).length
  const f = props.card.financials
  if (f?.confidence && f.confidence !== 'high') n += 1
  return n
})

function extractionBadges(rec) {
  const out = []
  if (rec?.provenance === 'ocr') {
    out.push({ label: 'from OCR', title: 'Extracted via vision-model OCR — verify against the source filing' })
  }
  if (rec?.confidence && rec.confidence !== 'high') {
    out.push({ label: `${rec.confidence} confidence`, title: 'Model-reported confidence — advisory only' })
  }
  return out
}

const stamps = computed(() => {
  const out = []
  const id = props.card.identity || {}
  if (id.status) {
    out.push({ kind: `status status--${id.status}`, label: 'Status', value: id.status })
  }
  if (id.incorporationDate) {
    out.push({ kind: 'plain', label: 'Incorporated', value: id.incorporationDate, mono: true })
  }
  out.push({ kind: 'plain', label: 'Country', value: countryOfIncorporation.value })
  if (id.type) {
    out.push({ kind: 'plain', label: 'Type', value: id.type })
  }
  if (id.sicCodes?.length) {
    out.push({ kind: 'plain', label: 'SIC', value: id.sicCodes.join(', '), mono: true })
  }
  return out
})
</script>

<template>
  <article class="kyc">
    <!-- Dossier header -->
    <header class="dossier-head">
      <div class="dossier-id">
        <span class="t-label">Subject</span>
        <h1 class="company-name">{{ card.identity.name }}</h1>
        <div class="company-meta">
          <span class="company-num t-mono">#{{ card.identity.companyNumber }}</span>
          <span v-if="card.addresses?.registered" class="company-addr">
            {{ card.addresses.registered }}
          </span>
        </div>
      </div>

      <p v-if="lowConfidenceCount" class="conf-summary" title="Model-reported confidence — advisory only">
        {{ lowConfidenceCount }} extracted field{{ lowConfidenceCount === 1 ? '' : 's' }} below high confidence
      </p>

      <div v-if="stamps.length" class="stamps">
        <span
          v-for="(s, i) in stamps"
          :key="i"
          :class="['stamp', s.kind]"
        >
          <span class="stamp-label">{{ s.label }}</span>
          <span :class="['stamp-val', { 'tabular': s.mono }]">{{ s.value }}</span>
        </span>
      </div>
    </header>

    <div class="grid">
      <!-- Identity block -->
      <section class="block block--span-2">
        <h3 class="block-title">Identity</h3>
        <dl class="fields">
          <div class="field">
            <dt class="t-label">
              Name
              <span v-if="isOcr(sourceFor('identity.name'))" class="provenance" :title="sourceTitle(sourceFor('identity.name'))" />
            </dt>
            <dd class="field-val">{{ dash(card.identity.name) }}</dd>
          </div>
          <div class="field">
            <dt class="t-label">
              Company number
              <span v-if="isOcr(sourceFor('identity.companyNumber'))" class="provenance" :title="sourceTitle(sourceFor('identity.companyNumber'))" />
            </dt>
            <dd class="field-val t-mono">{{ dash(card.identity.companyNumber) }}</dd>
          </div>
          <div class="field" v-if="card.identity.type">
            <dt class="t-label">
              Type
              <span v-if="isOcr(sourceFor('identity.type'))" class="provenance" :title="sourceTitle(sourceFor('identity.type'))" />
            </dt>
            <dd class="field-val">{{ card.identity.type }}</dd>
          </div>
          <div class="field" v-if="card.identity.status">
            <dt class="t-label">Status</dt>
            <dd class="field-val">
              <span :class="['status-pill', `status-pill--${card.identity.status}`]">
                {{ card.identity.status }}
              </span>
            </dd>
          </div>
          <div class="field" v-if="card.identity.incorporationDate">
            <dt class="t-label">Incorporated</dt>
            <dd class="field-val tabular">{{ card.identity.incorporationDate }}</dd>
          </div>
          <div class="field">
            <dt class="t-label">Country of incorporation</dt>
            <dd class="field-val">{{ countryOfIncorporation }}</dd>
          </div>
          <div class="field" v-if="card.identity.sicCodes?.length">
            <dt class="t-label">SIC codes</dt>
            <dd class="field-val">{{ card.identity.sicCodes.join(', ') }}</dd>
          </div>
        </dl>
      </section>

      <!-- Registered address -->
      <section v-if="card.addresses?.registered" class="block">
        <h3 class="block-title">
          Registered address
          <span v-if="isOcr(sourceFor('addresses.registered'))" class="provenance" :title="sourceTitle(sourceFor('addresses.registered'))" />
        </h3>
        <p class="addr">{{ card.addresses.registered }}</p>
      </section>

      <!-- Financials -->
      <section v-if="hasFinancials" class="block">
        <h3 class="block-title">
          Financials
          <span v-if="isOcr(sourceFor('financials'))" class="provenance" :title="sourceTitle(sourceFor('financials'))" />
          <span
            v-for="(b, bi) in extractionBadges(card.financials)"
            :key="bi"
            class="conf-badge"
            :title="b.title"
          >{{ b.label }}</span>
        </h3>
        <dl class="fields fields--single">
          <div class="field" v-if="card.financials.periodEnd">
            <dt class="t-label">Period end</dt>
            <dd class="field-val tabular">{{ card.financials.periodEnd }}</dd>
          </div>
          <div class="field" v-if="card.financials.turnover != null">
            <dt class="t-label">Turnover</dt>
            <dd class="field-val tabular">{{ fmtMoney(card.financials.turnover) }}</dd>
          </div>
          <div class="field" v-if="card.financials.profit != null">
            <dt class="t-label">Profit</dt>
            <dd class="field-val tabular">{{ fmtMoney(card.financials.profit) }}</dd>
          </div>
          <div class="field" v-if="card.financials.totalAssets != null">
            <dt class="t-label">Total assets</dt>
            <dd class="field-val tabular">{{ fmtMoney(card.financials.totalAssets) }}</dd>
          </div>
          <div class="field" v-if="card.financials.netAssets != null">
            <dt class="t-label">Net assets</dt>
            <dd class="field-val tabular">{{ fmtMoney(card.financials.netAssets) }}</dd>
          </div>
          <div class="field" v-if="card.financials.employees != null">
            <dt class="t-label">Employees</dt>
            <dd class="field-val tabular">{{ fmtNumber(card.financials.employees) }}</dd>
          </div>
        </dl>
      </section>
    </div>

    <!-- Officers -->
    <section v-if="card.officers?.length" class="block block--full">
      <header class="block-head">
        <h3 class="block-title">
          Officers
          <span class="block-count">
            {{ activeOfficers.length }} active<template v-if="resignedOfficers.length">, {{ resignedOfficers.length }} resigned</template>
          </span>
          <span v-if="isOcr(sourceFor('officers'))" class="provenance" :title="sourceTitle(sourceFor('officers'))" />
        </h3>
        <button
          v-if="resignedOfficers.length"
          type="button"
          class="officer-toggle"
          :aria-pressed="showResignedOfficers"
          @click="showResignedOfficers = !showResignedOfficers"
        >
          {{ showResignedOfficers ? 'Hide resigned' : `Show ${resignedOfficers.length} resigned` }}
        </button>
      </header>
      <ul class="people">
        <li v-for="(o, i) in visibleOfficers" :key="i" class="person" :class="{ 'person--resigned': o.resignedOn }">
          <div class="person-main">
            <span class="person-name">
              {{ o.name }}
              <span class="officer-status" :class="o.resignedOn ? 'officer-status--resigned' : 'officer-status--active'">
                {{ o.resignedOn ? 'Resigned' : 'Active' }}
              </span>
            </span>
            <span v-if="o.role" class="person-role">{{ o.role }}</span>
            <RouterLink
              v-if="partyFor(o.name)"
              :to="`/party/${partyFor(o.name).id}`"
              :class="['party-badge', { 'party-badge--shared': otherDossierCount(o.name) > 0 }]"
              :title="partyLinkTitle(o.name)"
            >
              <span class="material-symbols-outlined party-badge-icon">hub</span>
              {{ partyLinkLabel(o.name) }}
            </RouterLink>
          </div>
          <div class="person-meta">
            <span v-if="o.appointedOn" class="tabular">
              <span class="t-label inline-label">Appointed</span> {{ o.appointedOn }}
            </span>
            <span v-if="o.resignedOn" class="tabular resigned">
              <span class="t-label inline-label">Resigned</span> {{ o.resignedOn }}
            </span>
          </div>
        </li>
      </ul>
    </section>

    <!-- PSC -->
    <section v-if="card.psc?.length" class="block block--full">
      <header class="block-head">
        <h3 class="block-title">
          Persons with significant control
          <span class="block-count">{{ card.psc.length }}</span>
          <span v-if="isOcr(sourceFor('psc'))" class="provenance" :title="sourceTitle(sourceFor('psc'))" />
        </h3>
      </header>
      <ul class="people">
        <li v-for="(p, i) in card.psc" :key="i" class="person">
          <div class="person-main">
            <span class="person-name">{{ p.name }}</span>
            <span v-if="p.kind" class="person-role">{{ p.kind }}</span>
            <RouterLink
              v-if="partyFor(p.name)"
              :to="`/party/${partyFor(p.name).id}`"
              :class="['party-badge', { 'party-badge--shared': otherDossierCount(p.name) > 0 }]"
              :title="partyLinkTitle(p.name)"
            >
              <span class="material-symbols-outlined party-badge-icon">hub</span>
              {{ partyLinkLabel(p.name) }}
            </RouterLink>
          </div>
          <div v-if="p.naturesOfControl?.length" class="control-list">
            <span v-for="(n, j) in p.naturesOfControl" :key="j" class="control-tag">{{ n }}</span>
          </div>
          <div v-if="p.notifiedOn" class="person-meta">
            <span class="tabular">
              <span class="t-label inline-label">Notified</span> {{ p.notifiedOn }}
            </span>
          </div>
        </li>
      </ul>
    </section>

    <!-- Shareholders -->
    <section v-if="card.shareholders?.length" class="block block--full">
      <header class="block-head">
        <h3 class="block-title">
          Shareholders
          <span class="block-count">{{ card.shareholders.length }}</span>
          <span v-if="isOcr(sourceFor('shareholders'))" class="provenance" :title="sourceTitle(sourceFor('shareholders'))" />
        </h3>
      </header>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th class="num">Shares</th>
              <th class="num">%</th>
              <th>Class</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in card.shareholders" :key="i">
              <td class="td-name">
                <RouterLink
                  v-if="partyFor(s.name)"
                  :to="`/party/${partyFor(s.name).id}`"
                  class="td-name-link"
                  :title="partyLinkTitle(s.name)"
                >
                  {{ s.name }}
                  <span class="material-symbols-outlined td-name-icon">hub</span>
                </RouterLink>
                <template v-else>{{ s.name }}</template>
                <span
                  v-for="(b, bi) in extractionBadges(s)"
                  :key="bi"
                  class="conf-badge"
                  :title="b.title"
                >{{ b.label }}</span>
              </td>
              <td class="td-muted">{{ s.type || '—' }}</td>
              <td class="num">{{ s.shares != null ? fmtNumber(s.shares) : '—' }}</td>
              <td class="num">{{ s.percentage != null ? s.percentage + '%' : '—' }}</td>
              <td class="td-muted">{{ s.shareClass || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Documents -->
    <section v-if="card.documents?.length" class="block block--full">
      <header class="block-head">
        <h3 class="block-title">
          Source filings
          <span class="block-count">
            {{ card.documents.length }}<span v-if="failedDocCount" class="failed-count"> · {{ failedDocCount }} failed</span>
          </span>
        </h3>
      </header>
      <ul class="docs">
        <li v-for="(d, i) in card.documents" :key="i" class="doc">
          <component
            :is="d.documentId ? 'a' : 'div'"
            v-bind="d.documentId
              ? {
                  href: `/api/documents/${encodeURIComponent(d.documentId)}?transactionId=${encodeURIComponent(d.transactionId || '')}`,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  title: 'Open PDF in a new tab',
                }
              : {}"
            :class="['doc-row', { 'doc-row--link': d.documentId }]"
          >
            <div class="doc-main">
              <span class="doc-cat">{{ d.category }}</span>
              <span v-if="d.date" class="doc-date tabular">{{ d.date }}</span>
              <span
                v-if="d.truncated"
                class="doc-truncated"
                :title="`Only ${d.pagesProcessed ?? '?'} of ${d.pagesTotal ?? '?'} pages were OCR'd — extracted lists may be incomplete`"
              >
                OCR truncated · {{ d.pagesProcessed ?? '?' }}/{{ d.pagesTotal ?? '?' }} pages
              </span>
            </div>
            <div class="doc-meta">
              <span class="doc-id t-mono">{{ d.transactionId }}</span>
              <span
                v-if="d.processedBy"
                :class="['proc', `proc--${d.processedBy}`]"
                :title="d.processedBy === 'failed' ? (d.error || 'extraction failed') : `extracted via ${d.processedBy}`"
              >
                {{ d.processedBy }}
              </span>
              <span
                v-if="d.documentId"
                class="material-symbols-outlined doc-open"
                aria-hidden="true"
              >open_in_new</span>
            </div>
          </component>
        </li>
      </ul>
    </section>

    <!-- Red flags -->
    <section v-if="card.redFlags?.length" class="flags">
      <header class="flags-head">
        <span class="flags-icon" aria-hidden="true">!</span>
        <h3 class="block-title">Red flags</h3>
      </header>
      <ul class="flag-list">
        <li v-for="(f, i) in card.redFlags" :key="i">{{ f }}</li>
      </ul>
    </section>
  </article>
</template>

<style scoped>
.kyc {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

/* Dossier header */
.dossier-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-6);
  padding-bottom: var(--sp-6);
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}
.dossier-id {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
  flex: 1 1 320px;
}
.company-name {
  margin: 0;
  font-family: var(--font-display);
  font-size: 28px;
  line-height: 34px;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}
.company-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-3) var(--sp-4);
}
.company-num {
  color: var(--color-text-secondary);
  font-weight: 500;
}
.company-addr {
  color: var(--color-text-tertiary);
  font-size: var(--fs-meta);
  max-width: 60ch;
}

.stamps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  flex-shrink: 0;
}
.stamp {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  min-width: 96px;
}
.stamp-label {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}
.stamp-val {
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-primary);
  text-transform: capitalize;
}
.stamp.status--active .stamp-val {
  color: var(--color-success);
}
.stamp.status--dissolved .stamp-val {
  color: var(--color-danger);
}

/* Grid layout for top blocks */
.grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--sp-6);
}
.grid > .block--span-2 {
  grid-row: span 2;
}
@media (max-width: 880px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .grid > .block--span-2 {
    grid-row: auto;
  }
}

/* Block (a "section" within the dossier) */
.block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.block--full {
  grid-column: 1 / -1;
  padding-top: var(--sp-6);
  border-top: 1px solid var(--color-border);
}
.block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
}
.block-title {
  margin: 0;
  font-size: var(--fs-label);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}
.block-count {
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  color: var(--color-text-tertiary);
  font-size: var(--fs-meta);
}
.failed-count {
  color: var(--color-danger);
}

/* Field grid */
.fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4) var(--sp-6);
  margin: 0;
}
.fields--single {
  grid-template-columns: 1fr;
  gap: var(--sp-3);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.field dt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.field-val {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-primary);
  word-break: break-word;
}

.addr {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--color-text-primary);
  font-weight: 500;
  line-height: 1.5;
}

/* People (officers + PSC) */
.people {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--sp-3);
}
.person {
  background: var(--color-page);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-3) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* Resigned officers are visually de-emphasised: a light-red card with a
   dashed border and red left accent so active officers read first. */
.person--resigned {
  background: var(--color-danger-soft);
  border-style: dashed;
  border-left: 3px solid var(--color-danger);
}
.person-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.person-name {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--color-text-primary);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
/* Active / resigned pill on each officer row. */
.officer-status {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid transparent;
}
.officer-status--active {
  color: var(--color-success);
  background: var(--color-success-soft);
  border-color: var(--color-success);
}
.officer-status--resigned {
  color: var(--color-danger);
  background: #fff;
  border-color: var(--color-danger);
}
/* "Show / hide resigned" toggle in the section header. */
.officer-toggle {
  flex: none;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.officer-toggle:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}
.person-role {
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  text-transform: capitalize;
}
/* Party link per officer/PSC row. Always shown when the resolver linked the
   row to a party. The "shared" variant (purple, prominent) flags a party
   that also appears on other dossiers; the plain variant is a quiet
   "view party" affordance for single-dossier parties. */
.party-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 4px;
  padding: 2px 8px;
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  text-decoration: none;
  font-weight: 500;
  width: max-content;
}
.party-badge:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}
.party-badge--shared {
  color: #4338ca;
  background: #ede9fe;
  border-color: #c7d2fe;
}
.party-badge--shared:hover {
  background: #ddd6fe;
  border-color: #a5b4fc;
  color: #3730a3;
}
.party-badge-icon {
  font-size: 14px;
}
/* Shareholder name → party link */
.td-name-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-primary);
  text-decoration: none;
  font-weight: 500;
}
.td-name-link:hover {
  color: var(--color-primary);
  text-decoration: underline;
}
.td-name-icon {
  font-size: 14px;
  color: var(--color-text-tertiary);
}
.td-name-link:hover .td-name-icon {
  color: var(--color-primary);
}
.person-meta {
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.inline-label {
  display: inline;
  margin-right: 4px;
  font-size: 10px;
  letter-spacing: 0.06em;
}
.resigned {
  color: var(--color-text-tertiary);
}
.control-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.control-tag {
  font-size: 11px;
  padding: 2px var(--sp-2);
  background: var(--color-surface-sunken);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
}

/* Shareholders table */
.table-wrap {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-body);
}
.table thead {
  background: var(--color-page);
}
.table th {
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--color-border);
}
.table td {
  padding: var(--sp-3);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-primary);
}
.table tr:last-child td {
  border-bottom: 0;
}
.table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
}
.td-name {
  font-weight: 500;
}
.td-muted {
  color: var(--color-text-tertiary);
}

/* Source documents */
.docs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.doc {
  background: var(--color-page);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.doc-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  align-items: center;
  color: inherit;
  text-decoration: none;
  border-radius: var(--radius-md);
}
.doc-row--link {
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease);
}
.doc-row--link:hover {
  background: var(--color-primary-soft);
}
.doc-row--link:hover .doc-cat {
  color: var(--color-primary);
}
.doc-open {
  font-size: 16px;
  color: var(--color-text-tertiary);
}
.doc-row--link:hover .doc-open {
  color: var(--color-primary);
}
.doc-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.doc-cat {
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-primary);
  text-transform: capitalize;
}
.doc-date {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
}
.doc-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.doc-id {
  color: var(--color-text-tertiary);
  font-size: 11px;
}

.proc {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: help;
}
.proc--text {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.proc--ocr {
  background: var(--color-tertiary-soft);
  color: var(--color-tertiary);
}
.proc--failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

/* Red flags */
.flags {
  background: var(--color-tertiary-soft);
  border: 1px solid rgba(180, 83, 9, 0.18);
  border-left: 4px solid var(--color-tertiary);
  border-radius: var(--radius-md);
  padding: var(--sp-4) var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.flags-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.flags-head .block-title {
  color: var(--color-tertiary);
}
.flags-icon {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-tertiary);
  color: var(--color-text-on-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
}
.flag-list {
  margin: 0;
  padding-left: var(--sp-6);
  font-size: var(--fs-body);
  color: var(--color-text-primary);
  line-height: 1.6;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
</style>
