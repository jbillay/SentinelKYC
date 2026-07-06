<script setup>
import { computed, ref } from 'vue'
import { useHealthStore } from '../../stores/health.js'

const health = useHealthStore()
const showPopover = ref(false)

const checkedLabel = computed(() => {
  if (!health.checkedAt) return '—'
  const seconds = Math.floor((Date.now() - health.checkedAt) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const m = Math.floor(seconds / 60)
  return `${m}m ago`
})

const ollamaHost = computed(() => health.tasks.find((t) => t.provider === 'ollama')?.host || null)
const ollamaDown = computed(() => health.failing.some((t) => t.provider === 'ollama'))
const nvidiaDown = computed(() => health.failing.some((t) => t.provider === 'nvidia'))

function tagLabel(t) {
  if (!t.ok) return 'down'
  if (t.missing.length) return 'missing'
  return 'ready'
}

function refresh() {
  health.check()
}
</script>

<template>
  <div class="health-wrap" @mouseenter="showPopover = true" @mouseleave="showPopover = false">
    <button type="button" :class="['pill', `pill--${health.status}`]" @click="refresh" :title="`Click to refresh · last checked ${checkedLabel}`">
      <span :class="['dot', `dot--${health.status}`]" />
      <span class="pill-label">{{ health.statusLabel }}</span>
    </button>

    <div v-if="showPopover" class="popover" role="status">
      <div class="pop-row">
        <span class="t-label">Status</span>
        <span :class="['pop-status', `pop-status--${health.status}`]">
          <span :class="['dot', `dot--${health.status}`]" />
          {{ health.statusLabel }}
        </span>
      </div>
      <div v-if="health.tasks.length" class="pop-row">
        <span class="t-label">Providers</span>
        <div class="pop-models">
          <div v-for="t in health.tasks" :key="t.task" class="pop-model">
            <div class="pop-model-main">
              <span class="pop-task">{{ t.taskLabel }}</span>
              <span class="t-mono">{{ t.providerLabel }} · {{ t.model || '—' }}</span>
            </div>
            <span :class="['model-tag', t.ok && !t.missing.length ? 'model-tag--ok' : 'model-tag--missing']">
              {{ tagLabel(t) }}
            </span>
          </div>
        </div>
      </div>
      <div v-if="ollamaHost" class="pop-row">
        <span class="t-label">Ollama host</span>
        <span class="t-mono pop-val">{{ ollamaHost }}</span>
      </div>
      <div v-if="health.lastError" class="pop-row">
        <span class="t-label">Reason</span>
        <span class="pop-error">{{ health.lastError }}</span>
      </div>
      <div class="pop-row">
        <span class="t-label">Last checked</span>
        <span class="t-meta pop-val">{{ checkedLabel }}</span>
      </div>

      <div v-if="health.status === 'down'" class="pop-hint">
        The agent will not run.
        <template v-if="ollamaDown"> Start Ollama with <code class="t-mono">ollama serve</code>.</template>
        <template v-if="nvidiaDown"> Check <code class="t-mono">NVIDIA_API_KEY</code> and <code class="t-mono">NVIDIA_OCR_ENDPOINT</code> in <code class="t-mono">server/.env</code>.</template>
        <template v-if="!ollamaDown && !nvidiaDown"> Check that the API server is running.</template>
        Click the pill to recheck.
      </div>
      <div v-else-if="health.status === 'degraded'" class="pop-hint">
        Pull missing models with <code class="t-mono">ollama pull &lt;model&gt;</code>.
      </div>
    </div>
  </div>
</template>

<style scoped>
.health-wrap {
  position: relative;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  height: 28px;
  padding: 0 var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  cursor: pointer;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--color-text-secondary);
  transition: background-color var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease);
}
.pill:hover {
  background: var(--color-page);
}
.pill--down {
  background: var(--color-danger-soft);
  border-color: rgba(165, 40, 40, 0.25);
  color: var(--color-danger);
}
.pill--degraded {
  background: var(--color-tertiary-soft);
  border-color: rgba(180, 83, 9, 0.25);
  color: var(--color-tertiary);
}
.pill--ok {
  color: var(--color-success);
  border-color: rgba(31, 111, 67, 0.18);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  flex-shrink: 0;
}
.dot--ok { background: var(--color-success); }
.dot--degraded { background: var(--color-tertiary); }
.dot--down {
  background: var(--color-danger);
  box-shadow: 0 0 0 0 rgba(165, 40, 40, 0.4);
  animation: down-pulse 1.6s ease-in-out infinite;
}
.dot--unknown {
  background: var(--color-text-tertiary);
  opacity: 0.6;
}
@keyframes down-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(165, 40, 40, 0.4); }
  50% { box-shadow: 0 0 0 5px rgba(165, 40, 40, 0); }
}

.popover {
  position: absolute;
  top: calc(100% + var(--sp-2));
  right: 0;
  width: 320px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(16, 20, 24, 0.08);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  z-index: 60;
}
.pop-row {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.pop-val {
  color: var(--color-text-primary);
  word-break: break-all;
}
.pop-status {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-weight: 500;
}
.pop-status--ok { color: var(--color-success); }
.pop-status--degraded { color: var(--color-tertiary); }
.pop-status--down { color: var(--color-danger); }

.pop-models {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.pop-model {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  background: var(--color-page);
  border-radius: var(--radius-sm);
}
.pop-model-main {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}
.pop-task {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}
.model-tag {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
}
.model-tag--ok {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.model-tag--missing {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.pop-error {
  color: var(--color-danger);
  font-family: var(--font-mono);
  font-size: 12px;
  word-break: break-word;
}

.pop-hint {
  padding-top: var(--sp-3);
  border-top: 1px solid var(--color-border);
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  line-height: 1.5;
}
.pop-hint code {
  background: var(--color-page);
  padding: 1px var(--sp-1);
  border-radius: var(--radius-sm);
  font-size: 11px;
}
</style>
