<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAgentStore } from '../stores/agent.js'
import { useDossiers } from '../composables/useDossiers.js'
import SearchForm from '../components/SearchForm.vue'

const router = useRouter()
const agent = useAgentStore()

// Live recent dossiers — previously MOCK_DOSSIERS with `GB-` prefixes that
// the "Rerun" handler stripped before calling /api/run. That happened to
// not 404 because the underlying CH numbers were real, but it was a real
// run against a mock-labelled subject. Now sourced from the actual
// /api/dossiers list. See CODE_REVIEW §4.5.
const { dossiers } = useDossiers()
const recentSamples = computed(() => dossiers.value.slice(0, 3))

async function onSubmit(input) {
  const threadId = await agent.startRun(input)
  router.push({ name: 'run', params: { threadId } })
}

async function rerun(sample) {
  const threadId = await agent.startRun({ companyNumber: sample.companyNumber })
  router.push({ name: 'run', params: { threadId } })
}
</script>

<template>
  <div class="search-page">
    <header class="page-head">
      <div>
        <h1 class="t-headline">New search</h1>
        <p class="t-meta page-sub">
          Identify a UK company. The agent will search Companies House, confirm the entity, fetch
          recent filings, and compile a structured KYC dossier.
        </p>
      </div>
    </header>

    <div class="layout">
      <section class="sheet primary-sheet">
        <div class="step-header">
          <span class="step-num">01</span>
          <div>
            <h2 class="t-title">Identify the subject company</h2>
            <p class="t-meta">Name is required. Postcode and incorporation year sharpen the match.</p>
          </div>
        </div>
        <SearchForm @submit="onSubmit" />
      </section>

      <aside class="recent">
        <div class="recent-head">
          <span class="t-label">Recent searches</span>
        </div>
        <ul v-if="recentSamples.length" class="recent-list">
          <li v-for="r in recentSamples" :key="r.id">
            <button type="button" class="recent-item" @click="rerun(r)">
              <div class="recent-name">{{ r.companyName || r.companyNumber }}</div>
              <div class="recent-num t-mono">{{ r.companyNumber }}</div>
              <span class="recent-link">Rerun →</span>
            </button>
          </li>
        </ul>
        <p v-else class="t-meta recent-empty">No prior searches yet.</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.search-page {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.page-head {
  max-width: 720px;
}
.page-head h1 {
  margin: 0;
}
.page-sub {
  margin: var(--sp-2) 0 0;
  max-width: 56ch;
  line-height: 1.6;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: var(--sp-6);
  align-items: flex-start;
}
@media (max-width: 980px) {
  .layout { grid-template-columns: 1fr; }
}

.sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-8);
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.primary-sheet {
  box-shadow: var(--shadow-sheet);
}

.step-header {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
}
.step-header h2 {
  margin: 0;
}
.step-header p {
  margin: var(--sp-1) 0 0;
}

.recent {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.recent-head {
  padding: var(--sp-1) var(--sp-2);
}
.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.recent-item {
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  padding: var(--sp-3);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: background-color var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease);
}
.recent-item:hover {
  background: var(--color-page);
  border-color: var(--color-border);
}
.recent-name {
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-primary);
}
.recent-num {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
}
.recent-link {
  margin-top: var(--sp-1);
  font-size: 11px;
  color: var(--color-primary);
  font-weight: 500;
}
.recent-empty {
  padding: var(--sp-2) var(--sp-3);
}
</style>
