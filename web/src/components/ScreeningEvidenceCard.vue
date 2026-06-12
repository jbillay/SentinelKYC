<script setup>
import { computed } from 'vue'

const props = defineProps({
  // Pass the agent store's screening slice directly:
  //   { subjects, hits, evaluations, currentSubjectId, currentList, screenedByList, lastEvents }
  screening: { type: Object, required: true },
})

const LIST_LABEL = {
  ofac_sdn: 'OFAC SDN',
  uk_hmt: 'UK HMT',
  adverse_media: 'Adverse media',
}

const totalSubjects = computed(() => props.screening.subjects.length)

const subjectsByList = computed(() => {
  // Per-list "subjects screened so far" — the store accumulates these from
  // screening_subject_started events into `screenedByList` (cumulative, unlike
  // `lastEvents` which is a capped rolling window for the live feed).
  const src = props.screening.screenedByList || {}
  return {
    ofac_sdn: Object.keys(src.ofac_sdn || {}).length,
    uk_hmt: Object.keys(src.uk_hmt || {}).length,
    adverse_media: Object.keys(src.adverse_media || {}).length,
  }
})

function progressPct(list) {
  const t = totalSubjects.value
  if (!t) return 0
  const seen = subjectsByList.value[list] || 0
  return Math.min(100, Math.round((seen / t) * 100))
}

const evalsByHit = computed(() => {
  const m = new Map()
  for (const e of props.screening.evaluations) m.set(e.hitId, e)
  return m
})

const counts = computed(() => {
  const c = { confirmed: 0, needs_review: 0, dismissed: 0, evaluating: 0 }
  for (const h of props.screening.hits) {
    const id = h.hitId || h.id
    const ev = evalsByHit.value.get(id)
    if (!ev) c.evaluating += 1
    else if (ev.decision === 'confirmed') c.confirmed += 1
    else if (ev.decision === 'needs_review') c.needs_review += 1
    else if (ev.decision === 'dismissed') c.dismissed += 1
  }
  return c
})

const currentSubjectName = computed(() => {
  const id = props.screening.currentSubjectId
  if (!id) return null
  const s = props.screening.subjects.find((x) => x.id === id)
  return s?.name || id
})

const recentHits = computed(() => {
  // Show the latest 5 hits with their (potentially still missing) evaluation.
  const list = [...props.screening.hits].slice(-5).reverse()
  return list.map((h) => {
    const id = h.hitId || h.id
    const ev = evalsByHit.value.get(id)
    return {
      id,
      subjectName: h.subjectName,
      list: h.listSource,
      score: h.matchScore,
      decision: ev?.decision || null,
    }
  })
})

function decisionLabel(d) {
  if (!d) return 'Evaluating…'
  if (d === 'confirmed') return 'Confirmed'
  if (d === 'needs_review') return 'Needs review'
  if (d === 'dismissed') return 'Dismissed'
  return d
}

function decisionTone(d) {
  if (d === 'confirmed') return 'danger'
  if (d === 'needs_review') return 'warn'
  if (d === 'dismissed') return 'muted'
  return 'primary'
}
</script>

<template>
  <article class="evidence">
    <header class="head">
      <div class="head-left">
        <span class="t-label">Screening — live</span>
        <span class="head-counter">{{ totalSubjects }} subject{{ totalSubjects === 1 ? '' : 's' }} identified</span>
      </div>
      <span class="stream-badge">
        <span class="stream-dot" />
        Stream active
      </span>
    </header>

    <div class="body">
      <section class="lists">
        <div v-for="list in ['ofac_sdn', 'uk_hmt', 'adverse_media']" :key="list" class="list-row">
          <div class="list-row-head">
            <span class="list-label">{{ LIST_LABEL[list] }}</span>
            <span class="list-count tabular t-mono">{{ subjectsByList[list] }}/{{ totalSubjects }}</span>
          </div>
          <div class="bar">
            <span class="bar-fill" :style="{ width: progressPct(list) + '%' }" />
          </div>
        </div>
      </section>

      <section class="counters">
        <span class="chip chip--danger">
          <span class="dot" />
          {{ counts.confirmed }} confirmed
        </span>
        <span class="chip chip--warn">
          <span class="dot" />
          {{ counts.needs_review }} need review
        </span>
        <span class="chip chip--muted">
          <span class="dot" />
          {{ counts.dismissed }} dismissed
        </span>
        <span v-if="counts.evaluating > 0" class="chip chip--primary">
          <span class="dot" />
          {{ counts.evaluating }} evaluating
        </span>
      </section>

      <section v-if="currentSubjectName" class="current">
        <span class="t-label">Currently evaluating</span>
        <span class="current-name">{{ currentSubjectName }}</span>
        <span v-if="screening.currentList" class="current-list">on {{ LIST_LABEL[screening.currentList] || screening.currentList }}</span>
      </section>

      <section v-if="recentHits.length" class="feed">
        <span class="t-label">Recent hits</span>
        <ul class="feed-list">
          <li v-for="h in recentHits" :key="h.id" class="feed-item">
            <span class="feed-name">{{ h.subjectName }}</span>
            <span class="feed-list-name">{{ LIST_LABEL[h.list] || h.list }}</span>
            <span v-if="h.score != null" class="feed-score t-mono">{{ Number(h.score).toFixed(2) }}</span>
            <span :class="['feed-decision', `feed-decision--${decisionTone(h.decision)}`]">{{ decisionLabel(h.decision) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </article>
</template>

<style scoped>
.evidence {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-page);
}
.head-left {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}
.head-counter {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
}
.stream-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-primary);
}
.stream-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: stream-pulse 1.6s ease-in-out infinite;
}
@keyframes stream-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(11, 61, 145, 0.4); }
  50% { box-shadow: 0 0 0 4px rgba(11, 61, 145, 0); }
}

.body {
  padding: var(--sp-4) var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.lists { display: flex; flex-direction: column; gap: var(--sp-3); }
.list-row { display: flex; flex-direction: column; gap: var(--sp-1); }
.list-row-head { display: flex; justify-content: space-between; }
.list-label { font-size: var(--fs-body); color: var(--color-text-primary); }
.list-count { font-size: var(--fs-meta); color: var(--color-text-tertiary); }
.bar {
  height: 6px;
  background: var(--color-surface-sunken);
  border-radius: var(--radius-pill);
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  background: var(--color-primary);
  border-radius: var(--radius-pill);
  transition: width 360ms cubic-bezier(0.2, 0, 0, 1);
}

.counters { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--fs-meta);
  font-weight: 500;
}
.chip .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.chip--danger { background: var(--color-danger-soft); color: var(--color-danger); }
.chip--warn { background: var(--color-warning-soft, #fef3c7); color: var(--color-warning, #b45309); }
.chip--muted { background: var(--color-surface-sunken); color: var(--color-text-tertiary); }
.chip--primary { background: var(--color-primary-soft); color: var(--color-primary); }

.current { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); }
.current-name { font-weight: 600; color: var(--color-text-primary); }
.current-list { color: var(--color-text-tertiary); font-size: var(--fs-meta); }

.feed { display: flex; flex-direction: column; gap: var(--sp-2); }
.feed-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.feed-item {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  align-items: baseline;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-page);
}
.feed-name { font-weight: 500; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feed-list-name { font-size: var(--fs-meta); color: var(--color-text-tertiary); }
.feed-score { font-size: var(--fs-meta); color: var(--color-text-tertiary); }
.feed-decision { font-size: var(--fs-meta); font-weight: 500; }
.feed-decision--danger { color: var(--color-danger); }
.feed-decision--warn { color: var(--color-warning, #b45309); }
.feed-decision--muted { color: var(--color-text-tertiary); }
.feed-decision--primary { color: var(--color-primary); }
</style>
