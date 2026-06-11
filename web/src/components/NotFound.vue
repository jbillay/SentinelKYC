<script setup>
import { computed } from 'vue'

const props = defineProps({
  resolution: { type: Object, default: null },
})

const variant = computed(() => {
  const status = props.resolution?.status
  if (status === 'not_found') return 'not_found'
  if (status === 'needs_more_info') return 'no_match'
  return 'no_card'
})

const heading = computed(() => {
  switch (variant.value) {
    case 'not_found':
      return "Company doesn't exist"
    case 'no_match':
      return 'No matching company'
    default:
      return 'Run finished without a KYC card'
  }
})

const body = computed(() => {
  switch (variant.value) {
    case 'not_found':
      return 'Companies House returned 404 for that company number. Double-check the number and try again.'
    case 'no_match':
      return 'Companies House returned no candidates for that search. Try refining the name, adding a postcode, or providing the company number directly.'
    default:
      return 'The pipeline completed but no card was produced. Check the trace above for details.'
  }
})
</script>

<template>
  <div :class="['notfound', `notfound--${variant}`]" role="status">
    <div class="badge" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="14" height="14">
        <path
          d="M8 3v6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
        <circle cx="8" cy="12" r="0.9" fill="currentColor" />
      </svg>
    </div>
    <div class="content">
      <h3 class="t-title">{{ heading }}</h3>
      <p class="body">{{ body }}</p>
      <p v-if="resolution?.reason" class="detail">
        <span class="t-label">Detail</span>
        <code class="t-mono">{{ resolution.reason }}</code>
      </p>
      <p class="hint">Edit the search above and click <strong>Run</strong> to try again.</p>
    </div>
  </div>
</template>

<style scoped>
.notfound {
  display: grid;
  grid-template-columns: 32px 1fr;
  gap: var(--sp-4);
  align-items: flex-start;
  padding: var(--sp-4) var(--sp-6) var(--sp-4) var(--sp-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  border-left: 4px solid var(--color-text-tertiary);
  background: var(--color-page);
}
.notfound--not_found {
  border-left-color: var(--color-danger);
  background: var(--color-danger-soft);
}
.notfound--no_match {
  border-left-color: var(--color-tertiary);
  background: var(--color-tertiary-soft);
}
.notfound--no_card {
  border-left-color: var(--color-text-secondary);
  background: var(--color-page);
}

.badge {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--color-surface);
  border: 1px solid currentColor;
  flex-shrink: 0;
  margin-top: 2px;
}
.notfound--not_found .badge {
  color: var(--color-danger);
}
.notfound--no_match .badge {
  color: var(--color-tertiary);
}
.notfound--no_card .badge {
  color: var(--color-text-secondary);
}

.content {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}
.content h3 {
  margin: 0;
  color: var(--color-text-primary);
}
.body {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.detail {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.detail code {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text-primary);
  word-break: break-word;
}

.hint {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
}
.hint strong {
  color: var(--color-text-secondary);
  font-weight: 600;
}
</style>
