<script setup>
// Phase 5 / Q5 — Final Decision Panel (read-only for frozen runs).
//
// Mounted on RunDetailPage. Renders just the QA banner + highlighted issues
// from runs.qa_result, without any action buttons. The interactive panel is
// only ever bound to the latest run on DossierViewPage.

import { computed } from 'vue'

const props = defineProps({
  qaResult: { type: Object, default: null },
  caseStatus: { type: String, default: null },
})

const routing = computed(() => props.qaResult?.routing?.caseStatus || null)
const summary = computed(
  () => props.qaResult?.qaSummary || props.qaResult?.routing?.qaSummary || ''
)
const highlightedIssues = computed(() => props.qaResult?.highlightedIssues || [])

const bannerTone = computed(() => {
  if (routing.value === 'auto_approved') return 'ok'
  if (routing.value === 'streamlined_review') return 'info'
  if (routing.value === 'standard_review') return 'warn'
  return 'info'
})

const BANNER_LABEL = {
  auto_approved: 'QA passed — auto-approved',
  streamlined_review: 'QA passed — streamlined review',
  standard_review: 'QA flagged issues — standard review',
}
const bannerLabel = computed(() => BANNER_LABEL[routing.value] || 'QA result')
</script>

<template>
  <div v-if="qaResult" class="decision-panel" :class="`decision-panel--${bannerTone}`">
    <header class="banner">
      <div class="banner-main">
        <span class="material-symbols-outlined banner-icon">
          {{ bannerTone === 'ok' ? 'verified' : bannerTone === 'warn' ? 'warning' : 'info' }}
        </span>
        <div class="banner-text">
          <div class="banner-label t-label">{{ bannerLabel }}</div>
          <p class="banner-summary">{{ summary }}</p>
          <span v-if="caseStatus" :class="['case-status', `case-status--${caseStatus}`]">
            {{ caseStatus.replace('_', ' ') }}
          </span>
        </div>
      </div>
    </header>

    <ul v-if="highlightedIssues.length" class="issues">
      <li
        v-for="(issue, idx) in highlightedIssues"
        :key="`${issue.code}-${idx}`"
        :class="['issue', `issue--${issue.severity}`]"
      >
        <span class="material-symbols-outlined icon-sm">
          {{ issue.severity === 'high' ? 'priority_high' : issue.severity === 'medium' ? 'error' : 'info' }}
        </span>
        <span class="issue-msg">{{ issue.message }}</span>
        <span class="t-mono issue-code">{{ issue.code }}</span>
      </li>
    </ul>
  </div>

  <div v-else class="empty t-meta">No QA result captured for this run.</div>
</template>

<style scoped>
.decision-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  border-left: 4px solid var(--color-border-strong);
  padding-left: var(--sp-4);
}
.decision-panel--ok { border-left-color: var(--color-success); }
.decision-panel--info { border-left-color: var(--color-primary); }
.decision-panel--warn { border-left-color: var(--color-warning); }

.banner {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-4);
}
.banner-main {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-start;
}
.banner-icon { font-size: 24px; margin-top: 2px; }
.decision-panel--ok .banner-icon { color: var(--color-success); }
.decision-panel--info .banner-icon { color: var(--color-primary); }
.decision-panel--warn .banner-icon { color: var(--color-warning); }

.banner-text {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.banner-summary {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--fs-body);
  line-height: 1.5;
}

.issues {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.issue {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: var(--sp-2);
  align-items: center;
  padding: var(--sp-1) 0;
}
.issue-msg { font-size: var(--fs-body); color: var(--color-text-primary); }
.issue-code { color: var(--color-text-tertiary); font-size: 11px; }
.issue--high .material-symbols-outlined { color: var(--color-danger); }
.issue--medium .material-symbols-outlined { color: var(--color-warning); }
.issue--low .material-symbols-outlined { color: var(--color-text-tertiary); }

.empty {
  padding: var(--sp-3) 0;
}
</style>
