<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  // ScreeningHit row joined with its evaluation:
  //   { id, listSource, listEntryId, matchScore, matchedFields, rawEntry, evaluation, effective }
  hit: { type: Object, required: true },
  // Disable override controls (RunDetailPage shows frozen runs).
  readonly: { type: Boolean, default: false },
})

const emit = defineEmits(['override'])

const LIST_LABEL = {
  ofac_sdn: 'OFAC SDN',
  uk_hmt: 'UK HMT',
  adverse_media: 'Adverse media',
}

const isAdverseMedia = computed(() => props.hit.listSource === 'adverse_media')

const evaluation = computed(() => props.hit.evaluation || null)
const effective = computed(() => props.hit.effective || 'unevaluated')
const hasOverride = computed(() => !!evaluation.value?.humanOverride)

function decisionTone(d) {
  if (d === 'confirmed') return 'danger'
  if (d === 'needs_review') return 'warn'
  if (d === 'dismissed') return 'muted'
  return 'primary'
}

function decisionLabel(d) {
  if (!d || d === 'unevaluated') return 'Unevaluated'
  if (d === 'needs_review') return 'Needs review'
  return d.charAt(0).toUpperCase() + d.slice(1)
}

const reasoningCollapsed = ref(true)
const longReasoning = computed(() => (evaluation.value?.llmReasoning || '').length > 220)

const showReasonModal = ref(false)
const pendingDecision = ref(null)
const reasonInput = ref('')

function openOverrideModal(decision) {
  if (props.readonly) return
  pendingDecision.value = decision
  reasonInput.value = evaluation.value?.overrideReason || ''
  showReasonModal.value = true
}

function confirmOverride() {
  emit('override', { hitId: props.hit.id, decision: pendingDecision.value, reason: reasonInput.value || null })
  showReasonModal.value = false
  pendingDecision.value = null
  reasonInput.value = ''
}

function clearOverride() {
  if (props.readonly) return
  emit('override', { hitId: props.hit.id, decision: null, reason: null })
}

const matchedFields = computed(() => {
  const m = props.hit.matchedFields
  if (!m) return []
  if (Array.isArray(m)) return m
  if (typeof m === 'object') return Object.keys(m).filter((k) => m[k])
  return []
})

const article = computed(() => {
  if (!isAdverseMedia.value) return null
  return props.hit.rawEntry || {}
})

const listEntryUrl = computed(() => {
  if (isAdverseMedia.value) return article.value?.url || null
  return null
})
</script>

<template>
  <article :class="['hit', `hit--${decisionTone(effective)}`]">
    <header class="hit-head">
      <div class="hit-head-left">
        <span class="list-label">{{ LIST_LABEL[hit.listSource] || hit.listSource }}</span>
        <span v-if="hit.matchScore != null" class="t-mono score">{{ Number(hit.matchScore).toFixed(2) }}</span>
        <span v-if="matchedFields.length" class="matched">
          <span v-for="f in matchedFields" :key="f" class="matched-chip">{{ f }}</span>
        </span>
      </div>
      <div class="hit-head-right">
        <span :class="['pill', `pill--${decisionTone(effective)}`]">{{ decisionLabel(effective) }}</span>
        <span v-if="hasOverride" class="override-badge">override</span>
      </div>
    </header>

    <div class="hit-body">
      <template v-if="isAdverseMedia">
        <h4 class="article-title">
          <a v-if="listEntryUrl" :href="listEntryUrl" target="_blank" rel="noopener noreferrer">
            {{ article?.name || article?.title || 'Untitled article' }}
          </a>
          <template v-else>{{ article?.name || article?.title || 'Untitled article' }}</template>
        </h4>
        <p v-if="article?.snippet || article?.description" class="article-snippet">
          {{ article?.snippet || article?.description }}
        </p>
        <div v-if="evaluation" class="article-meta">
          <span v-if="evaluation.category" class="meta-chip">{{ evaluation.category }}</span>
          <span v-if="evaluation.severity" :class="['meta-chip', `meta-chip--${evaluation.severity}`]">{{ evaluation.severity }}</span>
        </div>
      </template>
      <template v-else>
        <h4 class="entry-name">
          {{ hit.rawEntry?.primaryName || hit.rawEntry?.primary_name || hit.subjectName }}
        </h4>
        <div v-if="hit.rawEntry?.aliases?.length" class="aliases">
          <span class="t-label">Aliases</span>
          <span class="aliases-list">{{ hit.rawEntry.aliases.slice(0, 3).join(' · ') }}<span v-if="hit.rawEntry.aliases.length > 3"> · +{{ hit.rawEntry.aliases.length - 3 }}</span></span>
        </div>
        <div v-if="hit.rawEntry?.programs?.length" class="programs">
          <span class="t-label">Programs</span>
          <span class="programs-list">{{ hit.rawEntry.programs.slice(0, 4).join(' · ') }}</span>
        </div>
      </template>

      <div v-if="evaluation?.llmReasoning" class="reasoning">
        <span class="t-label">LLM reasoning</span>
        <p :class="['reasoning-body', { 'is-collapsed': reasoningCollapsed && longReasoning }]">{{ evaluation.llmReasoning }}</p>
        <button v-if="longReasoning" type="button" class="link-btn" @click="reasoningCollapsed = !reasoningCollapsed">
          {{ reasoningCollapsed ? 'Show more' : 'Show less' }}
        </button>
      </div>
      <div v-if="evaluation?.overrideReason && hasOverride" class="override-reason">
        <span class="t-label">Override reason</span>
        <span class="override-reason-text">{{ evaluation.overrideReason }}</span>
      </div>
    </div>

    <footer v-if="!readonly" class="hit-actions">
      <button
        type="button"
        :class="['action', { 'action--active': effective === 'confirmed' }]"
        :disabled="effective === 'confirmed'"
        @click="openOverrideModal('confirmed')"
      >
        Confirm
      </button>
      <button
        type="button"
        :class="['action', { 'action--active': effective === 'dismissed' }]"
        :disabled="effective === 'dismissed'"
        @click="openOverrideModal('dismissed')"
      >
        Dismiss
      </button>
      <button v-if="hasOverride" type="button" class="action action--ghost" @click="clearOverride">
        Clear override
      </button>
    </footer>

    <div v-if="showReasonModal" class="modal-backdrop" @click.self="showReasonModal = false">
      <div class="modal" role="dialog" aria-modal="true">
        <h3 class="modal-title">{{ pendingDecision === 'confirmed' ? 'Confirm hit' : 'Dismiss hit' }}</h3>
        <p class="modal-sub">Optional — record a reason for the audit trail.</p>
        <textarea v-model="reasonInput" class="modal-textarea" rows="3" placeholder="Reason (optional)" />
        <div class="modal-actions">
          <button type="button" class="action action--ghost" @click="showReasonModal = false">Cancel</button>
          <button type="button" class="action action--primary" @click="confirmOverride">
            {{ pendingDecision === 'confirmed' ? 'Confirm' : 'Dismiss' }}
          </button>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.hit {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.hit--danger { border-color: var(--color-danger-soft); }
.hit--warn { border-color: var(--color-warning-soft, #fef3c7); }

.hit-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  background: var(--color-page);
  border-bottom: 1px solid var(--color-border);
}
.hit-head-left { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.hit-head-right { display: flex; align-items: center; gap: var(--sp-2); flex-shrink: 0; }
.list-label { font-size: var(--fs-meta); font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.score { font-size: var(--fs-meta); color: var(--color-text-tertiary); }
.matched { display: inline-flex; gap: var(--sp-1); flex-wrap: wrap; }
.matched-chip {
  display: inline-block;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-pill);
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 11px;
}

.pill {
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--fs-meta);
  font-weight: 500;
}
.pill--danger { background: var(--color-danger-soft); color: var(--color-danger); }
.pill--warn { background: var(--color-warning-soft, #fef3c7); color: var(--color-warning, #b45309); }
.pill--muted { background: var(--color-surface-sunken); color: var(--color-text-tertiary); }
.pill--primary { background: var(--color-primary-soft); color: var(--color-primary); }
.override-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-tertiary);
  border: 1px solid var(--color-border);
  padding: 0 var(--sp-2);
  border-radius: var(--radius-pill);
}

.hit-body {
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.article-title { margin: 0; font-size: var(--fs-body); font-weight: 600; line-height: 1.3; }
.article-title a { color: var(--color-primary); text-decoration: none; }
.article-title a:hover { text-decoration: underline; }
.article-snippet { margin: 0; color: var(--color-text-secondary); line-height: 1.5; }
.article-meta { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.meta-chip {
  padding: 0 var(--sp-2);
  border-radius: var(--radius-pill);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 500;
}
.meta-chip--high { background: var(--color-danger-soft); color: var(--color-danger); }
.meta-chip--medium { background: var(--color-warning-soft, #fef3c7); color: var(--color-warning, #b45309); }
.meta-chip--low { background: var(--color-surface-sunken); color: var(--color-text-tertiary); }

.entry-name { margin: 0; font-size: var(--fs-body); font-weight: 600; }
.aliases, .programs { display: flex; flex-direction: column; gap: var(--sp-1); }
.aliases-list, .programs-list { color: var(--color-text-secondary); }

.reasoning { display: flex; flex-direction: column; gap: var(--sp-1); }
.reasoning-body { margin: 0; color: var(--color-text-secondary); line-height: 1.5; }
.reasoning-body.is-collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.override-reason { display: flex; flex-direction: column; gap: var(--sp-1); }
.override-reason-text { color: var(--color-text-secondary); font-style: italic; }

.link-btn {
  align-self: flex-start;
  background: none;
  border: 0;
  color: var(--color-primary);
  font-size: var(--fs-meta);
  cursor: pointer;
  padding: 0;
}
.link-btn:hover { text-decoration: underline; }

.hit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--color-border);
  background: var(--color-page);
}
.action {
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-size: var(--fs-meta);
  font-weight: 500;
  cursor: pointer;
}
.action:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
.action:disabled { opacity: 0.5; cursor: not-allowed; }
.action--active { background: var(--color-primary-soft); color: var(--color-primary); border-color: var(--color-primary-soft); }
.action--ghost { background: transparent; border-color: transparent; color: var(--color-text-tertiary); }
.action--primary { background: var(--color-primary); color: var(--color-text-on-primary); border-color: var(--color-primary); }

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: var(--color-surface);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  padding: var(--sp-5);
  width: min(420px, 90vw);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.modal-title { margin: 0; font-size: 18px; font-weight: 600; }
.modal-sub { margin: 0; color: var(--color-text-tertiary); font-size: var(--fs-meta); }
.modal-textarea {
  width: 100%;
  font-family: inherit;
  font-size: var(--fs-body);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  resize: vertical;
}
.modal-textarea:focus {
  outline: none;
  border-color: var(--color-primary);
}
.modal-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); }
</style>
