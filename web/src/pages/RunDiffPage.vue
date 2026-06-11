<script setup>
import { computed, toRef } from 'vue'
import { useRoute } from 'vue-router'
import { useRunPair } from '../composables/useRunPair.js'
import { useDossier } from '../composables/useDossier.js'

const route = useRoute()
const companyNumber = toRef(() => route.params.companyNumber)
// `runId` is the "current" (newer) run; `otherRunId` is what we compare against (older).
const runId = toRef(() => route.params.runId)
const otherRunId = toRef(() => route.params.otherRunId)

const { left: prev, right: curr, loading, error } = useRunPair(companyNumber, otherRunId, runId)
const { dossier } = useDossier(companyNumber)

const prevCard = computed(() => prev.value?.finalKycCard || null)
const currCard = computed(() => curr.value?.finalKycCard || null)
const prevDocs = computed(() => prev.value?.finalDocuments || [])
const currDocs = computed(() => curr.value?.finalDocuments || [])

function fmtTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString()
}

// Identity / financials: field-by-field equality.
function fieldDiff(prevObj, currObj, fields) {
  return fields.map((f) => {
    const a = prevObj?.[f]
    const b = currObj?.[f]
    let kind = 'unchanged'
    if (a == null && b != null) kind = 'added'
    else if (a != null && b == null) kind = 'removed'
    else if (Array.isArray(a) || Array.isArray(b)) {
      const aStr = JSON.stringify(a || [])
      const bStr = JSON.stringify(b || [])
      if (aStr !== bStr) kind = 'changed'
    } else if (a !== b) kind = 'changed'
    return { field: f, prev: a, curr: b, kind }
  })
}

// Array-of-records diff. `keyOf` builds a stable id; `equalsExceptKey` decides "changed".
function arrayDiff(prevArr, currArr, keyOf, equalsExceptKey) {
  const prevMap = new Map((prevArr || []).map((x) => [keyOf(x), x]))
  const currMap = new Map((currArr || []).map((x) => [keyOf(x), x]))
  const added = []
  const removed = []
  const changed = []
  const unchanged = []

  for (const [k, c] of currMap) {
    if (!prevMap.has(k)) added.push(c)
    else {
      const p = prevMap.get(k)
      if (equalsExceptKey ? !equalsExceptKey(p, c) : JSON.stringify(p) !== JSON.stringify(c)) {
        changed.push({ prev: p, curr: c })
      } else {
        unchanged.push(c)
      }
    }
  }
  for (const [k, p] of prevMap) {
    if (!currMap.has(k)) removed.push(p)
  }

  return { added, removed, changed, unchanged }
}

const norm = (s) => String(s ?? '').trim().toLowerCase()

const identityDiff = computed(() =>
  fieldDiff(prevCard.value?.identity, currCard.value?.identity, [
    'name',
    'companyNumber',
    'type',
    'status',
    'incorporationDate',
    'sicCodes',
  ])
)

const addressesDiff = computed(() =>
  fieldDiff(prevCard.value?.addresses, currCard.value?.addresses, ['registered'])
)

const officersDiff = computed(() =>
  arrayDiff(
    prevCard.value?.officers,
    currCard.value?.officers,
    (o) => `${norm(o.name)}|${o.appointedOn || ''}|${norm(o.role)}`,
    (a, b) => a.role === b.role && a.appointedOn === b.appointedOn && a.resignedOn === b.resignedOn
  )
)

const pscDiff = computed(() =>
  arrayDiff(
    prevCard.value?.psc,
    currCard.value?.psc,
    (p) => `${norm(p.name)}|${p.notifiedOn || ''}`,
    (a, b) =>
      a.kind === b.kind &&
      a.notifiedOn === b.notifiedOn &&
      JSON.stringify(a.naturesOfControl || []) === JSON.stringify(b.naturesOfControl || [])
  )
)

const shareholdersDiff = computed(() =>
  arrayDiff(
    prevCard.value?.shareholders,
    currCard.value?.shareholders,
    (s) => `${norm(s.name)}|${norm(s.shareClass)}`,
    (a, b) => a.shares === b.shares && a.percentage === b.percentage && a.type === b.type
  )
)

const financialsDiff = computed(() =>
  fieldDiff(prevCard.value?.financials, currCard.value?.financials, [
    'periodEnd',
    'turnover',
    'profit',
    'totalAssets',
    'netAssets',
    'employees',
  ])
)

// Filings diff: new transactionIds in current vs previous.
const filingsDiff = computed(() => {
  const prevIds = new Set((prevDocs.value || []).map((d) => d.transactionId))
  const currList = currDocs.value || []
  const added = currList.filter((d) => !prevIds.has(d.transactionId))
  return { added }
})

const sectionCounts = computed(() => ({
  officers: officersDiff.value,
  psc: pscDiff.value,
  shareholders: shareholdersDiff.value,
}))

function fmtVal(v) {
  if (v == null) return '—'
  if (Array.isArray(v)) return v.join(', ') || '—'
  if (typeof v === 'number') return v.toLocaleString('en-GB')
  return String(v)
}

function delta(prev, curr) {
  if (typeof prev !== 'number' || typeof curr !== 'number') return null
  const d = curr - prev
  if (d === 0) return null
  const arrow = d > 0 ? '▲' : '▼'
  return `${arrow} ${d > 0 ? '+' : ''}${d.toLocaleString('en-GB')}`
}
</script>

<template>
  <div class="run-diff">
    <header class="page-head">
      <div>
        <RouterLink
          :to="{ name: 'dossier', params: { companyNumber } }"
          class="back-link"
        >
          <span class="material-symbols-outlined icon-sm">arrow_back</span>
          Back to dossier
        </RouterLink>
        <h1 class="t-headline page-title">Run diff</h1>
        <div class="page-meta">
          <span v-if="dossier" class="t-meta">
            {{ dossier.companyName || dossier.companyNumber }}
          </span>
        </div>
      </div>
    </header>

    <section v-if="loading" class="dossier-sheet">
      <p class="t-meta">Loading runs…</p>
    </section>

    <section v-else-if="error" class="dossier-sheet">
      <p class="t-meta">{{ error === 'not_found' ? 'One or both runs not found.' : error }}</p>
    </section>

    <template v-else-if="prev && curr">
      <section class="dossier-sheet legend-sheet">
        <div class="run-pair">
          <div class="run-side">
            <span class="t-label">Previous</span>
            <div class="run-side-meta">
              <span class="t-mono">{{ prev.id.slice(0, 8).toUpperCase() }}</span>
              <span :class="['status-chip', `status-chip--${prev.status}`]">{{ prev.status }}</span>
              <span :class="['trigger-pill', `trigger-pill--${prev.trigger}`]">{{ prev.trigger }}</span>
            </div>
            <span class="t-meta">{{ fmtTime(prev.startedAt) }}</span>
          </div>
          <span class="material-symbols-outlined arrow">arrow_forward</span>
          <div class="run-side">
            <span class="t-label">Current</span>
            <div class="run-side-meta">
              <span class="t-mono">{{ curr.id.slice(0, 8).toUpperCase() }}</span>
              <span :class="['status-chip', `status-chip--${curr.status}`]">{{ curr.status }}</span>
              <span :class="['trigger-pill', `trigger-pill--${curr.trigger}`]">{{ curr.trigger }}</span>
            </div>
            <span class="t-meta">{{ fmtTime(curr.startedAt) }}</span>
          </div>
        </div>
        <ul class="legend">
          <li><span class="dot dot--added" /> added</li>
          <li><span class="dot dot--removed" /> removed</li>
          <li><span class="dot dot--changed" /> changed</li>
        </ul>
      </section>

      <!-- Identity -->
      <section class="dossier-sheet">
        <header class="section-head">
          <h2 class="t-title">Identity</h2>
        </header>
        <table class="diff-table">
          <thead>
            <tr><th>Field</th><th>Previous</th><th>Current</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in identityDiff" :key="row.field" :class="`row--${row.kind}`">
              <td class="cell-field">{{ row.field }}</td>
              <td class="cell-val tabular">{{ fmtVal(row.prev) }}</td>
              <td class="cell-val tabular">{{ fmtVal(row.curr) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Addresses -->
      <section class="dossier-sheet">
        <header class="section-head">
          <h2 class="t-title">Addresses</h2>
        </header>
        <table class="diff-table">
          <thead>
            <tr><th>Field</th><th>Previous</th><th>Current</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in addressesDiff" :key="row.field" :class="`row--${row.kind}`">
              <td class="cell-field">{{ row.field }}</td>
              <td class="cell-val">{{ fmtVal(row.prev) }}</td>
              <td class="cell-val">{{ fmtVal(row.curr) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Officers -->
      <section class="dossier-sheet">
        <header class="section-head">
          <h2 class="t-title">
            Officers
            <span class="t-meta section-counts">
              · {{ sectionCounts.officers.added.length }} added
              · {{ sectionCounts.officers.removed.length }} removed
              · {{ sectionCounts.officers.changed.length }} changed
            </span>
          </h2>
        </header>
        <ul v-if="officersDiff.added.length" class="diff-list">
          <li v-for="o in officersDiff.added" :key="`a-${o.name}-${o.appointedOn}`" class="row--added">
            <span class="badge">added</span>
            <span class="diff-name">{{ o.name }}</span>
            <span class="t-meta">{{ o.role || '—' }} · appointed {{ o.appointedOn || '—' }}</span>
          </li>
        </ul>
        <ul v-if="officersDiff.removed.length" class="diff-list">
          <li v-for="o in officersDiff.removed" :key="`r-${o.name}-${o.appointedOn}`" class="row--removed">
            <span class="badge">removed</span>
            <span class="diff-name">{{ o.name }}</span>
            <span class="t-meta">{{ o.role || '—' }} · appointed {{ o.appointedOn || '—' }}</span>
          </li>
        </ul>
        <ul v-if="officersDiff.changed.length" class="diff-list">
          <li v-for="(o, i) in officersDiff.changed" :key="`c-${i}`" class="row--changed">
            <span class="badge">changed</span>
            <div>
              <div class="diff-name">{{ o.curr.name }}</div>
              <div class="t-meta">
                role: {{ o.prev.role || '—' }} → {{ o.curr.role || '—' }} ·
                resigned: {{ o.prev.resignedOn || '—' }} → {{ o.curr.resignedOn || '—' }}
              </div>
            </div>
          </li>
        </ul>
        <details v-if="officersDiff.unchanged.length">
          <summary class="t-meta">{{ officersDiff.unchanged.length }} unchanged</summary>
          <ul class="diff-list diff-list--muted">
            <li v-for="o in officersDiff.unchanged" :key="`u-${o.name}-${o.appointedOn}`">
              <span class="diff-name">{{ o.name }}</span>
              <span class="t-meta">{{ o.role || '—' }}</span>
            </li>
          </ul>
        </details>
        <p v-if="!officersDiff.added.length && !officersDiff.removed.length && !officersDiff.changed.length && !officersDiff.unchanged.length" class="t-meta">
          No officers in either run.
        </p>
      </section>

      <!-- PSCs -->
      <section class="dossier-sheet">
        <header class="section-head">
          <h2 class="t-title">
            PSCs
            <span class="t-meta section-counts">
              · {{ pscDiff.added.length }} added · {{ pscDiff.removed.length }} removed · {{ pscDiff.changed.length }} changed
            </span>
          </h2>
        </header>
        <ul v-if="pscDiff.added.length" class="diff-list">
          <li v-for="p in pscDiff.added" :key="`a-${p.name}`" class="row--added">
            <span class="badge">added</span>
            <span class="diff-name">{{ p.name }}</span>
            <span class="t-meta">{{ p.kind || '—' }}</span>
          </li>
        </ul>
        <ul v-if="pscDiff.removed.length" class="diff-list">
          <li v-for="p in pscDiff.removed" :key="`r-${p.name}`" class="row--removed">
            <span class="badge">removed</span>
            <span class="diff-name">{{ p.name }}</span>
            <span class="t-meta">{{ p.kind || '—' }}</span>
          </li>
        </ul>
        <ul v-if="pscDiff.changed.length" class="diff-list">
          <li v-for="(p, i) in pscDiff.changed" :key="`c-${i}`" class="row--changed">
            <span class="badge">changed</span>
            <div>
              <div class="diff-name">{{ p.curr.name }}</div>
              <div class="t-meta">
                kind: {{ p.prev.kind || '—' }} → {{ p.curr.kind || '—' }}
              </div>
            </div>
          </li>
        </ul>
        <details v-if="pscDiff.unchanged.length">
          <summary class="t-meta">{{ pscDiff.unchanged.length }} unchanged</summary>
          <ul class="diff-list diff-list--muted">
            <li v-for="p in pscDiff.unchanged" :key="`u-${p.name}`">
              <span class="diff-name">{{ p.name }}</span>
            </li>
          </ul>
        </details>
        <p v-if="!pscDiff.added.length && !pscDiff.removed.length && !pscDiff.changed.length && !pscDiff.unchanged.length" class="t-meta">
          No PSCs in either run.
        </p>
      </section>

      <!-- Shareholders -->
      <section class="dossier-sheet">
        <header class="section-head">
          <h2 class="t-title">
            Shareholders
            <span class="t-meta section-counts">
              · {{ shareholdersDiff.added.length }} added · {{ shareholdersDiff.removed.length }} removed · {{ shareholdersDiff.changed.length }} changed
            </span>
          </h2>
        </header>
        <ul v-if="shareholdersDiff.added.length" class="diff-list">
          <li v-for="s in shareholdersDiff.added" :key="`a-${s.name}-${s.shareClass}`" class="row--added">
            <span class="badge">added</span>
            <span class="diff-name">{{ s.name }}</span>
            <span class="t-meta tabular">{{ s.percentage != null ? `${s.percentage}%` : '—' }} · {{ s.shareClass || '—' }}</span>
          </li>
        </ul>
        <ul v-if="shareholdersDiff.removed.length" class="diff-list">
          <li v-for="s in shareholdersDiff.removed" :key="`r-${s.name}-${s.shareClass}`" class="row--removed">
            <span class="badge">removed</span>
            <span class="diff-name">{{ s.name }}</span>
            <span class="t-meta tabular">{{ s.percentage != null ? `${s.percentage}%` : '—' }} · {{ s.shareClass || '—' }}</span>
          </li>
        </ul>
        <ul v-if="shareholdersDiff.changed.length" class="diff-list">
          <li v-for="(s, i) in shareholdersDiff.changed" :key="`c-${i}`" class="row--changed">
            <span class="badge">changed</span>
            <div>
              <div class="diff-name">{{ s.curr.name }}</div>
              <div class="t-meta tabular">
                {{ s.prev.percentage ?? '—' }}% → {{ s.curr.percentage ?? '—' }}%
                <span v-if="delta(s.prev.percentage, s.curr.percentage)" class="delta">
                  ({{ delta(s.prev.percentage, s.curr.percentage) }})
                </span>
                · shares {{ s.prev.shares ?? '—' }} → {{ s.curr.shares ?? '—' }}
              </div>
            </div>
          </li>
        </ul>
        <details v-if="shareholdersDiff.unchanged.length">
          <summary class="t-meta">{{ shareholdersDiff.unchanged.length }} unchanged</summary>
          <ul class="diff-list diff-list--muted">
            <li v-for="s in shareholdersDiff.unchanged" :key="`u-${s.name}-${s.shareClass}`">
              <span class="diff-name">{{ s.name }}</span>
            </li>
          </ul>
        </details>
        <p v-if="!shareholdersDiff.added.length && !shareholdersDiff.removed.length && !shareholdersDiff.changed.length && !shareholdersDiff.unchanged.length" class="t-meta">
          No shareholders in either run.
        </p>
      </section>

      <!-- Financials -->
      <section class="dossier-sheet">
        <header class="section-head">
          <h2 class="t-title">Financials</h2>
        </header>
        <table class="diff-table">
          <thead>
            <tr><th>Field</th><th>Previous</th><th>Current</th><th>Δ</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in financialsDiff" :key="row.field" :class="`row--${row.kind}`">
              <td class="cell-field">{{ row.field }}</td>
              <td class="cell-val tabular">{{ fmtVal(row.prev) }}</td>
              <td class="cell-val tabular">{{ fmtVal(row.curr) }}</td>
              <td class="cell-val tabular">{{ delta(row.prev, row.curr) || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Filings -->
      <section class="dossier-sheet">
        <header class="section-head">
          <h2 class="t-title">
            Filings
            <span class="t-meta section-counts">
              · {{ filingsDiff.added.length }} new
            </span>
          </h2>
          <p class="t-meta">Filings are append-only in Companies House — only newly seen items are listed.</p>
        </header>
        <ul v-if="filingsDiff.added.length" class="diff-list">
          <li v-for="d in filingsDiff.added" :key="d.transactionId" class="row--added">
            <span class="badge">new</span>
            <span class="diff-name">{{ d.category }}</span>
            <span class="t-meta tabular">{{ d.date || '—' }} · {{ d.transactionId }}</span>
          </li>
        </ul>
        <p v-else class="t-meta">No new filings since the previous run.</p>
      </section>

      <p class="t-meta footnote">
        Officers and shareholders are matched by name+key. Two records sharing the same name and
        appointment date (officers) or share class (shareholders) collapse into one diff row.
      </p>
    </template>
  </div>
</template>

<style scoped>
.run-diff {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--sp-4);
  flex-wrap: wrap;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--color-text-secondary);
  text-decoration: none;
  margin-bottom: var(--sp-2);
}
.back-link:hover { color: var(--color-primary); }
.page-title { margin: 0; }
.page-meta {
  margin-top: var(--sp-2);
  display: flex;
  gap: var(--sp-1);
  align-items: baseline;
  color: var(--color-text-tertiary);
  font-size: var(--fs-meta);
}

.dossier-sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-6);
  box-shadow: var(--shadow-sheet);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.legend-sheet {
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-6);
  flex-wrap: wrap;
}

.run-pair {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex-wrap: wrap;
}
.run-side {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.run-side-meta {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
  flex-wrap: wrap;
}
.arrow { color: var(--color-text-tertiary); }

.legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: var(--sp-3);
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
}
.legend li {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.dot--added { background: var(--color-success); }
.dot--removed { background: var(--color-danger); }
.dot--changed { background: var(--color-tertiary); }

.section-head h2 { margin: 0 0 var(--sp-1); }
.section-head p { margin: 0; }
.section-counts {
  font-weight: 400;
  margin-left: var(--sp-2);
  color: var(--color-text-tertiary);
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-body);
}
.diff-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--color-border);
}
.diff-table td {
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}
.diff-table tr:last-child td { border-bottom: 0; }
.cell-field {
  color: var(--color-text-secondary);
  font-weight: 500;
}
.cell-val {
  color: var(--color-text-primary);
}

.row--added { background: var(--color-success-soft); }
.row--removed { background: var(--color-danger-soft); }
.row--changed { background: var(--color-tertiary-soft); }
.row--unchanged { /* default */ }

.diff-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.diff-list li {
  display: flex;
  gap: var(--sp-3);
  align-items: center;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  font-size: var(--fs-body);
}
.diff-list--muted li {
  background: transparent;
  color: var(--color-text-tertiary);
}
.diff-name {
  font-weight: 500;
  color: var(--color-text-primary);
}
.badge {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.delta { color: var(--color-text-secondary); }

.status-chip {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.status-chip--done {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.status-chip--failed,
.status-chip--not_found {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.status-chip--running {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.trigger-pill {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}
.trigger-pill--initial {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.trigger-pill--refresh {
  background: var(--color-tertiary-soft);
  color: var(--color-tertiary);
}

.footnote {
  text-align: center;
  margin: var(--sp-2) 0 0;
  color: var(--color-text-tertiary);
}

details summary {
  cursor: pointer;
  padding: var(--sp-2) 0;
}
</style>
