<script setup>
import { ref, onMounted } from 'vue'

// Loaded sanctions-list snapshots — shown inside the Screening agent's admin
// section. Matching thresholds and adverse-media knobs live in the agent's
// versioned config (AgentConfigForm); this panel is read-only source status.
const lists = ref([])
const loading = ref(false)
const error = ref(null)

const LIST_LABEL = {
  ofac_sdn: 'OFAC SDN',
  uk_hmt: 'UK HMT',
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/api/screening/lists')
    if (!res.ok) throw new Error(`lists load failed: ${res.status}`)
    lists.value = await res.json()
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

onMounted(load)

function fmtListDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleString()
}
</script>

<template>
  <section class="sheet">
    <div class="sheet-head-row">
      <div>
        <h2 class="sheet-title">Sanctions sources</h2>
        <p class="sheet-sub">
          Local snapshots refreshed via the CLI: <code class="t-mono">npm run lists:refresh</code> from
          <code class="t-mono">server/</code>.
        </p>
      </div>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">
        <span class="material-symbols-outlined icon-sm">refresh</span>
        Reload
      </button>
    </div>

    <div v-if="error" class="panel-error">{{ error }}</div>

    <ul v-if="lists.length" class="screening-sources">
      <li v-for="s in lists" :key="s.source + s.version" class="screening-source">
        <div>
          <div class="screening-source-name">{{ LIST_LABEL[s.source] || s.source }}</div>
          <div class="screening-source-meta t-mono">version {{ s.version }} · {{ s.recordCount.toLocaleString() }} records</div>
        </div>
        <div class="screening-source-when t-mono">{{ fmtListDate(s.fetchedAt) }}</div>
      </li>
    </ul>
    <p v-else-if="!loading" class="t-meta">
      No sanctions snapshots loaded yet — run <code class="t-mono">npm run lists:refresh</code> to populate.
    </p>

    <p class="t-meta">
      <strong>Adverse-media provider</strong> · GDELT 2.0 DOC API — free, no API key required. Optional
      <code class="t-mono">GDELT_DOC_ENDPOINT</code> / <code class="t-mono">GDELT_TIMESPAN</code> overrides in
      <code class="t-mono">server/.env</code>.
    </p>
  </section>
</template>

<style scoped>
.sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-8);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.sheet-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text-primary);
}
.sheet-sub {
  margin: -8px 0 var(--sp-2);
  color: var(--color-text-secondary);
  font-size: var(--fs-meta);
}
.sheet-head-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-4);
}
.panel-error {
  padding: var(--sp-3);
  background: rgba(220, 53, 69, 0.08);
  border: 1px solid rgba(220, 53, 69, 0.25);
  border-radius: var(--radius-md);
  color: var(--color-danger, #b00020);
  font-size: var(--fs-meta);
}
.screening-sources {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.screening-source {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--color-border);
}
.screening-source:last-child {
  border-bottom: 0;
}
.screening-source-name {
  font-weight: 500;
  color: var(--color-text-primary);
}
.screening-source-meta {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}
.screening-source-when {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
}
</style>
