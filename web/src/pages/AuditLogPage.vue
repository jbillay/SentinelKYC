<script setup>
// Phase 5 / Q5 — immutable audit feed.
//
// Source: GET /api/audit, which streams decision_fragments joined to
// dossier/run rows, newest first. The "Human actions only" chip flips the
// `kind=human_action` query param so reviewers can isolate their own
// approvals / rejections / escalations / info requests.

import { computed, ref, watch } from 'vue'

const fragments = ref([])
const loading = ref(false)
const error = ref(null)
const kindFilter = ref('all') // 'all' | 'human_action' | 'decision'

async function fetchAudit() {
  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams()
    if (kindFilter.value && kindFilter.value !== 'all') {
      params.set('kind', kindFilter.value)
    }
    params.set('limit', '250')
    const res = await fetch(`/api/audit?${params.toString()}`)
    if (!res.ok) throw new Error(`audit failed: ${res.status}`)
    fragments.value = await res.json()
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

watch(kindFilter, fetchAudit)
fetchAudit()

const KIND_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'human_action', label: 'Human actions only' },
  { id: 'decision', label: 'Decisions' },
]

const ACTION_TONE = {
  approve: 'success',
  reject: 'danger',
  escalate: 'warning',
  request_info: 'primary',
}

function actionFor(frag) {
  const a = frag.inputs?.action || frag.outputs?.action
  return a || null
}

function fragmentTone(frag) {
  if (frag.kind === 'human_action') {
    return ACTION_TONE[actionFor(frag)] || 'primary'
  }
  if (frag.status === 'failed') return 'danger'
  if (frag.kind === 'decision') return 'primary'
  return 'neutral'
}

function actionLabel(frag) {
  if (frag.kind === 'human_action') {
    const a = actionFor(frag)
    if (a === 'approve') return 'Approved'
    if (a === 'reject') return 'Rejected'
    if (a === 'escalate') return 'Escalated'
    if (a === 'request_info') return 'Requested info'
    return frag.nodeId
  }
  return frag.nodeId?.replace(/_/g, ' ') || 'fragment'
}

function actor(frag) {
  if (frag.kind === 'human_action') {
    return frag.inputs?.userId || 'local-user'
  }
  return 'agent'
}

function initials(name) {
  if (!name) return '?'
  return name
    .split(/[\s-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('')
}

const rows = computed(() => fragments.value || [])

function fmtTs(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().replace('T', ' ').slice(0, 19)
}
</script>

<template>
  <div class="audit">
    <header class="page-head">
      <div>
        <h1 class="t-headline">Audit log</h1>
        <p class="t-meta page-sub">Immutable record of every action taken on a dossier.</p>
      </div>
      <div class="page-actions">
        <div class="lock">
          <span class="material-symbols-outlined icon-sm">lock</span>
          <span class="t-label">Read-only</span>
        </div>
      </div>
    </header>

    <div class="filters">
      <button
        v-for="f in KIND_FILTERS"
        :key="f.id"
        type="button"
        :class="['chip', { 'chip--active': kindFilter === f.id }]"
        @click="kindFilter = f.id"
      >
        {{ f.label }}
      </button>
    </div>

    <div v-if="error" class="banner-error" role="alert">{{ error }}</div>

    <section class="log-sheet">
      <div v-if="loading && !rows.length" class="empty t-meta">Loading audit feed…</div>
      <div v-else-if="!rows.length" class="empty t-meta">No audit events.</div>
      <ul v-else class="events">
        <li
          v-for="e in rows"
          :key="e.id"
          :class="['event', { 'event--human': e.kind === 'human_action' }]"
        >
          <div class="event-time t-mono tabular">{{ fmtTs(e.startedAt) }}</div>
          <div class="event-actor">
            <span
              :class="['avatar', e.kind === 'human_action' ? 'avatar--human' : 'avatar--agent']"
            >
              <span v-if="e.kind === 'human_action'" class="material-symbols-outlined icon-sm">person</span>
              <span v-else>{{ initials(actor(e)) }}</span>
            </span>
            <div>
              <div class="actor-name">{{ actor(e) }}</div>
              <div class="actor-id t-mono">{{ e.id.slice(0, 8) }}</div>
            </div>
          </div>
          <div class="event-action">
            <span :class="['action-tag', `action-tag--${fragmentTone(e)}`]">
              {{ actionLabel(e) }}
            </span>
            <div class="event-target">
              <RouterLink
                :to="{ name: 'run-detail', params: { companyNumber: e.companyNumber, runId: e.runId } }"
                class="event-subject-link"
              >
                <span class="event-subject">{{ e.companyName || e.companyNumber }}</span>
                <span class="event-subject-id t-mono">#{{ e.companyNumber }}</span>
              </RouterLink>
              <p class="event-summary">{{ e.summary }}</p>
            </div>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.audit {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: var(--sp-4);
}
.page-head h1 { margin: 0; }
.page-sub { margin: var(--sp-1) 0 0; }

.page-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.lock {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-3);
  background: var(--color-surface-sunken);
  border-radius: var(--radius-pill);
  color: var(--color-text-secondary);
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
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

.banner-error {
  border-left: 4px solid var(--color-danger);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border-radius: var(--radius-md);
  padding: var(--sp-3) var(--sp-4);
}

.log-sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.event {
  display: grid;
  grid-template-columns: 180px 220px 1fr;
  gap: var(--sp-4);
  align-items: flex-start;
  padding: var(--sp-4) var(--sp-6);
  border-bottom: 1px solid var(--color-border);
}
.event:last-child { border-bottom: 0; }
.event--human {
  background: #faf6ff;
}

.event-time {
  font-size: var(--fs-mono);
  color: var(--color-text-secondary);
  padding-top: 4px;
}

.event-actor {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.avatar--agent {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.avatar--human {
  background: #ede4f6;
  color: #6b3aa8;
}
.actor-name {
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-primary);
}
.actor-id {
  font-size: 11px;
  color: var(--color-text-tertiary);
  margin-top: 2px;
}

.event-action {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.action-tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
  width: fit-content;
}
.action-tag--primary { background: var(--color-primary-soft); color: var(--color-primary); }
.action-tag--success { background: var(--color-success-soft); color: var(--color-success); }
.action-tag--warning { background: var(--color-warning-soft); color: var(--color-warning); }
.action-tag--danger { background: var(--color-danger-soft); color: var(--color-danger); }

.event-target {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.event-subject-link {
  display: inline-flex;
  gap: var(--sp-2);
  align-items: baseline;
  color: inherit;
}
.event-subject-link:hover .event-subject {
  color: var(--color-primary);
  text-decoration: underline;
}
.event-subject {
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-primary);
}
.event-subject-id {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
}
.event-summary {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.empty {
  padding: var(--sp-12) var(--sp-6);
  text-align: center;
}
</style>
