<script setup>
import { ref, onMounted } from 'vue'
import { usePartyReviewQueue } from '../composables/usePartyReviewQueue.js'

// CODE_REVIEW §6.2 — the mock "Companies" tab is gone; watched parties
// (GET /api/parties/watchlist, written from the party detail pages) are the
// page's primary content, alongside the dedup review queue.
const activeTab = ref('parties')

const watchedParties = ref([])
const watchedLoading = ref(false)
const watchedError = ref(null)

async function loadWatched() {
  watchedLoading.value = true
  watchedError.value = null
  try {
    const res = await fetch('/api/parties/watchlist')
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      watchedError.value = body?.error || `Request failed: ${res.status}`
      return
    }
    watchedParties.value = body.items || []
  } catch (err) {
    watchedError.value = err.message
  } finally {
    watchedLoading.value = false
  }
}

function fmtDate(d) {
  if (!d) return '—'
  try {
    return new Date(d).toISOString().slice(0, 10)
  } catch {
    return String(d)
  }
}

// Phase 4 — Party Review Queue tab. Lists open party_review_queue items
// with merge / reject actions. Reviewer decisions feed the party master
// via the merge service.
const reviewQueue = usePartyReviewQueue()

// Per-row inline dialogs (kept simple — one open row at a time).
const openAction = ref({ itemId: null, mode: null, reason: '' })

function openMerge(itemId) {
  openAction.value = { itemId, mode: 'merge', reason: '' }
}
function openReject(itemId) {
  openAction.value = { itemId, mode: 'reject', reason: '' }
}
function closeAction() {
  openAction.value = { itemId: null, mode: null, reason: '' }
}

async function submitAction(item) {
  const a = openAction.value
  if (!a.itemId || a.itemId !== item.id || !a.mode) return
  try {
    await reviewQueue.resolveItem(item.id, {
      action: a.mode,
      reason: a.reason || undefined,
    })
    closeAction()
  } catch {
    // error surfaced via reviewQueue.error
  }
}

onMounted(() => {
  loadWatched()
  reviewQueue.load()
})
</script>

<template>
  <div class="watchlist">
    <header class="page-head">
      <div>
        <h1 class="t-headline">Watchlist</h1>
        <p class="t-meta page-sub">
          Parties flagged for monitoring across dossiers, and parties pending dedup review.
        </p>
      </div>
    </header>

    <nav class="tabs">
      <button
        :class="['tab', { 'tab--active': activeTab === 'parties' }]"
        @click="activeTab = 'parties'"
      >
        Watched parties
        <span v-if="watchedParties.length" class="tab-count tab-count--neutral">
          {{ watchedParties.length }}
        </span>
      </button>
      <button
        :class="['tab', { 'tab--active': activeTab === 'review' }]"
        @click="activeTab = 'review'; reviewQueue.load()"
      >
        Party review queue
        <span v-if="reviewQueue.items.value.length" class="tab-count">
          {{ reviewQueue.items.value.length }}
        </span>
      </button>
    </nav>

    <!-- Watched parties (real data) -->
    <template v-if="activeTab === 'parties'">
      <section class="review-sheet">
        <div v-if="watchedLoading && !watchedParties.length" class="empty">
          <span class="t-meta">Loading watched parties…</span>
        </div>
        <div v-else-if="watchedError" class="empty">
          <span class="t-title">Failed to load</span>
          <span class="t-meta">{{ watchedError }}</span>
        </div>
        <div v-else-if="!watchedParties.length" class="empty">
          <span class="material-symbols-outlined empty-icon">visibility_off</span>
          <span class="t-title">No watched parties</span>
          <span class="t-meta">Flag a party from its detail page to track it here.</span>
        </div>
        <table v-else class="watched-table">
          <thead>
            <tr>
              <th>Party</th>
              <th>Type</th>
              <th class="num">Dossiers</th>
              <th>Reason</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in watchedParties" :key="w.watchlist_id">
              <td>
                <RouterLink :to="`/party/${w.party_id}`" class="review-name">
                  {{ w.full_name }}
                </RouterLink>
              </td>
              <td class="t-dim">{{ w.party_type === 'organisation' ? 'Organisation' : 'Individual' }}</td>
              <td class="num">{{ w.linked_dossier_count ?? 0 }}</td>
              <td>{{ w.reason || '—' }}</td>
              <td class="t-mono t-dim">{{ fmtDate(w.added_at) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <!-- Phase 4 — Party Review Queue -->
    <template v-if="activeTab === 'review'">
      <section class="review-sheet">
        <div v-if="reviewQueue.loading.value" class="empty">
          <span class="t-meta">Loading review queue…</span>
        </div>
        <div v-else-if="reviewQueue.error.value" class="empty">
          <span class="t-title">Failed to load</span>
          <span class="t-meta">{{ reviewQueue.error.value }}</span>
        </div>
        <div v-else-if="!reviewQueue.items.value.length" class="empty">
          <span class="material-symbols-outlined empty-icon">check_circle</span>
          <span class="t-title">No open review items</span>
          <span class="t-meta">The resolver hasn't surfaced any pending dedup decisions.</span>
        </div>
        <ul v-else class="review-rows">
          <li v-for="item in reviewQueue.items.value" :key="item.id" class="review-row">
            <div class="review-row-main">
              <div class="review-side">
                <span class="t-label">New (this run)</span>
                <RouterLink :to="`/party/${item.party_id}`" class="review-name">
                  {{ item.new_party_name }}
                </RouterLink>
                <span class="t-meta">{{ item.new_party_type }}</span>
              </div>
              <span class="review-vs">vs</span>
              <div class="review-side">
                <span class="t-label">Existing (candidate)</span>
                <RouterLink :to="`/party/${item.candidate_party_id}`" class="review-name">
                  {{ item.candidate_party_name }}
                </RouterLink>
                <span class="t-meta">{{ item.candidate_party_type }}</span>
              </div>
            </div>

            <div class="review-row-meta">
              <span :class="['confidence', `confidence--${item.confidence}`]">
                {{ item.confidence }}
              </span>
              <span class="t-mono">score {{ Number(item.score).toFixed(3) }}</span>
              <span class="t-meta">via {{ item.matched_via }}</span>
            </div>

            <div class="review-row-actions" v-if="openAction.itemId !== item.id">
              <button
                class="btn btn--ghost"
                @click="openReject(item.id)"
                :disabled="reviewQueue.submitting.value"
              >Reject</button>
              <button
                class="btn btn--primary"
                @click="openMerge(item.id)"
                :disabled="reviewQueue.submitting.value"
              >Merge</button>
            </div>

            <div v-if="openAction.itemId === item.id" class="review-row-form">
              <p class="t-meta" v-if="openAction.mode === 'merge'">
                Soft-merge the NEW party into the existing candidate. The new
                party row is kept (historical references still resolve) and
                its links + overrides move to the candidate.
              </p>
              <p class="t-meta" v-else>
                Mark the candidate match as wrong — the new party stays
                independent. Reason is optional but helps future audits.
              </p>
              <label class="form-row">
                <span class="t-label">Reason (optional)</span>
                <input
                  v-model="openAction.reason"
                  type="text"
                  maxlength="500"
                  :placeholder="openAction.mode === 'merge'
                    ? 'e.g. same person, alternate spelling confirmed'
                    : 'e.g. different person — DOB mismatch'"
                />
              </label>
              <div class="form-actions">
                <button class="btn btn--ghost" @click="closeAction">Cancel</button>
                <button
                  class="btn btn--primary"
                  @click="submitAction(item)"
                  :disabled="reviewQueue.submitting.value"
                >
                  {{ reviewQueue.submitting.value ? 'Submitting…' : `Confirm ${openAction.mode}` }}
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.watchlist {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--sp-4);
}
.page-head h1 { margin: 0; }
.page-sub { margin: var(--sp-1) 0 0; }

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

/* Phase 4 — tabs strip + review queue rows. */
.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--color-border);
}
.tab {
  background: none;
  border: 0;
  padding: var(--sp-3) var(--sp-4);
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: var(--fs-body);
  font-weight: 500;
  border-bottom: 2px solid transparent;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}
.tab--active {
  color: var(--color-text-primary);
  border-bottom-color: var(--color-primary);
}
.tab-count {
  padding: 1px 8px;
  font-size: 11px;
  background: var(--color-danger, #dc2626);
  color: white;
  border-radius: 999px;
}
.tab-count--neutral {
  background: var(--color-surface-sunken, #eee);
  color: var(--color-text-secondary, #555);
}

.watched-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-body);
}
.watched-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  padding: var(--sp-3) var(--sp-6);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-page);
}
.watched-table td {
  padding: var(--sp-3) var(--sp-6);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-primary);
}
.watched-table tr:last-child td { border-bottom: 0; }
.watched-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}
.t-dim { color: var(--color-text-tertiary); }
.t-mono { font-family: var(--font-mono); font-size: var(--fs-mono); }

.review-sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.review-rows { list-style: none; margin: 0; padding: 0; }
.review-row {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4) var(--sp-6);
  border-bottom: 1px solid var(--color-border);
}
.review-row:last-child { border-bottom: 0; }
.review-row-main {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex-wrap: wrap;
}
.review-side {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 200px;
}
.review-name {
  font-weight: 500;
  color: var(--color-text-primary);
  text-decoration: none;
}
.review-name:hover { text-decoration: underline; }
.review-vs {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
  font-weight: 600;
}
.review-row-meta {
  display: flex;
  gap: var(--sp-3);
  align-items: center;
}
.confidence {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}
.confidence--EXACT { background: #dcfce7; color: #166534; }
.confidence--HIGH { background: #fef3c7; color: #92400e; }
.confidence--REVIEW { background: #fee2e2; color: #991b1b; }
.review-row-actions {
  display: flex;
  gap: var(--sp-2);
}
.review-row-form {
  padding: var(--sp-3);
  background: var(--color-surface-2, #fafafa);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-row input {
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font: inherit;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
</style>
