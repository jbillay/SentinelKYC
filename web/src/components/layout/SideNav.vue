<script setup>
import { useAgentStore } from '../../stores/agent.js'

const agent = useAgentStore()

const NAV = [
  { to: { name: 'dossiers' }, icon: 'folder_open', label: 'Dossiers' },
  { to: { name: 'parties' }, icon: 'groups', label: 'Parties' },
  { to: { name: 'watchlist' }, icon: 'visibility', label: 'Watchlist' },
  { to: { name: 'audit' }, icon: 'history', label: 'Audit log' },
  { to: { name: 'settings' }, icon: 'settings', label: 'Settings' },
]
</script>

<template>
  <nav class="rail">
    <RouterLink :to="{ name: 'dossiers' }" class="brand" aria-label="Sentinel KYC — Dossiers">
      <img
        src="/sentinel-kyc-logo.png"
        alt="Sentinel KYC"
        class="brand-logo"
        width="208"
        height="42"
      />
    </RouterLink>

    <div class="cta-wrap">
      <RouterLink :to="{ name: 'search' }" class="cta">
        <span class="material-symbols-outlined icon-sm">add</span>
        New search
      </RouterLink>
    </div>

    <ul class="nav">
      <li v-for="n in NAV" :key="n.label">
        <RouterLink :to="n.to" class="nav-item" active-class="nav-item--active">
          <span class="material-symbols-outlined">{{ n.icon }}</span>
          <span class="nav-label">{{ n.label }}</span>
        </RouterLink>
      </li>
    </ul>

    <!-- Live agents indicator -->
    <div v-if="agent.runningRuns.length" class="live">
      <div class="live-head">
        <span class="t-label">Agents running</span>
        <span class="live-count tabular">{{ agent.runningRuns.length }}</span>
      </div>
      <ul class="live-list">
        <li v-for="r in agent.runningRuns" :key="r.threadId">
          <RouterLink
            :to="{ name: 'run', params: { threadId: r.threadId } }"
            class="live-link"
            active-class="live-link--active"
          >
            <span class="live-dot" />
            <span class="live-name">{{ r.subjectName }}</span>
          </RouterLink>
        </li>
      </ul>
    </div>

    <div class="foot">
      <a href="#" class="nav-item nav-item--ghost">
        <span class="material-symbols-outlined">help</span>
        <span class="nav-label">Help center</span>
      </a>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 240px;
  background: var(--color-surface);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  z-index: 50;
}

.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
  border-bottom: 1px solid var(--color-border);
  text-decoration: none;
}
.brand-logo {
  width: 100%;
  max-width: 208px;
  height: auto;
  display: block;
  /* Keep the white-background PNG looking crisp on the surface — no filter,
     no transform; the logo art was designed against white so the sidebar's
     light surface is the right canvas. */
}

.cta-wrap {
  padding: var(--sp-4);
}
.cta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  width: 100%;
  height: 38px;
  background: var(--color-primary);
  color: var(--color-text-on-primary);
  border-radius: var(--radius-md);
  font-weight: 500;
  font-size: var(--fs-body);
  text-decoration: none;
  transition: background-color var(--dur-fast) var(--ease);
}
.cta:hover {
  background: var(--color-primary-hover);
}

.nav {
  list-style: none;
  margin: 0;
  padding: 0 var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  overflow-y: auto;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  text-decoration: none;
  transition: background-color var(--dur-fast) var(--ease),
              color var(--dur-fast) var(--ease);
  font-size: var(--fs-body);
  font-weight: 500;
}
.nav-item:hover {
  background: var(--color-page);
  color: var(--color-text-primary);
}
.nav-item--active,
.nav-item.router-link-active {
  background: var(--color-page);
  color: var(--color-primary);
  font-weight: 600;
}
.nav-item--active .material-symbols-outlined,
.nav-item.router-link-active .material-symbols-outlined {
  font-variation-settings: 'FILL' 1, 'wght' 500, 'GRAD' 0, 'opsz' 24;
}

.live {
  margin: 0 var(--sp-3) var(--sp-3);
  padding: var(--sp-3);
  background: var(--color-primary-soft);
  border: 1px solid rgba(11, 61, 145, 0.18);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.live-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-1);
}
.live-count {
  background: var(--color-primary);
  color: var(--color-text-on-primary);
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  min-width: 18px;
  text-align: center;
}
.live-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.live-link {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--radius-sm);
  text-decoration: none;
  color: var(--color-text-primary);
  transition: background-color var(--dur-fast) var(--ease);
}
.live-link:hover {
  background: rgba(255, 255, 255, 0.5);
}
.live-link--active {
  background: var(--color-surface);
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: live-pulse 1.6s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes live-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(11, 61, 145, 0.4); }
  50% { box-shadow: 0 0 0 5px rgba(11, 61, 145, 0); }
}
.live-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.foot {
  padding: var(--sp-3);
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
</style>
