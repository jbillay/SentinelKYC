<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import SideNav from '../components/layout/SideNav.vue'
import TopBar from '../components/layout/TopBar.vue'
import { useHealthStore } from '../stores/health.js'
import { useAgentStore } from '../stores/agent.js'

const route = useRoute()
const breadcrumb = computed(() => route.meta?.breadcrumb || '')

const health = useHealthStore()
const agent = useAgentStore()
onMounted(() => {
  health.start()
  agent.hydrate()
})
onBeforeUnmount(() => health.stop())
</script>

<template>
  <div class="shell">
    <SideNav />
    <div class="shell-main">
      <TopBar :breadcrumb="breadcrumb" />

      <div v-if="health.status === 'down'" class="health-banner health-banner--down" role="alert">
        <span class="material-symbols-outlined">error</span>
        <div class="banner-body">
          <strong>{{ health.statusLabel }}.</strong> The agent cannot run.
          <template v-for="f in health.failing" :key="f.task">
            {{ f.taskLabel }} ({{ f.providerLabel }} · <code class="t-mono">{{ f.model || '?' }}</code>) is unreachable<template v-if="f.detail">: <span class="banner-reason">{{ f.detail }}</span></template>.
            <template v-if="f.provider === 'ollama'">Start it with <code class="t-mono">ollama serve</code>.</template>
            <template v-else-if="f.provider === 'nvidia'">Check <code class="t-mono">NVIDIA_API_KEY</code> and <code class="t-mono">NVIDIA_OCR_ENDPOINT</code> in <code class="t-mono">server/.env</code>.</template>
          </template>
          <span v-if="!health.failing.length && health.lastError" class="banner-reason">Reason: {{ health.lastError }}</span>
        </div>
        <button type="button" class="banner-action" @click="health.check">Retry</button>
      </div>

      <div v-else-if="health.status === 'degraded'" class="health-banner health-banner--degraded" role="alert">
        <span class="material-symbols-outlined">warning</span>
        <div class="banner-body">
          <strong>Models missing.</strong> Ollama is reachable but the following models are not installed:
          <span class="t-mono">{{ health.missing.join(', ') }}</span>.
          Pull them with <code class="t-mono">ollama pull &lt;model&gt;</code> — runs will fail until they are.
        </div>
      </div>

      <main class="shell-content">
        <RouterView v-slot="{ Component }">
          <Transition name="fade" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
  background: var(--color-page);
}
.shell-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  margin-left: 240px;
  min-width: 0;
}
.shell-content {
  flex: 1;
  padding: var(--sp-8);
  max-width: 1440px;
  width: 100%;
  margin: 0 auto;
}

.health-banner {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-6);
  border-bottom: 1px solid var(--color-border);
  font-size: var(--fs-body);
}
.health-banner--down {
  background: var(--color-danger-soft);
  color: var(--color-text-primary);
  border-bottom-color: rgba(165, 40, 40, 0.18);
}
.health-banner--down .material-symbols-outlined {
  color: var(--color-danger);
}
.health-banner--degraded {
  background: var(--color-tertiary-soft);
  color: var(--color-text-primary);
  border-bottom-color: rgba(180, 83, 9, 0.18);
}
.health-banner--degraded .material-symbols-outlined {
  color: var(--color-tertiary);
}
.banner-body {
  flex: 1;
  line-height: 1.5;
}
.banner-body code {
  background: var(--color-surface);
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.banner-reason {
  display: block;
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.banner-action {
  background: var(--color-danger);
  color: var(--color-text-on-primary);
  border: 0;
  border-radius: var(--radius-md);
  padding: var(--sp-2) var(--sp-4);
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease);
}
.banner-action:hover {
  background: #8c2222;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 120ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
