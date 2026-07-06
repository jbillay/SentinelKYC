<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DataModelTab from '../components/DataModelTab.vue'
import ProcessTab from '../components/ProcessTab.vue'
import AgentsPanel from '../components/AgentsPanel.vue'

// Admin is master-detail: the Agents tab lists the six pipeline agents
// (enable/disable + link); each agent's configuration, prompts, and related
// engine settings live on its own page (/admin/agents/:agentId). The old
// Screening / Risk matrix / Prompts tabs are folded into those pages.
const TABS = [
  { id: 'agents', label: 'Agents' },
  { id: 'data-model', label: 'Data model' },
  { id: 'process', label: 'Process' },
  { id: 'members', label: 'Members' },
]

const route = useRoute()
const router = useRouter()
const tab = ref('agents')

const HASH_TAB = {
  '#agents': 'agents',
  '#data-model': 'data-model',
  '#process': 'process',
  '#members': 'members',
}

// Legacy deep links from before the restructure — the content moved into the
// per-agent sections, so land the visitor there.
const HASH_REDIRECT = {
  '#screening': 'screening',
  '#risk-matrix': 'risk-assessment',
  '#prompts': 'document-manager',
}

function applyHash(h) {
  const redirect = HASH_REDIRECT[h]
  if (redirect) {
    router.replace({ name: 'admin-agent', params: { agentId: redirect } })
    return
  }
  const t = HASH_TAB[h]
  if (t) tab.value = t
}

onMounted(() => applyHash(route.hash))
watch(
  () => route.hash,
  (h) => applyHash(h)
)

// ---- Members tab (real application users) ----
const members = ref([])
const membersLoading = ref(false)
const membersError = ref(null)

async function loadMembers() {
  membersLoading.value = true
  membersError.value = null
  try {
    const res = await fetch('/api/admin/users')
    if (!res.ok) throw new Error(`load failed: ${res.status}`)
    const body = await res.json()
    members.value = body.users || []
  } catch (err) {
    membersError.value = err.message
  } finally {
    membersLoading.value = false
  }
}

watch(
  tab,
  async (val) => {
    if (val === 'members' && members.value.length === 0 && !membersLoading.value) {
      await loadMembers()
    }
  },
  { immediate: false }
)

function memberInitials(m) {
  const name = (m.displayName || m.username || '?').trim()
  const parts = name.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function fmtLogin(v) {
  if (!v) return 'Never'
  return new Date(v).toLocaleString()
}

const activeMemberCount = computed(() => members.value.filter((m) => m.active).length)
</script>

<template>
  <div class="admin">
    <header class="page-head">
      <div>
        <h1 class="t-headline">Admin</h1>
        <p class="t-meta page-sub">Pipeline configuration and members. Admin access only.</p>
      </div>
    </header>

    <nav class="tabs">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        :class="['tab', { 'tab--active': tab === t.id }]"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </nav>

    <AgentsPanel v-if="tab === 'agents'" id="agents" />

    <DataModelTab v-if="tab === 'data-model'" />

    <ProcessTab v-if="tab === 'process'" />

    <section v-if="tab === 'members'" id="members" class="sheet">
      <div class="sheet-head-row">
        <div>
          <h2 class="sheet-title">Members</h2>
          <p class="sheet-sub">
            {{ activeMemberCount }} active · {{ members.length }} total — application users with sign-in access.
          </p>
        </div>
        <button
          type="button"
          class="btn btn--ghost"
          :disabled="membersLoading"
          @click="loadMembers"
        >
          <span class="material-symbols-outlined icon-sm">refresh</span>
          Reload
        </button>
      </div>

      <div v-if="membersError" class="panel-error">{{ membersError }}</div>

      <p v-if="membersLoading && !members.length" class="t-meta">Loading members…</p>
      <p v-else-if="!members.length && !membersError" class="t-meta">No members found.</p>

      <ul v-if="members.length" class="members">
        <li v-for="m in members" :key="m.id" :class="['member', { 'member--inactive': !m.active }]">
          <span class="avatar">{{ memberInitials(m) }}</span>
          <div class="member-body">
            <div class="member-name">
              {{ m.displayName || m.username }}
              <span v-if="!m.active" class="status-pill status-pill--inactive">Inactive</span>
            </div>
            <div class="member-email t-mono">{{ m.email || m.username }}</div>
          </div>
          <div class="member-meta">
            <span class="t-label">Last sign-in</span>
            <span class="tabular t-mono">{{ fmtLogin(m.lastLoginAt) }}</span>
          </div>
          <span :class="['role-tag', `role-tag--${m.role}`]">{{ m.role }}</span>
        </li>
      </ul>

      <p class="t-meta">
        Members are provisioned via <code class="t-mono">npm run users:seed</code> from <code class="t-mono">server/</code>. In-app invite and role management are not part of this build.
      </p>
    </section>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.page-head h1 { margin: 0; }
.page-sub { margin: var(--sp-1) 0 0; }

.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--color-border);
}
.tab {
  background: transparent;
  border: 0;
  padding: var(--sp-3) var(--sp-4);
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease);
}
.tab:hover { color: var(--color-text-primary); }
.tab--active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

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

.members {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.member {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--color-border);
}
.member:last-child { border-bottom: 0; }
.member--inactive { opacity: 0.6; }

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.member-name {
  font-weight: 500;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.member-email {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}
.member-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  text-align: right;
}

.status-pill {
  display: inline-block;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.status-pill--inactive {
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}

.role-tag {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
}
.role-tag--admin {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.role-tag--reviewer {
  background: var(--color-tertiary-soft, var(--color-surface-sunken));
  color: var(--color-tertiary, var(--color-text-secondary));
}
</style>
