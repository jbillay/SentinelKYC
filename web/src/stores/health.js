import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const POLL_INTERVAL_MS = 15_000

export const useHealthStore = defineStore('health', () => {
  const ok = ref(null) // null = not probed yet, true = up, false = down
  const ollama = ref(null)
  const lastError = ref(null)
  const checkedAt = ref(null)

  let timer = null

  async function check() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      ok.value = !!data.ok
      ollama.value = data.ollama || null
      lastError.value = data.ollama?.ok ? null : data.ollama?.reason || 'unknown'
      checkedAt.value = Date.now()
    } catch (err) {
      ok.value = false
      ollama.value = null
      lastError.value = err.message || 'API server unreachable'
      checkedAt.value = Date.now()
    }
  }

  function start() {
    if (timer) return
    check()
    timer = setInterval(check, POLL_INTERVAL_MS)
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const status = computed(() => {
    if (ok.value === null) return 'unknown'
    if (ok.value === true) {
      const missing = ollama.value?.missing || []
      if (missing.length) return 'degraded'
      return 'ok'
    }
    return 'down'
  })

  const statusLabel = computed(() => {
    switch (status.value) {
      case 'ok': return 'Ollama online'
      case 'degraded': return 'Models missing'
      case 'down': return 'Ollama offline'
      default: return 'Checking…'
    }
  })

  return {
    ok,
    ollama,
    lastError,
    checkedAt,
    status,
    statusLabel,
    check,
    start,
    stop,
  }
})
