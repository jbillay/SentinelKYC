<script setup>
import { computed, toRef } from 'vue'
import { useRoute } from 'vue-router'
import { useDossier } from '../composables/useDossier.js'
import ShareholderGraph from '../components/ShareholderGraph.vue'

const route = useRoute()
const companyNumber = toRef(() => route.params.companyNumber)
const hasCompany = computed(() => !!companyNumber.value)

const { dossier, loading, error } = hasCompany.value
  ? useDossier(companyNumber)
  : { dossier: { value: null }, loading: { value: false }, error: { value: null } }

const latestRun = computed(() => dossier.value?.runs?.[0] || null)
// Stable empty fallback so the prop identity doesn't change every render —
// otherwise ShareholderGraph's `watch(() => props.graph)` re-fires and tears
// down + rebuilds Cytoscape on every parent tick. See CODE_REVIEW §4.4.
const EMPTY_GRAPH = Object.freeze({ nodes: [], edges: [] })
const graph = computed(() => latestRun.value?.finalShareholderGraph || EMPTY_GRAPH)
const subjectName = computed(
  () => dossier.value?.companyName || dossier.value?.companyNumber || ''
)
</script>

<template>
  <div class="graph-page">
    <header class="page-head">
      <div>
        <RouterLink
          v-if="hasCompany"
          :to="{ name: 'dossier', params: { companyNumber } }"
          class="back-link"
        >
          <span class="material-symbols-outlined icon-sm">arrow_back</span>
          Back to dossier
        </RouterLink>
        <RouterLink v-else :to="{ name: 'dossiers' }" class="back-link">
          <span class="material-symbols-outlined icon-sm">arrow_back</span>
          Back to dossiers
        </RouterLink>
        <h1 class="t-headline page-title">Entity graph</h1>
        <div v-if="subjectName" class="page-meta">
          <span>{{ subjectName }}</span>
          <span v-if="dossier?.companyNumber" class="t-mono">
            · #{{ dossier.companyNumber }}
          </span>
        </div>
      </div>
    </header>

    <section v-if="!hasCompany" class="empty-sheet">
      <span class="material-symbols-outlined empty-icon">share</span>
      <h2 class="t-title">Open from a dossier</h2>
      <p class="empty-msg">The entity graph is rendered per dossier. Select a dossier to view its graph.</p>
      <RouterLink :to="{ name: 'dossiers' }" class="btn btn--primary">Browse dossiers</RouterLink>
    </section>

    <section v-else-if="loading" class="empty-sheet">
      <p class="t-meta">Loading dossier…</p>
    </section>

    <section v-else-if="error === 'not_found'" class="empty-sheet">
      <span class="material-symbols-outlined empty-icon">search_off</span>
      <h2 class="t-title">Dossier not found</h2>
      <p class="empty-msg">No dossier exists for this company number yet.</p>
    </section>

    <section v-else class="graph-sheet">
      <ShareholderGraph :graph="graph" />
    </section>
  </div>
</template>

<style scoped>
.graph-page {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.page-head h1 {
  margin: 0;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--color-text-secondary);
  text-decoration: none;
  margin-bottom: var(--sp-2);
}
.back-link:hover { color: var(--color-primary); }
.page-meta {
  margin-top: var(--sp-2);
  display: flex;
  gap: var(--sp-1);
  align-items: baseline;
  color: var(--color-text-tertiary);
  font-size: var(--fs-meta);
}

.graph-sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-6);
}

.empty-sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-16) var(--sp-8);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--sp-3);
}
.empty-icon {
  font-size: 48px;
  color: var(--color-text-tertiary);
}
.empty-msg {
  color: var(--color-text-secondary);
}
</style>
