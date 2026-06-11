<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDossiers } from '../composables/useDossiers.js'

const router = useRouter()
const route = useRoute()
// FinalDecisionPanel redirects here with ?caseStatus=<value> so the reviewer
// lands on a filtered list showing the case they just acted on.
const initialCaseStatus =
  typeof route.query.caseStatus === 'string' && route.query.caseStatus
    ? route.query.caseStatus
    : 'all'
const { dossiers, kpis, search, filter, tag, caseStatus } = useDossiers({
  initialCaseStatus,
})

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
  { id: 'not_found', label: 'Not found' },
  { id: 'cancelled', label: 'Cancelled' },
]

const TAG_FILTERS = [
  { id: null, label: 'All tags' },
  { id: 'escalate', label: 'Escalate' },
  { id: 'cleared', label: 'Cleared' },
  { id: 'monitor', label: 'Monitor' },
]

const CASE_STATUS_FILTERS = [
  { id: 'all', label: 'All cases' },
  { id: 'auto_approved', label: 'Auto-approved' },
  { id: 'streamlined_review', label: 'Streamlined' },
  { id: 'standard_review', label: 'Standard' },
  { id: 'info_requested', label: 'Info requested' },
  { id: 'escalated', label: 'Escalated' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
]

const CASE_STATUS_LABELS = {
  pending: 'Pending',
  auto_approved: 'Auto-approved',
  streamlined_review: 'Streamlined',
  standard_review: 'Standard',
  info_requested: 'Info req.',
  escalated: 'Escalated',
  approved: 'Approved',
  rejected: 'Rejected',
}

const RISK_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  prohibited: 'Prohibited',
  unavailable: 'Unavailable',
}

// Risk shown here is the outcome from the risk-assessment agent (runs.final_risk_assessment),
// not a red-flag heuristic. Older runs that pre-date the risk engine have no assessment —
// surface those as "unavailable" with a grey dot.
function deriveRisk(dossier) {
  const ra = dossier.latestRun?.finalRiskAssessment
  const outcome = ra?.outcome || ra?.tier
  if (!outcome) return 'unavailable'
  return String(outcome).toLowerCase()
}

function riskTitle(dossier) {
  const ra = dossier.latestRun?.finalRiskAssessment
  if (!ra) return 'No risk assessment on the latest run yet'
  const score = typeof ra.score === 'number' ? Math.round(ra.score) : '–'
  return `Score ${score} / 100 · matrix v${ra.matrixVersion ?? '–'}`
}

function deriveStatus(dossier) {
  return dossier.latestRun?.status || 'pending'
}

function isFlagged(dossier) {
  if ((dossier.tags || []).includes('escalate')) return true
  return dossier.latestRun?.status === 'failed'
}

const rows = computed(() =>
  (dossiers.value || []).map((d) => {
    const lr = d.latestRun
    const officers = lr?.officersCount ?? 0
    const psc = lr?.pscCount ?? 0
    const shareholders = lr?.shareholdersCount ?? 0
    const updated = d.updatedAt ? new Date(d.updatedAt).toISOString().slice(0, 10) : ''
    return {
      id: d.id,
      companyNumber: d.companyNumber,
      subject: d.companyName || d.companyNumber,
      status: deriveStatus(d),
      caseStatus: d.caseStatus || 'pending',
      risk: deriveRisk(d),
      riskTitle: riskTitle(d),
      trigger: d.latestRun?.trigger || '—',
      runCount: d.runCount || 0,
      officers,
      psc,
      shareholders,
      lastUpdated: updated,
      tags: d.tags || [],
      flagged: isFlagged(d),
    }
  })
)

const STATUS_LABELS = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  not_found: 'Not found',
  cancelled: 'Cancelled',
  pending: 'Pending',
}

function statusLabel(s) {
  return STATUS_LABELS[s] || s
}

function fmtNum(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('en-GB')
}

function fmtDuration(hours) {
  if (hours == null || Number.isNaN(Number(hours))) return '—'
  const totalMinutes = Math.round(Number(hours) * 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function openDossier(d) {
  router.push({ name: 'dossier', params: { companyNumber: d.companyNumber } })
}

function sparklinePath(values, w = 100, h = 24) {
  if (!values?.length) return ''
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const step = w / (values.length - 1)
  return values
    .map((v, i) => {
      const x = (i * step).toFixed(1)
      const y = (h - ((v - min) / range) * h).toFixed(1)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    })
    .join(' ')
}
</script>

<template>
  <div class="dossiers">
    <header class="page-head">
      <div>
        <h1 class="t-headline">Dossiers</h1>
        <p class="t-meta page-sub">Recent due-diligence files compiled by your team.</p>
      </div>
      <div class="search-input">
        <span class="material-symbols-outlined icon-sm">search</span>
        <input v-model="search" type="text" placeholder="Search subject or company number…" />
      </div>
    </header>

    <div class="filters">
      <button
        v-for="f in FILTERS"
        :key="f.id"
        type="button"
        :class="['chip', { 'chip--active': filter === f.id }]"
        @click="filter = f.id"
      >
        {{ f.label }}
      </button>
      <span class="filter-divider" />
      <button
        v-for="t in TAG_FILTERS"
        :key="t.id || 'all-tags'"
        type="button"
        :class="['chip', { 'chip--active': tag === t.id }]"
        @click="tag = t.id"
      >
        {{ t.label }}
      </button>
    </div>

    <div class="filters filters--case">
      <span class="t-label filter-label">Case status</span>
      <button
        v-for="cs in CASE_STATUS_FILTERS"
        :key="cs.id"
        type="button"
        :class="['chip', { 'chip--active': caseStatus === cs.id }]"
        @click="caseStatus = cs.id"
      >
        {{ cs.label }}
      </button>
    </div>

    <div v-if="kpis" class="kpis">
      <article class="kpi">
        <span class="t-label">Dossiers this month</span>
        <span class="kpi-val tabular">{{ fmtNum(kpis.dossiersThisMonth.value) }}</span>
        <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none">
          <path :d="sparklinePath(kpis.dossiersThisMonth.trend)" />
        </svg>
      </article>
      <article class="kpi">
        <span class="t-label">Avg completion time</span>
        <span class="kpi-val tabular">{{ fmtDuration(kpis.avgCompletionHours.value) }}</span>
        <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none">
          <path :d="sparklinePath(kpis.avgCompletionHours.trend)" />
        </svg>
      </article>
      <article class="kpi kpi--warning">
        <span class="t-label">Flagged for review</span>
        <span class="kpi-val tabular">{{ fmtNum(kpis.flaggedForReview.value) }}</span>
        <svg class="spark spark--amber" viewBox="0 0 100 24" preserveAspectRatio="none">
          <path :d="sparklinePath(kpis.flaggedForReview.trend)" />
        </svg>
      </article>
      <article class="kpi">
        <span class="t-label">OCR pages processed</span>
        <span class="kpi-val tabular">{{ fmtNum(kpis.ocrPagesProcessed.value) }}</span>
        <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none">
          <path :d="sparklinePath(kpis.ocrPagesProcessed.trend)" />
        </svg>
      </article>
    </div>

    <section class="table-section">
      <div class="table-head">
        <div class="th th--subject">Subject</div>
        <div class="th th--status">Status</div>
        <div class="th th--case">Case</div>
        <div class="th th--trigger">Trigger</div>
        <div class="th th--runs">Runs</div>
        <div class="th th--counts">
          <span>Officers</span>
          <span>PSC</span>
          <span>Holders</span>
        </div>
        <div class="th th--risk">Risk</div>
        <div class="th th--date">Last updated</div>
        <div class="th th--owner"></div>
      </div>

      <div v-if="!rows.length" class="empty">
        <span class="t-label empty-title">No dossiers match</span>
        <span class="empty-hint">Try a different filter, or start a new search.</span>
      </div>

      <ul v-else class="rows">
        <li
          v-for="d in rows"
          :key="d.id"
          :class="['row', { 'row--flagged': d.flagged }]"
          @click="openDossier(d)"
        >
          <div class="td td--subject">
            <span class="row-subject">{{ d.subject }}</span>
            <span class="row-num t-mono">{{ d.companyNumber }}</span>
          </div>
          <div class="td td--status">
            <span :class="['status-chip', `status-chip--${d.status}`]">
              {{ statusLabel(d.status) }}
            </span>
          </div>
          <div class="td td--case">
            <span :class="['case-status', `case-status--${d.caseStatus}`]">
              {{ CASE_STATUS_LABELS[d.caseStatus] || d.caseStatus }}
            </span>
          </div>
          <div class="td td--trigger">
            <span :class="['trigger-pill', `trigger-pill--${d.trigger}`]">
              {{ d.trigger }}
            </span>
          </div>
          <div class="td td--runs tabular">{{ d.runCount }}</div>
          <div class="td td--counts tabular">
            <span>{{ d.officers }}</span>
            <span>{{ d.psc }}</span>
            <span>{{ d.shareholders }}</span>
          </div>
          <div class="td td--risk">
            <span :class="['risk', `risk--${d.risk}`]" :title="d.riskTitle">
              <span class="risk-dot" />
              {{ RISK_LABELS[d.risk] || d.risk }}
            </span>
          </div>
          <div class="td td--date tabular">{{ d.lastUpdated }}</div>
          <div class="td td--owner">
            <span class="material-symbols-outlined icon-sm row-chevron">chevron_right</span>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.dossiers {
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
.page-head h1 {
  margin: 0;
}
.page-sub {
  margin: var(--sp-1) 0 0;
}

.search-input {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 320px;
  max-width: 100%;
  height: 38px;
  padding: 0 var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-tertiary);
  transition: border-color var(--dur-fast) var(--ease);
}
.search-input:focus-within {
  border-color: var(--color-primary);
}
.search-input input {
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  font: inherit;
  color: var(--color-text-primary);
  padding: 0;
}
.search-input input::placeholder {
  color: var(--color-text-tertiary);
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  align-items: center;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  height: 30px;
  padding: 0 var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: var(--fs-label);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease),
              color var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease);
}
.chip:hover {
  background: var(--color-page);
  color: var(--color-text-primary);
}
.chip--active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-text-on-primary);
}
.chip--active:hover {
  background: var(--color-primary-hover);
  color: var(--color-text-on-primary);
}
.filter-divider {
  width: 1px;
  height: 16px;
  background: var(--color-border);
  margin: 0 var(--sp-1);
}
.filters--case {
  margin-top: calc(-1 * var(--sp-2));
}
.filter-label {
  color: var(--color-text-tertiary);
  margin-right: var(--sp-2);
  align-self: center;
}

.kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-4);
}
.kpi {
  position: relative;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  overflow: hidden;
}
.kpi-val {
  font-family: var(--font-body);
  font-size: 28px;
  font-weight: 600;
  color: var(--color-text-primary);
  line-height: 1.1;
  letter-spacing: -0.01em;
}
.kpi--warning .kpi-val {
  color: var(--color-tertiary);
}
.kpi-val-row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}
.kpi-unit {
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
}
.spark {
  width: 100%;
  height: 32px;
  margin-top: var(--sp-1);
  fill: none;
  stroke: var(--color-primary);
  stroke-width: 1.5;
  opacity: 0.4;
}
.spark--amber {
  stroke: var(--color-tertiary);
}

@media (max-width: 1100px) {
  .kpis { grid-template-columns: repeat(2, 1fr); }
}

.table-section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.table-head,
.row {
  display: grid;
  grid-template-columns: 2.4fr 1fr 1.1fr 0.9fr 0.55fr 1.6fr 0.9fr 1.1fr 0.55fr;
  align-items: center;
  gap: var(--sp-4);
  padding: 0 var(--sp-6);
}
.table-head {
  height: 44px;
  background: var(--color-page);
  border-bottom: 1px solid var(--color-border);
}
.th {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}
.th--counts {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  text-align: center;
  gap: var(--sp-2);
}
.th--risk { text-align: center; }
.th--owner { text-align: right; }

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.row {
  position: relative;
  height: 64px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease);
}
.row:last-child { border-bottom: 0; }
.row:hover {
  background: var(--color-page);
}
.row:hover .row-chevron {
  color: var(--color-primary);
  transform: translateX(2px);
}
.row--flagged::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--color-tertiary);
}
.td {
  min-width: 0;
}
.td--subject {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.row-subject {
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-num {
  color: var(--color-text-tertiary);
  font-size: var(--fs-meta);
}
.td--counts {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  text-align: center;
  gap: var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--color-text-secondary);
}
.td--risk { text-align: center; }
.td--date {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--color-text-tertiary);
}
.td--owner {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.row-chevron {
  color: var(--color-text-tertiary);
  transition: color var(--dur-fast) var(--ease),
              transform var(--dur-fast) var(--ease);
}

.status-chip {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
}
.status-chip--cleared,
.status-chip--done {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.status-chip--flagged,
.status-chip--failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.status-chip--in_review,
.status-chip--running {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.status-chip--not_found,
.status-chip--pending,
.status-chip--cancelled {
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
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

.th--trigger,
.th--runs { text-align: left; }
.td--runs {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  color: var(--color-text-secondary);
}

.th--case { text-align: left; }
.td--case { min-width: 0; }

.risk {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: 12px;
  font-weight: 500;
  text-transform: capitalize;
  color: var(--color-text-secondary);
}
.risk-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
}
.risk--low .risk-dot { background: var(--color-success); }
.risk--medium .risk-dot { background: var(--color-tertiary); }
.risk--high .risk-dot { background: var(--color-danger); }
.risk--high { color: var(--color-danger); }
.risk--prohibited .risk-dot { background: var(--color-danger); }
.risk--prohibited { color: var(--color-danger); font-weight: 600; }
.risk--unavailable { color: var(--color-text-tertiary); }

.empty {
  padding: var(--sp-12) var(--sp-6);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
}
.empty-title {
  font-size: var(--fs-title);
  color: var(--color-text-secondary);
}
.empty-hint {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
}
</style>
