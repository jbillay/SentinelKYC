<script setup>
// Party directory — the top-level entry point into the party master.
// Search by name, filter to parties pending dedup review, paginate, and
// click through to a party detail page. The global party search in the top
// bar deep-links here via /parties?q=<term>.

import { computed, ref, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useParties } from '../composables/useParties.js'

const route = useRoute()
const router = useRouter()
const { parties, loading, error, load } = useParties()

const PAGE_SIZE = 50
const q = ref(typeof route.query.q === 'string' ? route.query.q : '')
const needsReviewOnly = ref(false)
const offset = ref(0)

let debounceTimer = null

function reload() {
  load({
    q: q.value.trim() || undefined,
    needsReview: needsReviewOnly.value ? true : undefined,
    limit: PAGE_SIZE,
    offset: offset.value,
  })
}

// Keep the URL's ?q= in sync so the view is shareable / back-button friendly.
function syncQueryParam() {
  const next = q.value.trim()
  const current = typeof route.query.q === 'string' ? route.query.q : ''
  if (next !== current) {
    router.replace({ query: next ? { q: next } : {} })
  }
}

watch(q, () => {
  offset.value = 0
  syncQueryParam()
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(reload, 250)
})

watch(needsReviewOnly, () => {
  offset.value = 0
  reload()
})

// React to external query changes (e.g. the top-bar search navigates here
// while this page is already mounted).
watch(
  () => route.query.q,
  (v) => {
    const incoming = typeof v === 'string' ? v : ''
    if (incoming !== q.value) q.value = incoming
  }
)

const canPrev = computed(() => offset.value > 0)
const canNext = computed(() => parties.value.length === PAGE_SIZE)

function prevPage() {
  if (!canPrev.value) return
  offset.value = Math.max(0, offset.value - PAGE_SIZE)
  reload()
}
function nextPage() {
  if (!canNext.value) return
  offset.value += PAGE_SIZE
  reload()
}

function fmtType(t) {
  if (t === 'organisation') return 'Organisation'
  if (t === 'individual') return 'Individual'
  return t || '—'
}

onMounted(reload)
</script>

<template>
  <div class="parties-page">
    <header class="page-head">
      <div>
        <h1 class="t-headline">Parties</h1>
        <p class="t-meta page-sub">
          The party master — every officer, PSC, and shareholder resolved across
          all dossiers. Click a party to see its full cross-dossier footprint.
        </p>
      </div>
    </header>

    <div class="toolbar">
      <div class="search">
        <span class="material-symbols-outlined search-icon">search</span>
        <input
          v-model="q"
          type="search"
          placeholder="Search parties by name…"
          aria-label="Search parties by name"
        />
      </div>
      <label class="filter-toggle">
        <input v-model="needsReviewOnly" type="checkbox" />
        Needs review only
      </label>
    </div>

    <div v-if="error" class="banner banner--error" role="alert">
      Failed to load parties — {{ error }}
    </div>

    <section class="rows-sheet">
      <div v-if="loading && !parties.length" class="empty">
        <span class="t-meta">Loading parties…</span>
      </div>
      <div v-else-if="!parties.length" class="empty">
        <span class="material-symbols-outlined empty-icon">group_off</span>
        <span class="t-title">No parties found</span>
        <span class="t-meta">
          {{ q ? 'Try a different search term.' : 'Run a dossier to populate the party master.' }}
        </span>
      </div>
      <table v-else class="parties-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th class="num">Dossiers</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in parties" :key="p.id" class="party-row">
            <td class="td-name">
              <RouterLink :to="`/party/${p.id}`" class="name-link">
                {{ p.full_name }}
              </RouterLink>
            </td>
            <td class="td-muted">{{ fmtType(p.party_type) }}</td>
            <td class="num">{{ p.linked_dossier_count ?? 0 }}</td>
            <td>
              <span v-if="p.needs_review" class="review-pill">Needs review</span>
              <span v-else class="t-dim">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="parties.length || canPrev" class="pager">
      <button type="button" class="btn btn--ghost btn--sm" :disabled="!canPrev || loading" @click="prevPage">
        <span class="material-symbols-outlined icon-sm">chevron_left</span>
        Previous
      </button>
      <span class="pager-info t-meta">
        Showing {{ offset + 1 }}–{{ offset + parties.length }}
      </span>
      <button type="button" class="btn btn--ghost btn--sm" :disabled="!canNext || loading" @click="nextPage">
        Next
        <span class="material-symbols-outlined icon-sm">chevron_right</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.parties-page {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.page-head h1 { margin: 0; }
.page-sub { margin: var(--sp-1) 0 0; max-width: 70ch; }

.toolbar {
  display: flex;
  gap: var(--sp-4);
  align-items: center;
  flex-wrap: wrap;
}
.search {
  position: relative;
  flex: 1 1 320px;
  max-width: 480px;
}
.search-icon {
  position: absolute;
  left: var(--sp-3);
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-text-tertiary);
  font-size: 20px;
  pointer-events: none;
}
.search input {
  width: 100%;
  font: inherit;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-2) var(--sp-3) var(--sp-2) calc(var(--sp-6) + var(--sp-3));
  height: 40px;
}
.search input:focus {
  outline: 0;
  border-color: var(--color-primary);
}
.filter-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  cursor: pointer;
}

.banner {
  border-radius: var(--radius-md);
  padding: var(--sp-3) var(--sp-4);
}
.banner--error {
  border-left: 4px solid var(--color-danger);
  background: var(--color-danger-soft);
}

.rows-sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.parties-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-body);
}
.parties-table thead { background: var(--color-page); }
.parties-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--color-border);
}
.parties-table td {
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-primary);
}
.party-row:last-child td { border-bottom: 0; }
.party-row:hover { background: var(--color-page); }
.parties-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}
.name-link {
  font-weight: 500;
  color: var(--color-primary);
  text-decoration: none;
}
.name-link:hover { text-decoration: underline; }
.td-muted { color: var(--color-text-tertiary); }
.t-dim { color: var(--color-text-tertiary); }
.review-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: #fee2e2;
  color: #991b1b;
}

.empty {
  padding: var(--sp-12) var(--sp-6);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
}
.empty-icon {
  font-size: 36px;
  color: var(--color-text-tertiary);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
}
.pager-info { min-width: 140px; text-align: center; }
.btn--sm {
  height: 32px;
  padding: 0 var(--sp-3);
  font-size: var(--fs-meta);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}
.btn[disabled] { opacity: 0.5; cursor: not-allowed; }
</style>
