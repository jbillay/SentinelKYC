<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  // The riskAssessment object from runs.final_risk_assessment.
  assessment: { type: Object, default: null },
  // Frozen run (RunDetailPage) — hide the recalculate button.
  readonly: { type: Boolean, default: false },
  // True while a recalculate request is in flight (drives the button label).
  recalculating: { type: Boolean, default: false },
  // 'llm' | 'template' — provenance of the rationale text, if known.
  rationaleSource: { type: String, default: null },
})

const emit = defineEmits(['recalculate'])

const showReceipt = ref(false)

const a = computed(() => props.assessment || null)

// The badge shows the outcome (Low/Medium/High/Prohibited); when the outcome
// differs from the raw score tier (a knockout fired), note the tier alongside.
const outcomeLabel = computed(() => a.value?.outcome || a.value?.tier || '—')
const tierDiffers = computed(
  () => a.value && a.value.outcome && a.value.tier && a.value.outcome !== a.value.tier
)
const outcomeKey = computed(() => String(outcomeLabel.value).toLowerCase())

const score = computed(() => {
  const s = a.value?.score
  return typeof s === 'number' ? Math.round(s) : null
})

const previousScore = computed(() => {
  const p = a.value?.receipt?.trajectory?.previousScore
  return typeof p === 'number' ? Math.round(p) : null
})

const delta = computed(() => {
  const d = a.value?.deltaFromPrevious
  return typeof d === 'number' && Number.isFinite(d) ? d : null
})

const deltaTone = computed(() => {
  const d = delta.value
  if (d == null) return null
  if (d <= -5) return 'down'
  if (d >= 15 && a.value?.deltaFlagged) return 'up-flagged'
  return 'up'
})

const deltaLabel = computed(() => {
  const d = delta.value
  if (d == null) return null
  const sign = d > 0 ? '+' : ''
  const rounded = Math.round(d * 10) / 10
  return `${sign}${rounded}`
})

const factors = computed(() => a.value?.factors || [])
const knockouts = computed(() => a.value?.knockoutsTriggered || [])
const warnings = computed(() => a.value?.receipt?.warnings || [])

const KNOCKOUT_LABEL = {
  screeningProhibited: 'Confirmed sanctions hit — outcome forced to Prohibited',
  screeningHighOverride: 'Screening risk high — tier forced to High',
  screeningMediumFloor: 'Screening risk medium — tier floored at Medium',
}

const matrixVersion = computed(() => a.value?.matrixVersion ?? null)

const calculatedAt = computed(() => {
  const ts = a.value?.calculatedAt
  if (!ts) return null
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
})

const receiptJson = computed(() => {
  if (!a.value?.receipt) return ''
  try {
    return JSON.stringify(a.value.receipt, null, 2)
  } catch {
    return ''
  }
})

function pct(w) {
  if (typeof w !== 'number') return '—'
  return `${Math.round(w * 100)}%`
}

function num(n) {
  if (typeof n !== 'number') return '—'
  return Math.round(n * 100) / 100
}

function factorAttribute(f) {
  const at = f?.attribute || {}
  switch (f?.factor) {
    case 'geographic':
      if (at.matched && at.iso2) return `${at.label || at.iso2} (${at.iso2})`
      if (at.label) return `${at.label} — unrecognised (default)`
      return 'Country not stated (default)'
    case 'entityType':
      if (at.matched) return at.type
      return `${at.type || at.rawType || 'unknown'} — unmapped (default)`
    case 'structuralComplexity':
      return `${at.corporatePscCount ?? 0} corporate PSC · ${at.shareholderLayers ?? 1} ownership layer${(at.shareholderLayers ?? 1) === 1 ? '' : 's'}`
    case 'industry':
      if (at.matched) return `${at.label || at.prefix} (SIC ${at.sicCode})`
      return 'No SIC match (default)'
    default:
      return at && Object.keys(at).length ? JSON.stringify(at) : '—'
  }
}
</script>

<template>
  <section class="risk-card">
    <header class="risk-head">
      <div class="risk-head-left">
        <span :class="['risk-badge', `risk-tier-${outcomeKey}`]">{{ outcomeLabel }}</span>
        <span v-if="tierDiffers" class="t-meta tier-note">score tier: {{ a.tier }}</span>
      </div>
      <div class="risk-head-right">
        <div class="score-wrap">
          <span class="score tabular">{{ score ?? '—' }}</span>
          <span class="score-of">/ 100</span>
        </div>
        <span v-if="delta != null" :class="['delta-chip', `delta-chip--${deltaTone}`]">
          <span class="material-symbols-outlined icon-sm">
            {{ deltaTone === 'down' ? 'trending_down' : 'trending_up' }}
          </span>
          {{ deltaLabel }}
          <span v-if="previousScore != null" class="delta-prev">vs {{ previousScore }}</span>
          <span v-if="deltaTone === 'up-flagged'" class="delta-flag" title="Notable risk increase">!</span>
        </span>
        <span v-else class="t-meta no-prev">no prior run</span>
        <button
          v-if="!readonly"
          type="button"
          class="btn btn--secondary btn--sm"
          :disabled="recalculating"
          title="Recompute the score for the latest run against the currently active matrix. Does not re-fetch Companies House or re-screen."
          @click="emit('recalculate')"
        >
          <span class="material-symbols-outlined icon-sm">calculate</span>
          {{ recalculating ? 'Recalculating…' : 'Recalculate' }}
        </button>
      </div>
    </header>

    <div v-if="!a" class="risk-empty">Not yet assessed — this run pre-dates the risk engine.</div>

    <template v-else>
      <ul v-if="knockouts.length" class="knockouts">
        <li v-for="k in knockouts" :key="k" class="knockout">
          <span class="material-symbols-outlined icon-sm">gavel</span>
          {{ KNOCKOUT_LABEL[k] || k }}
        </li>
      </ul>

      <p v-if="a.rationale" class="rationale">
        {{ a.rationale }}
        <span v-if="rationaleSource === 'template'" class="t-meta rationale-src">(generated offline — LLM rationale unavailable)</span>
      </p>

      <table class="factor-table">
        <thead>
          <tr>
            <th>Factor</th>
            <th>Attribute</th>
            <th class="num">Weight</th>
            <th class="num">Base score</th>
            <th class="num">Contribution</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in factors" :key="f.factor">
            <td>{{ f.label || f.factor }}</td>
            <td class="attr">{{ factorAttribute(f) }}</td>
            <td class="num tabular">{{ pct(f.weight) }}</td>
            <td class="num tabular">{{ num(f.baseScore) }}</td>
            <td class="num tabular">{{ num(f.contribution) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="4">Score (before knockouts)</td>
            <td class="num tabular">{{ num(a.receipt?.scoreBeforeKnockouts ?? a.score) }}</td>
          </tr>
        </tfoot>
      </table>

      <ul v-if="warnings.length" class="warnings">
        <li v-for="(w, i) in warnings" :key="i" class="warning">
          <span class="material-symbols-outlined icon-sm">info</span>{{ w }}
        </li>
      </ul>

      <div class="receipt">
        <button type="button" class="receipt-toggle" @click="showReceipt = !showReceipt">
          <span class="material-symbols-outlined icon-sm">{{ showReceipt ? 'expand_less' : 'expand_more' }}</span>
          {{ showReceipt ? 'Hide' : 'Show' }} calculation receipt (JSON)
        </button>
        <pre v-if="showReceipt" class="receipt-json t-mono">{{ receiptJson }}</pre>
      </div>

      <footer class="risk-foot">
        <RouterLink :to="{ name: 'settings', hash: '#risk-matrix' }" class="matrix-link">
          Matrix v{{ matrixVersion ?? '–' }}
        </RouterLink>
        <span v-if="calculatedAt" class="t-meta">Calculated {{ calculatedAt }}</span>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.risk-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.risk-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
}
.risk-head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.risk-head-right {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex-wrap: wrap;
}

.risk-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--fs-meta);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.tier-note { text-transform: none; }

.score-wrap {
  display: inline-flex;
  align-items: baseline;
  gap: var(--sp-1);
}
.score {
  font-family: var(--font-display);
  font-size: 40px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--color-text-primary);
}
.score-of {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
}

.delta-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px var(--sp-2);
  border-radius: var(--radius-pill);
  font-size: var(--fs-meta);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.delta-chip--down { background: var(--color-success-soft); color: var(--color-success); }
.delta-chip--up { background: var(--color-warning-soft, #fbf1e1); color: var(--color-warning, #b45309); }
.delta-chip--up-flagged { background: var(--color-danger-soft); color: var(--color-danger); }
.delta-prev { font-weight: 400; opacity: 0.8; }
.delta-flag { font-weight: 800; }
.no-prev { font-size: var(--fs-meta); }

.btn--sm {
  padding: 6px var(--sp-3);
  font-size: var(--fs-meta);
}

.risk-empty {
  padding: var(--sp-4);
  color: var(--color-text-tertiary);
  font-size: var(--fs-meta);
}

.knockouts,
.warnings {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.knockout {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--fs-meta);
  font-weight: 500;
}
.warning {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--color-text-tertiary);
  font-size: var(--fs-meta);
}

.rationale {
  margin: 0;
  line-height: 1.6;
  color: var(--color-text-primary);
}
.rationale-src { display: block; margin-top: var(--sp-1); }

.factor-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-body);
}
.factor-table th,
.factor-table td {
  text-align: left;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--color-border);
}
.factor-table th {
  font-size: var(--fs-label);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}
.factor-table .num { text-align: right; }
.factor-table .attr { color: var(--color-text-secondary); }
.factor-table tfoot td {
  border-bottom: 0;
  font-weight: 600;
  color: var(--color-text-primary);
}

.receipt-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  color: var(--color-primary);
  font-size: var(--fs-meta);
  font-weight: 500;
}
.receipt-json {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-3);
  background: var(--color-page);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  max-height: 360px;
  overflow: auto;
  color: var(--color-text-secondary);
}

.risk-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--color-border);
}
.matrix-link {
  font-size: var(--fs-meta);
  font-weight: 500;
}
</style>
