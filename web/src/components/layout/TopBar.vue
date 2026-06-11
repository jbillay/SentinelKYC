<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import HealthIndicator from './HealthIndicator.vue'
import { useAuthStore } from '../../stores/auth.js'

defineProps({
  breadcrumb: { type: String, default: '' },
})

const router = useRouter()
const auth = useAuthStore()
const partyQuery = ref('')

// Global party search — deep-links to the party directory with ?q=.
function submitPartySearch() {
  const q = partyQuery.value.trim()
  router.push({ name: 'parties', query: q ? { q } : {} })
}

async function signOut() {
  await auth.logout()
  router.push({ name: 'signin' })
}
</script>

<template>
  <header class="topbar">
    <nav class="crumbs" aria-label="Breadcrumb">
      <RouterLink :to="{ name: 'dossiers' }" class="crumb crumb--link">Sentinel KYC</RouterLink>
      <span class="material-symbols-outlined icon-sm crumb-sep">chevron_right</span>
      <span class="crumb crumb--current">{{ breadcrumb }}</span>
    </nav>

    <div class="actions">
      <form class="party-search" role="search" @submit.prevent="submitPartySearch">
        <span class="material-symbols-outlined party-search-icon">search</span>
        <input
          v-model="partyQuery"
          type="search"
          placeholder="Search parties…"
          aria-label="Search parties"
        />
      </form>
      <HealthIndicator />
      <button type="button" class="icon-btn" aria-label="Notifications">
        <span class="material-symbols-outlined">notifications</span>
      </button>
      <RouterLink
        v-if="auth.isAuthenticated"
        :to="{ name: 'settings', hash: '#account' }"
        class="user-chip"
        :title="`Signed in as ${auth.username} — edit your account`"
      >
        <span class="material-symbols-outlined icon-sm">account_circle</span>
        <span class="user-name">{{ auth.displayName || auth.username }}</span>
        <span class="user-role">{{ auth.role }}</span>
      </RouterLink>
      <button
        v-if="auth.isAuthenticated"
        type="button"
        class="icon-btn"
        aria-label="Sign out"
        title="Sign out"
        @click="signOut"
      >
        <span class="material-symbols-outlined">logout</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  height: 56px;
  width: 100%;
  background: var(--color-page);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-6);
  z-index: 40;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.crumb {
  font-size: var(--fs-label);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}
.crumb--link {
  text-decoration: none;
  border-radius: var(--radius-sm);
  padding: 2px 4px;
  margin: -2px -4px;
  transition: color var(--dur-fast) var(--ease),
              background-color var(--dur-fast) var(--ease);
}
.crumb--link:hover {
  color: var(--color-primary);
  background: var(--color-surface);
}
.crumb-sep {
  color: var(--color-text-tertiary);
}
.crumb--current {
  color: var(--color-primary);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.party-search {
  position: relative;
  display: flex;
  align-items: center;
}
.party-search-icon {
  position: absolute;
  left: var(--sp-2);
  font-size: 18px;
  color: var(--color-text-tertiary);
  pointer-events: none;
}
.party-search input {
  font: inherit;
  font-size: var(--fs-meta);
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  height: 34px;
  width: 200px;
  padding: 0 var(--sp-2) 0 calc(var(--sp-2) + 22px);
  transition: width var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.party-search input:focus {
  outline: 0;
  border-color: var(--color-primary);
  width: 260px;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease),
              color var(--dur-fast) var(--ease);
}
.icon-btn:hover {
  background: var(--color-surface);
  color: var(--color-primary);
}

.user-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  height: 34px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  text-decoration: none;
  transition: border-color var(--dur-fast) var(--ease),
              background-color var(--dur-fast) var(--ease);
}
.user-chip:hover {
  border-color: var(--color-primary);
  background: var(--color-page);
}
.user-name {
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--color-text-primary);
}
.user-role {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}
</style>
