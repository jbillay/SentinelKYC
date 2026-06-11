<script setup>
import { computed, ref, toRef } from 'vue'
import { useScreening } from '../composables/useScreening.js'
import ScreeningHitPanel from './ScreeningHitPanel.vue'

const props = defineProps({
  companyNumber: { type: String, required: true },
  runId: { type: String, required: true },
  // Frozen runs (RunDetailPage): no override actions, no rescreen.
  readonly: { type: Boolean, default: false },
  // Last screened-at to display in the top strip — typically run.endedAt.
  lastScreenedAt: { type: [String, Number, Date], default: null },
})

const cnRef = toRef(props, 'companyNumber')
const ridRef = toRef(props, 'runId')

const {
  report,
  subjectGroups,
  loading,
  error,
  setOverride,
  carryOverridesForward,
  rescreen,
} = useScreening(cnRef, ridRef)

const LIST_LABEL = {
  ofac_sdn: 'OFAC SDN',
  uk_hmt: 'UK HMT',
  adverse_media: 'Adverse media',
}

// Filters
const statusFilter = ref(new Set(['confirmed', 'needs_review'])) // dismissed hidden by default per SCREENING_PLAN.md §6
const listFilter = ref('all')
const roleFilter = ref('all')

const allLists = ['ofac_sdn', 'uk_hmt', 'adverse_media']
const allRoles = ['company', 'officer', 'psc', 'shareholder']

function toggleStatus(s) {
  const next = new Set(statusFilter.value)
  if (next.has(s)) next.delete(s)
  else next.add(s)
  statusFilter.value = next
}

const filteredSubjectGroups = computed(() => {
  return subjectGroups.value
    .map((g) => {
      const filteredHits = g.hits.filter((h) => {
        if (!statusFilter.value.has(h.effective)) return false
        if (listFilter.value !== 'all' && h.listSource !== listFilter.value) return false
        return true
      })
      return { ...g, hits: filteredHits }
    })
    .filter((g) => {
      if (roleFilter.value !== 'all' && g.kind !== roleFilter.value) return false
      return g.hits.length > 0
    })
})

const summary = computed(() => report.value?.summary || null)

function fmtDate(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString()
}

const overrideError = ref(null)
const carryStatus = ref(null)
const rescreenError = ref(null)

async function onOverride({ hitId, decision, reason }) {
  overrideError.value = null
  try {
    await setOverride(hitId, decision, reason)
  } catch (err) {
    overrideError.value = err.message
  }
}

async function onCarryForward() {
  carryStatus.value = null
  try {
    const res = await carryOverridesForward()
    carryStatus.value = `${res.carried} override${res.carried === 1 ? '' : 's'} carried forward`
  } catch (err) {
    carryStatus.value = `Failed: ${err.message}`
  }
}

async function onRescreen() {
  rescreenError.value = null
  try {
    await rescreen()
  } catch (err) {
    rescreenError.value = err.message
  }
}

function riskTone(r) {
  if (r === 'high') return 'danger'
  if (r === 'medium') return 'warn'
  return 'success'
}

function roleLabel(kind) {
  if (kind === 'company') return 'Company'
  if (kind === 'officer') return 'Officer'
  if (kind === 'psc') return 'PSC'
  if (kind === 'shareholder') return 'Shareholder'
  return kind || '—'
}
</script>

<template>
  <section class="screening">
    <div v-if="loading" class="state">Loading screening…</div>
    <div v-else-if="error" class="state state--error">Failed to load screening: {{ error }}</div>
    <div v-else-if="!summary" class="state">No screening report on this run.</div>

    <template v-else>
      <header class="strip">
        <div class="strip-left">
          <span :class="['risk', `risk--${riskTone(summary.overallRisk)}`]">
            <span class="risk-dot" />
            Risk · {{ summary.overallRisk }}
          </span>
          <div class="totals">
            <span class="total"><strong>{{ summary.confirmedHits }}</strong> confirmed</span>
            <span class="total"><strong>{{ summary.needsReview }}</strong> need review</span>
            <span class="total"><strong>{{ summary.dismissedHits }}</strong> dismissed</span>
            <span class="total total--muted">{{ summary.subjectCount }} subject{{ summary.subjectCount === 1 ? '' : 's' }}</span>
          </div>
        </div>
        <div class="strip-right">
          <span v-if="lastScreenedAt" class="last-screened">Last screened {{ fmtDate(lastScreenedAt) || '—' }}</span>
          <button v-if="!readonly" type="button" class="btn btn--ghost" @click="onCarryForward">Carry overrides forward</button>
          <button v-if="!readonly" type="button" class="btn btn--primary" @click="onRescreen">Rescreen</button>
        </div>
      </header>

      <div v-if="overrideError" class="banner banner--error">Override failed: {{ overrideError }}</div>
      <div v-if="rescreenError" class="banner banner--error">Rescreen failed: {{ rescreenError }}</div>
      <div v-if="carryStatus" class="banner">{{ carryStatus }}</div>

      <div class="filters">
        <div class="filter-group">
          <span class="t-label">Status</span>
          <div class="chips">
            <button
              v-for="s in ['confirmed', 'needs_review', 'dismissed']"
              :key="s"
              type="button"
              :class="['chip', { 'chip--active': statusFilter.has(s) }]"
              @click="toggleStatus(s)"
            >{{ s === 'needs_review' ? 'Needs review' : (s.charAt(0).toUpperCase() + s.slice(1)) }}</button>
          </div>
        </div>
        <div class="filter-group">
          <span class="t-label">List</span>
          <div class="chips">
            <button type="button" :class="['chip', { 'chip--active': listFilter === 'all' }]" @click="listFilter = 'all'">All</button>
            <button v-for="l in allLists" :key="l" type="button" :class="['chip', { 'chip--active': listFilter === l }]" @click="listFilter = l">{{ LIST_LABEL[l] }}</button>
          </div>
        </div>
        <div class="filter-group">
          <span class="t-label">Role</span>
          <div class="chips">
            <button type="button" :class="['chip', { 'chip--active': roleFilter === 'all' }]" @click="roleFilter = 'all'">All</button>
            <button v-for="r in allRoles" :key="r" type="button" :class="['chip', { 'chip--active': roleFilter === r }]" @click="roleFilter = r">{{ roleLabel(r) }}</button>
          </div>
        </div>
      </div>

      <div v-if="!filteredSubjectGroups.length" class="state">No hits match the current filters.</div>

      <ul class="subjects">
        <li v-for="g in filteredSubjectGroups" :key="g.subjectId" class="subject">
          <header class="subject-head">
            <div class="subject-meta">
              <span class="subject-name">{{ g.name }}</span>
              <span class="subject-role">{{ roleLabel(g.kind) }}</span>
            </div>
            <div class="subject-buckets">
              <span v-if="g.buckets" class="bucket">
                <span class="bucket-label">Sanctions</span>
                <span class="bucket-counts">
                  <span v-if="g.buckets.sanctions.confirmed">{{ g.buckets.sanctions.confirmed }} confirmed</span>
                  <span v-if="g.buckets.sanctions.needsReview">{{ g.buckets.sanctions.needsReview }} review</span>
                  <span v-if="g.buckets.sanctions.dismissed">{{ g.buckets.sanctions.dismissed }} dismissed</span>
                </span>
              </span>
              <span v-if="g.buckets" class="bucket">
                <span class="bucket-label">Adverse media</span>
                <span class="bucket-counts">
                  <span v-if="g.buckets.adverseMedia.confirmed">{{ g.buckets.adverseMedia.confirmed }} confirmed</span>
                  <span v-if="g.buckets.adverseMedia.needsReview">{{ g.buckets.adverseMedia.needsReview }} review</span>
                  <span v-if="g.buckets.adverseMedia.dismissed">{{ g.buckets.adverseMedia.dismissed }} dismissed</span>
                </span>
              </span>
            </div>
          </header>
          <ul class="hits">
            <li v-for="h in g.hits" :key="h.id">
              <ScreeningHitPanel :hit="h" :readonly="readonly" @override="onOverride" />
            </li>
          </ul>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.screening { display: flex; flex-direction: column; gap: var(--sp-4); }

.state { padding: var(--sp-6); text-align: center; color: var(--color-text-tertiary); }
.state--error { color: var(--color-danger); }

.strip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.strip-left { display: flex; align-items: center; gap: var(--sp-4); flex-wrap: wrap; }
.strip-right { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }

.risk {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--fs-meta);
  font-weight: 600;
  text-transform: capitalize;
}
.risk-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.risk--danger { background: var(--color-danger-soft); color: var(--color-danger); }
.risk--warn { background: var(--color-warning-soft, #fef3c7); color: var(--color-warning, #b45309); }
.risk--success { background: var(--color-success-soft); color: var(--color-success); }

.totals { display: flex; align-items: baseline; gap: var(--sp-3); flex-wrap: wrap; }
.total { color: var(--color-text-secondary); font-size: var(--fs-meta); }
.total strong { color: var(--color-text-primary); font-weight: 600; }
.total--muted { color: var(--color-text-tertiary); }
.last-screened { color: var(--color-text-tertiary); font-size: var(--fs-meta); }

.btn {
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-size: var(--fs-meta);
  font-weight: 500;
  cursor: pointer;
}
.btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
.btn--primary { background: var(--color-primary); color: var(--color-text-on-primary); border-color: var(--color-primary); }
.btn--primary:hover { color: var(--color-text-on-primary); }
.btn--ghost { background: transparent; }

.banner {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: var(--fs-meta);
}
.banner--error { background: var(--color-danger-soft); color: var(--color-danger); }

.filters { display: flex; gap: var(--sp-4); flex-wrap: wrap; align-items: flex-start; }
.filter-group { display: flex; flex-direction: column; gap: var(--sp-1); }
.chips { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
.chip {
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--fs-meta);
  cursor: pointer;
}
.chip--active { background: var(--color-primary); color: var(--color-text-on-primary); border-color: var(--color-primary); }

.subjects { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.subject {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden;
}
.subject-head {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-page);
}
.subject-meta { display: flex; align-items: baseline; gap: var(--sp-3); }
.subject-name { font-weight: 600; color: var(--color-text-primary); }
.subject-role { color: var(--color-text-tertiary); font-size: var(--fs-meta); text-transform: uppercase; letter-spacing: 0.04em; }
.subject-buckets { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
.bucket { display: flex; flex-direction: column; gap: 2px; }
.bucket-label { font-size: 11px; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
.bucket-counts { display: flex; gap: var(--sp-2); color: var(--color-text-secondary); font-size: var(--fs-meta); }

.hits { list-style: none; margin: 0; padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
</style>
