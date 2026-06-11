<script setup>
// QA recommendation narrative — LLM-generated, paragraph count scales with risk
// tier (Low=2 / Medium=4 / High=6). Surfaces on the dossier QA panel, the
// frozen run detail page, and inside each decision dialog.
//
// Text-only rendering (no HTML / no markdown parsing) — the prompt produces
// paragraphs joined by '\n\n'; we split and emit each as a <p>.

import { computed } from 'vue'

const props = defineProps({
  narrative: { type: Object, default: null },
  compact: { type: Boolean, default: false },
})

const TIER_KEY = computed(() => {
  const t = props.narrative?.tier
  return t ? String(t).toLowerCase() : null
})

const paragraphs = computed(() => {
  const text = props.narrative?.text
  if (!text || typeof text !== 'string') return []
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
})

const generatedAt = computed(() => {
  const ts = props.narrative?.generatedAt
  if (!ts) return null
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
})
</script>

<template>
  <section :class="['qa-narrative', { 'qa-narrative--compact': compact }]" v-if="narrative">
    <header class="qa-narrative-head">
      <div class="qa-narrative-head-left">
        <span :class="['qa-narrative-tier', `qa-narrative-tier--${TIER_KEY}`]">
          {{ narrative.tier }} risk
        </span>
        <span class="t-meta">
          {{ narrative.paragraphCount }}-paragraph recommendation
        </span>
      </div>
      <span v-if="generatedAt" class="t-meta">Generated {{ generatedAt }}</span>
    </header>

    <div class="qa-narrative-body">
      <p v-for="(p, idx) in paragraphs" :key="idx" class="qa-narrative-p">{{ p }}</p>
    </div>

    <footer v-if="narrative.model && !compact" class="qa-narrative-foot t-meta">
      Model: <span class="t-mono">{{ narrative.model }}</span>
    </footer>
  </section>

  <div v-else class="qa-narrative-empty t-meta">
    Narrative not yet generated for this run.
  </div>
</template>

<style scoped>
.qa-narrative {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.qa-narrative--compact {
  gap: var(--sp-2);
}

.qa-narrative-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.qa-narrative-head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.qa-narrative-tier {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-pill);
  font-size: var(--fs-meta);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.qa-narrative-tier--low {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.qa-narrative-tier--medium {
  background: var(--color-warning-soft, #fbf1e1);
  color: var(--color-warning, #b45309);
}
.qa-narrative-tier--high {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.qa-narrative-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.qa-narrative--compact .qa-narrative-body {
  gap: var(--sp-2);
}
.qa-narrative-p {
  margin: 0;
  line-height: 1.6;
  color: var(--color-text-primary);
  font-size: var(--fs-body);
  white-space: pre-wrap;
}

.qa-narrative-foot {
  padding-top: var(--sp-2);
  border-top: 1px solid var(--color-border);
}

.qa-narrative-empty {
  padding: var(--sp-3) 0;
  color: var(--color-text-tertiary);
}
</style>
