<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useParty } from '../composables/useParty.js'
import PartyGraph from '../components/PartyGraph.vue'
import PartyIdentityCard from '../components/PartyIdentityCard.vue'

const route = useRoute()
const router = useRouter()
const partyId = computed(() => route.params.partyId)

const {
  party,
  links,
  reviewItems,
  riskSummary,
  isWatched,
  loading,
  error,
  actionState,
  screening,
  screeningLoading,
  screeningError,
  load,
  mergeFrom,
  loadScreening,
  setOverride,
  setWatched,
} = useParty(partyId.value)

// Active tab — Linked dossiers / Screening / Network / Review candidates / Audit.
const activeTab = ref('links')

// Phase 5 — cross-dossier graph state. Lazy-loaded the first time the
// user selects the Network tab; re-loaded on partyId change.
const networkGraph = ref(null)
const networkLoading = ref(false)
const networkError = ref(null)
const networkDepth = ref(2)
const networkLimit = ref(50)

async function loadNetwork() {
  if (!partyId.value) return
  networkLoading.value = true
  networkError.value = null
  try {
    const url = `/api/parties/${encodeURIComponent(partyId.value)}/graph?depth=${networkDepth.value}&limit=${networkLimit.value}`
    const res = await fetch(url)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      networkError.value = body?.message || body?.error || `Request failed: ${res.status}`
      networkGraph.value = null
      return
    }
    networkGraph.value = body
  } catch (err) {
    networkError.value = err.message
    networkGraph.value = null
  } finally {
    networkLoading.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab === 'network' && !networkGraph.value && !networkLoading.value) {
    loadNetwork()
  }
  if (tab === 'screening' && !screening.value && !screeningLoading.value) {
    loadScreening()
  }
})

// ── Watchlist ──────────────────────────────────────────────────────────
const watchDialog = ref({ open: false, reason: '' })
function openWatchDialog() {
  watchDialog.value = { open: true, reason: '' }
}
async function confirmWatch() {
  try {
    await setWatched(true, { reason: watchDialog.value.reason.trim() || undefined })
    watchDialog.value.open = false
  } catch {
    // actionState.error surfaced in the dialog
  }
}
async function removeWatch() {
  try {
    await setWatched(false)
  } catch {
    // actionState.error surfaced
  }
}

// ── Screening overrides ──────────────────────────────────────────────────
// Sanctions overrides key on (party, list, list_entry_id); adverse-media
// overrides key on (party, 'adverse_media', evidence_url) — so an adverse
// hit can only be overridden when we have its article URL.
function canOverride(hit) {
  if (hit.isSanctions) return true
  return !!hit.evidenceUrl
}

async function onOverride(hit, decision) {
  try {
    await setOverride({
      listSource: hit.listSource,
      listEntryId: hit.listEntryId,
      evidenceUrl: hit.evidenceUrl,
      decision,
      reason: decision ? 'Set from party page' : undefined,
    })
    await loadScreening()
  } catch {
    // actionState.error surfaced
  }
}

function decisionClass(d) {
  if (d === 'confirmed') return 'decision--confirmed'
  if (d === 'needs_review') return 'decision--review'
  if (d === 'dismissed') return 'decision--dismissed'
  return 'decision--none'
}
function decisionLabel(d) {
  if (d === 'confirmed') return 'Confirmed'
  if (d === 'needs_review') return 'Needs review'
  if (d === 'dismissed') return 'Dismissed'
  return d || 'Unevaluated'
}
function listLabel(s) {
  if (s === 'ofac_sdn') return 'OFAC SDN'
  if (s === 'uk_hmt') return 'UK HMT'
  if (s === 'adverse_media') return 'Adverse media'
  return s
}

// Cross-dossier risk helpers for the linked-dossiers table + summary chip.
function tierClass(t) {
  return t ? `tier--${String(t).toLowerCase()}` : 'tier--none'
}
function caseStatusLabel(s) {
  return s ? s.replace(/_/g, ' ') : '—'
}

// Reload network when depth/limit change (only if the tab is open).
watch([networkDepth, networkLimit], () => {
  if (activeTab.value === 'network') loadNetwork()
})

// Merge dialog state (used when the user clicks "Merge into this party"
// from one of the open review items).
const mergeDialog = ref({ open: false, loserId: null, loserName: '', reason: '' })

function openMergeDialog(item) {
  // The candidate is the existing party (winner); item.party_id is the new
  // party (loser). Since we're viewing the WINNER's detail page, "merge
  // into this party" means item.party_id → this party.
  const loserId = item.party_id === party.value?.id ? item.candidate_party_id : item.party_id
  mergeDialog.value = {
    open: true,
    loserId,
    loserName: loserId === item.party_id ? item.new_party_name || 'New party' : item.candidate_party_name || 'Candidate',
    reason: '',
  }
}

async function confirmMerge() {
  try {
    await mergeFrom(mergeDialog.value.loserId, { reason: mergeDialog.value.reason || undefined })
    mergeDialog.value.open = false
  } catch {
    // error surfaced via actionState.value.error
  }
}

const linksByRole = computed(() => {
  const buckets = { officer: [], psc: [], shareholder: [] }
  for (const l of links.value) {
    if (!buckets[l.role]) buckets[l.role] = []
    buckets[l.role].push(l)
  }
  return buckets
})

const totalDossiers = computed(() => {
  const set = new Set(links.value.map((l) => l.dossierId))
  return set.size
})

function fmtDate(d) {
  if (!d) return '—'
  try {
    return new Date(d).toISOString().slice(0, 10)
  } catch {
    return String(d)
  }
}

function fmtStatus(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''
}

function goDossier(cn) {
  router.push({ name: 'dossier', params: { companyNumber: cn } })
}

onMounted(() => {
  load()
})
</script>

<template>
  <article class="party-detail">
    <div v-if="!party && loading" class="party-loading">Loading…</div>

    <PartyIdentityCard v-else-if="party" :party="party">
      <template #aside>
        <div class="party-actions">
          <div class="party-stats">
            <div class="stat">
              <span class="stat-num">{{ links.length }}</span>
              <span class="stat-label">role link{{ links.length === 1 ? '' : 's' }}</span>
            </div>
            <div class="stat">
              <span class="stat-num">{{ totalDossiers }}</span>
              <span class="stat-label">dossier{{ totalDossiers === 1 ? '' : 's' }}</span>
            </div>
            <div v-if="reviewItems.length" class="stat stat-warn">
              <span class="stat-num">{{ reviewItems.length }}</span>
              <span class="stat-label">review item{{ reviewItems.length === 1 ? '' : 's' }}</span>
            </div>
          </div>
          <button
            v-if="isWatched"
            type="button"
            class="watch-btn watch-btn--on"
            :disabled="actionState.submitting"
            @click="removeWatch"
            title="Remove from watchlist"
          >
            <span class="material-symbols-outlined icon-sm">visibility</span>
            On watchlist
          </button>
          <button
            v-else
            type="button"
            class="watch-btn"
            :disabled="actionState.submitting"
            @click="openWatchDialog"
            title="Add this party to the watchlist"
          >
            <span class="material-symbols-outlined icon-sm">visibility</span>
            Add to watchlist
          </button>
        </div>
      </template>
    </PartyIdentityCard>

    <!-- Cross-dossier risk roll-up -->
    <div v-if="party && riskSummary" class="risk-summary">
      <span class="material-symbols-outlined risk-summary-icon">account_tree</span>
      <span>
        Appears on <strong>{{ riskSummary.dossierCount }}</strong>
        {{ riskSummary.dossierCount === 1 ? 'dossier' : 'dossiers' }}.
      </span>
      <span v-if="riskSummary.worstTier" :class="['tier-chip', tierClass(riskSummary.worstTier)]">
        Highest risk: {{ riskSummary.worstTier }}
      </span>
      <span v-if="riskSummary.highRiskDossierCount > 0" class="risk-high-note">
        {{ riskSummary.highRiskDossierCount }} high-risk
        {{ riskSummary.highRiskDossierCount === 1 ? 'case' : 'cases' }}
      </span>
    </div>

    <div v-if="party?.mergedIntoPartyId" class="merged-notice">
      This party was merged into
      <RouterLink :to="`/party/${party.mergedIntoPartyId}`">another party</RouterLink>
      by {{ party.mergedBy || 'a reviewer' }} on {{ fmtDate(party.mergedAt) }}.
      <span v-if="party.mergeReason">Reason: <em>{{ party.mergeReason }}</em></span>
    </div>

    <div v-if="error" class="error">
      Failed to load: {{ error }}
    </div>

    <nav v-if="party" class="party-tabs">
      <button :class="{ active: activeTab === 'links' }" @click="activeTab = 'links'">
        Linked dossiers ({{ links.length }})
      </button>
      <button :class="{ active: activeTab === 'screening' }" @click="activeTab = 'screening'">
        Screening
      </button>
      <button :class="{ active: activeTab === 'network' }" @click="activeTab = 'network'">
        Network
      </button>
      <button :class="{ active: activeTab === 'review' }" @click="activeTab = 'review'">
        Review candidates ({{ reviewItems.length }})
      </button>
      <button :class="{ active: activeTab === 'audit' }" @click="activeTab = 'audit'">
        Audit
      </button>
    </nav>

    <!-- Linked dossiers -->
    <section v-if="party && activeTab === 'links'" class="party-section">
      <div v-for="role in ['officer', 'psc', 'shareholder']" :key="role">
        <h2 v-if="linksByRole[role]?.length" class="role-heading">
          {{ role === 'officer' ? 'Officer roles' : role === 'psc' ? 'PSC roles' : 'Shareholder roles' }}
        </h2>
        <table v-if="linksByRole[role]?.length" class="links-table">
          <thead>
            <tr>
              <th>Dossier</th>
              <th>Role detail</th>
              <th>Status</th>
              <th>Risk</th>
              <th>Case</th>
              <th>Dates</th>
              <th>Match</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="l in linksByRole[role]"
              :key="l.id"
              :class="['link-row', `status-${l.status}`]"
            >
              <td>
                <a href="#" @click.prevent="goDossier(l.companyNumber)">
                  {{ l.companyName || l.companyNumber }}
                </a>
                <div class="t-mono t-dim">{{ l.companyNumber }}</div>
              </td>
              <td>{{ l.roleDetail || '—' }}</td>
              <td>
                <span :class="`status-pill status-${l.status}`">{{ fmtStatus(l.status) }}</span>
              </td>
              <td>
                <span v-if="l.riskTier" :class="['tier-chip', tierClass(l.riskTier)]">{{ l.riskTier }}</span>
                <span v-else class="t-dim">—</span>
              </td>
              <td>
                <span :class="['case-pill', `case-pill--${l.caseStatus}`]">{{ caseStatusLabel(l.caseStatus) }}</span>
              </td>
              <td class="t-mono">
                <template v-if="l.appointedOn">apt {{ fmtDate(l.appointedOn) }}</template>
                <template v-if="l.resignedOn"><br />resigned {{ fmtDate(l.resignedOn) }}</template>
                <template v-if="l.notifiedOn">notified {{ fmtDate(l.notifiedOn) }}</template>
                <template v-if="l.ceasedOn"><br />ceased {{ fmtDate(l.ceasedOn) }}</template>
              </td>
              <td class="t-mono t-dim">
                {{ l.matchEvidence?.kind || '—' }}
                <template v-if="l.matchConfidence">({{ l.matchConfidence }})</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!links.length" class="empty">No links recorded.</p>
    </section>

    <!-- Network (Phase 5) -->
    <section v-if="party && activeTab === 'network'" class="party-section">
      <div class="network-controls">
        <label>
          Depth
          <select v-model.number="networkDepth">
            <option :value="1">1 (linked dossiers only)</option>
            <option :value="2">2 (+ other parties on those dossiers)</option>
          </select>
        </label>
        <label>
          Node limit
          <input v-model.number="networkLimit" type="number" min="5" max="200" step="5" />
        </label>
        <button class="reload" @click="loadNetwork" :disabled="networkLoading">
          {{ networkLoading ? 'Loading…' : 'Reload' }}
        </button>
      </div>
      <div v-if="networkError" class="error">Failed to load network: {{ networkError }}</div>
      <div v-else-if="networkLoading && !networkGraph" class="empty">Loading network…</div>
      <PartyGraph v-else-if="networkGraph" :graph="networkGraph" />
    </section>

    <!-- Screening (cross-dossier) -->
    <section v-if="party && activeTab === 'screening'" class="party-section">
      <div v-if="screeningError" class="error">Failed to load screening: {{ screeningError }}</div>
      <div v-else-if="screeningLoading && !screening" class="empty">Loading screening…</div>
      <template v-else-if="screening">
        <div class="screening-summary">
          <div class="screening-overall">
            <span class="t-label">Overall</span>
            <span :class="['decision-pill', decisionClass(screening.worstStatus)]">
              {{ decisionLabel(screening.worstStatus) }}
            </span>
          </div>
          <div class="screening-counts">
            <span class="count count--confirmed">{{ screening.counts.confirmed }} confirmed</span>
            <span class="count count--review">{{ screening.counts.needsReview }} review</span>
            <span class="count count--dismissed">{{ screening.counts.dismissed }} dismissed</span>
            <span class="count count--total">{{ screening.counts.total }} total</span>
          </div>
        </div>

        <p v-if="actionState.error" class="error">{{ actionState.error }}</p>

        <p v-if="!screening.hits.length" class="empty">
          No screening hits recorded for this party across any dossier.
        </p>
        <table v-else class="screening-table">
          <thead>
            <tr>
              <th>List</th>
              <th>Matched against</th>
              <th>Dossier</th>
              <th>Decision</th>
              <th>Override</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="hit in screening.hits" :key="hit.hitId">
              <td><span class="list-pill">{{ listLabel(hit.listSource) }}</span></td>
              <td>
                <div class="hit-subject">{{ hit.subjectName }}</div>
                <div v-if="hit.category" class="t-dim t-meta">{{ hit.category }}<template v-if="hit.severity"> · {{ hit.severity }}</template></div>
              </td>
              <td>
                <a href="#" @click.prevent="goDossier(hit.companyNumber)">{{ hit.companyName || hit.companyNumber }}</a>
              </td>
              <td>
                <span :class="['decision-pill', decisionClass(hit.effectiveDecision)]">
                  {{ decisionLabel(hit.effectiveDecision) }}
                </span>
                <div v-if="hit.partyOverride" class="t-dim t-meta">party override</div>
                <div v-else-if="hit.humanOverride" class="t-dim t-meta">run override</div>
              </td>
              <td>
                <div v-if="canOverride(hit)" class="override-actions">
                  <button
                    type="button"
                    class="ov-btn ov-btn--confirm"
                    :disabled="actionState.submitting"
                    @click="onOverride(hit, 'confirmed')"
                    :title="hit.isSanctions ? 'Confirm this match across all dossiers' : 'Confirm this article across all dossiers'"
                  >Confirm</button>
                  <button
                    type="button"
                    class="ov-btn ov-btn--dismiss"
                    :disabled="actionState.submitting"
                    @click="onOverride(hit, 'dismissed')"
                    title="Dismiss as a false positive across all dossiers"
                  >Dismiss</button>
                  <button
                    v-if="hit.partyOverride"
                    type="button"
                    class="ov-btn"
                    :disabled="actionState.submitting"
                    @click="onOverride(hit, null)"
                    title="Clear the party-level override"
                  >Clear</button>
                </div>
                <span v-else class="t-dim t-meta" title="No stable article URL to key an override on">read-only</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="t-meta t-dim screening-note">
          Overrides set here are party-level — they apply wherever this party
          appears, on this and future runs. Sanctions overrides key on the
          list entry; adverse-media overrides key on the article URL (so an
          article with no URL stays read-only).
        </p>
      </template>
    </section>

    <!-- Review queue -->
    <section v-if="party && activeTab === 'review'" class="party-section">
      <p v-if="!reviewItems.length" class="empty">No open review items.</p>
      <ul v-else class="review-list">
        <li v-for="item in reviewItems" :key="item.id" class="review-item">
          <div class="review-pair">
            <span class="review-side">
              <strong>This party</strong>
              <span v-if="item.party_id !== party.id">vs the new party from a recent run</span>
            </span>
            <span class="review-arrow">↔</span>
            <span class="review-side">
              <span v-if="item.party_id === party.id">vs candidate party</span>
              <span v-else><strong>This party</strong> (candidate)</span>
            </span>
          </div>
          <div class="review-score">
            <span :class="`confidence confidence-${item.confidence}`">{{ item.confidence }}</span>
            <span class="t-mono">score {{ Number(item.score).toFixed(3) }}</span>
            <span class="t-dim">via {{ item.matched_via }}</span>
          </div>
          <div class="review-actions">
            <button @click="openMergeDialog(item)" :disabled="actionState.submitting">
              Merge into this party
            </button>
          </div>
        </li>
      </ul>
    </section>

    <!-- Audit -->
    <section v-if="party && activeTab === 'audit'" class="party-section">
      <dl class="audit-dl">
        <dt>Created</dt><dd>{{ fmtDate(party.createdAt) }}</dd>
        <dt>Updated</dt><dd>{{ fmtDate(party.updatedAt) }}</dd>
        <dt>Source kind</dt><dd>{{ party.sourceKind }}</dd>
        <dt>Needs review</dt><dd>{{ party.needsReview ? 'Yes' : 'No' }}</dd>
        <dt v-if="party.reviewReason">Review reason</dt><dd v-if="party.reviewReason">{{ party.reviewReason }}</dd>
        <dt v-if="party.mergedIntoPartyId">Merged into</dt>
        <dd v-if="party.mergedIntoPartyId">
          <RouterLink :to="`/party/${party.mergedIntoPartyId}`">{{ party.mergedIntoPartyId }}</RouterLink>
          on {{ fmtDate(party.mergedAt) }} by {{ party.mergedBy }}
        </dd>
        <dt>Aliases</dt>
        <dd>
          <span v-if="!party.aliases?.length" class="t-dim">—</span>
          <span v-else class="t-mono">{{ party.aliases.join(' · ') }}</span>
        </dd>
      </dl>
    </section>

    <!-- Merge dialog -->
    <dialog :open="mergeDialog.open" class="merge-dialog">
      <h3>Merge into "{{ party?.fullName }}"</h3>
      <p>
        The other party ("{{ mergeDialog.loserName }}") will be soft-merged
        into this one. Its links and screening overrides move here. The
        loser row is kept so historical references still resolve.
      </p>
      <label>
        Reason (optional)
        <input
          v-model="mergeDialog.reason"
          type="text"
          placeholder="e.g. same person, different name spelling confirmed"
          maxlength="500"
        />
      </label>
      <div v-if="actionState.error" class="error">{{ actionState.error }}</div>
      <div class="dialog-buttons">
        <button @click="mergeDialog.open = false" :disabled="actionState.submitting">Cancel</button>
        <button
          @click="confirmMerge"
          :disabled="actionState.submitting"
          class="primary"
        >
          {{ actionState.submitting ? 'Merging…' : 'Confirm merge' }}
        </button>
      </div>
    </dialog>

    <!-- Watchlist dialog -->
    <dialog :open="watchDialog.open" class="merge-dialog">
      <h3>Add "{{ party?.fullName }}" to the watchlist</h3>
      <p>
        Watched parties are flagged for monitoring and surfaced on the
        Watchlist page. This is a manual flag — there is no automated
        re-screening in this POC.
      </p>
      <label>
        Reason (optional)
        <input
          v-model="watchDialog.reason"
          type="text"
          placeholder="e.g. recurring high-risk UBO across multiple cases"
          maxlength="500"
        />
      </label>
      <div v-if="actionState.error" class="error">{{ actionState.error }}</div>
      <div class="dialog-buttons">
        <button @click="watchDialog.open = false" :disabled="actionState.submitting">Cancel</button>
        <button @click="confirmWatch" :disabled="actionState.submitting" class="primary">
          {{ actionState.submitting ? 'Adding…' : 'Add to watchlist' }}
        </button>
      </div>
    </dialog>
  </article>
</template>

<style scoped>
.party-detail {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem;
}
.party-loading {
  padding: 2rem;
  color: var(--color-text-secondary, #666);
}
.party-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border, #ddd);
  margin-bottom: 1rem;
}
.party-name {
  font-size: 1.75rem;
  margin: 0.25rem 0 0.5rem;
}
.party-meta { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.party-tag {
  background: var(--surface-2, #f3f3f3);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.85rem;
}
.party-stats { display: flex; gap: 1.5rem; }
.stat { text-align: right; }
.stat-num { display: block; font-size: 1.5rem; font-weight: 600; }
.stat-label { font-size: 0.8rem; color: var(--text-2, #666); }
.stat-warn { color: #b45309; }
.merged-notice {
  background: #fef9c3;
  padding: 0.75rem 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
  font-size: 0.9rem;
}
.party-tabs {
  display: flex;
  gap: 0.5rem;
  border-bottom: 1px solid var(--border, #ddd);
  margin-bottom: 1rem;
}
.party-tabs button {
  border: 0;
  background: none;
  padding: 0.5rem 0.75rem;
  font: inherit;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.party-tabs button.active {
  border-bottom-color: var(--accent, #4f46e5);
  font-weight: 600;
}
.role-heading { font-size: 1rem; margin: 1rem 0 0.5rem; }
.links-table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
.links-table th, .links-table td {
  text-align: left;
  padding: 0.5rem;
  border-bottom: 1px solid var(--border, #eee);
  font-size: 0.9rem;
  vertical-align: top;
}
.links-table th { font-weight: 600; color: var(--text-2, #555); }
.status-pill {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 500;
}
.status-pill.status-active { background: #dcfce7; color: #166534; }
.status-pill.status-resigned { background: #fee2e2; color: #991b1b; }
.status-pill.status-ceased { background: #fee2e2; color: #991b1b; }
.status-pill.status-historical { background: #e5e7eb; color: #4b5563; }
.review-list { list-style: none; padding: 0; }
.review-item {
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.review-pair { display: flex; align-items: center; gap: 0.75rem; flex: 1; }
.review-arrow { color: var(--text-2, #888); }
.review-score { display: flex; gap: 0.75rem; align-items: center; }
.confidence {
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}
.confidence-EXACT { background: #dcfce7; color: #166534; }
.confidence-HIGH { background: #fef3c7; color: #92400e; }
.confidence-REVIEW { background: #fee2e2; color: #991b1b; }
.audit-dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1rem; }
.audit-dl dt { font-weight: 600; color: var(--text-2, #555); }
.audit-dl dd { margin: 0; }
.merge-dialog {
  border: 0;
  border-radius: 8px;
  padding: 1.5rem;
  box-shadow: 0 10px 30px rgba(0,0,0,0.2);
  max-width: 500px;
}
.merge-dialog input { width: 100%; margin-top: 0.25rem; padding: 0.4rem; }
.merge-dialog label { display: block; margin: 0.75rem 0; }
.dialog-buttons { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
.dialog-buttons .primary { background: var(--accent, #4f46e5); color: white; border: 0; padding: 0.5rem 1rem; border-radius: 4px; }
.empty { color: var(--text-2, #888); font-style: italic; }
.error { color: #b91c1c; padding: 0.5rem; background: #fee2e2; border-radius: 4px; margin: 0.5rem 0; }
.t-label { font-size: 0.75rem; color: var(--text-2, #888); text-transform: uppercase; letter-spacing: 0.05em; }
.t-mono { font-family: ui-monospace, monospace; font-size: 0.85rem; }
.t-dim { color: var(--text-2, #888); }
/* Phase 5 — Network tab controls */
.network-controls {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
  padding: 0.5rem 0 1rem;
  flex-wrap: wrap;
}
.network-controls label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}
.network-controls select,
.network-controls input {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border, #ddd);
  border-radius: 4px;
  font: inherit;
}
.network-controls input { width: 90px; }
.network-controls .reload {
  padding: 0.4rem 0.9rem;
  background: var(--accent, #4f46e5);
  color: white;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.network-controls .reload:disabled { opacity: 0.6; cursor: wait; }

/* Header actions + watchlist button */
.party-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.75rem;
}
.watch-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--border, #ddd);
  background: var(--surface, #fff);
  border-radius: 6px;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  color: var(--text-2, #555);
}
.watch-btn:hover:not(:disabled) { border-color: var(--accent, #4f46e5); color: var(--accent, #4f46e5); }
.watch-btn:disabled { opacity: 0.6; cursor: wait; }
.watch-btn--on {
  background: #ede9fe;
  border-color: #c7d2fe;
  color: #4338ca;
}
.watch-btn--on:hover:not(:disabled) { background: #ddd6fe; border-color: #a5b4fc; color: #3730a3; }

/* Cross-dossier risk summary */
.risk-summary {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  background: var(--surface-2, #f7f7f5);
  border: 1px solid var(--border, #e4e4dc);
  border-radius: 8px;
  padding: 0.6rem 0.9rem;
  margin-bottom: 1rem;
  font-size: 0.9rem;
}
.risk-summary-icon { font-size: 20px; color: var(--text-2, #666); }
.risk-high-note { color: #991b1b; font-weight: 600; font-size: 0.85rem; }

/* Risk tier chips (shared by summary + linked-dossiers table) */
.tier-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
}
.tier--low { background: #dcfce7; color: #166534; }
.tier--medium { background: #fef3c7; color: #92400e; }
.tier--high { background: #fee2e2; color: #991b1b; }
.tier--none { background: #e5e7eb; color: #6b7280; }

/* Case status pill in the linked-dossiers table */
.case-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 500;
  text-transform: capitalize;
  background: #e5e7eb;
  color: #4b5563;
}
.case-pill--approved { background: #dcfce7; color: #166534; }
.case-pill--rejected { background: #fee2e2; color: #991b1b; }
.case-pill--escalated { background: #fef3c7; color: #92400e; }
.case-pill--info_requested { background: #e0e7ff; color: #3730a3; }

/* Screening tab */
.screening-summary {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  flex-wrap: wrap;
  padding: 0.75rem 0 1rem;
}
.screening-overall { display: flex; flex-direction: column; gap: 0.25rem; }
.screening-counts { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.count {
  font-size: 0.85rem;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--surface-2, #f3f3f3);
  color: var(--text-2, #555);
}
.count--confirmed { background: #fee2e2; color: #991b1b; }
.count--review { background: #fef3c7; color: #92400e; }
.count--dismissed { background: #e5e7eb; color: #4b5563; }
.decision-pill {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
}
.decision--confirmed { background: #fee2e2; color: #991b1b; }
.decision--review { background: #fef3c7; color: #92400e; }
.decision--dismissed { background: #e5e7eb; color: #4b5563; }
.decision--none { background: #e5e7eb; color: #6b7280; }
.screening-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
.screening-table th, .screening-table td {
  text-align: left;
  padding: 0.5rem;
  border-bottom: 1px solid var(--border, #eee);
  font-size: 0.88rem;
  vertical-align: top;
}
.screening-table th { font-weight: 600; color: var(--text-2, #555); }
.hit-subject { font-weight: 500; }
.list-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 600;
  background: var(--surface-2, #f3f3f3);
  color: var(--text-2, #555);
}
.override-actions { display: flex; gap: 0.35rem; flex-wrap: wrap; }
.ov-btn {
  padding: 0.25rem 0.55rem;
  border: 1px solid var(--border, #ddd);
  background: var(--surface, #fff);
  border-radius: 4px;
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
.ov-btn:hover:not(:disabled) { border-color: var(--accent, #4f46e5); }
.ov-btn:disabled { opacity: 0.5; cursor: wait; }
.ov-btn--confirm:hover:not(:disabled) { border-color: #991b1b; color: #991b1b; }
.ov-btn--dismiss:hover:not(:disabled) { border-color: #166534; color: #166534; }
.screening-note { margin-top: 0.75rem; }
</style>
