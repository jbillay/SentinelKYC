import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const POLL_INTERVAL_MS = 15_000

const TASK_LABELS = { ocr: 'OCR', reasoning: 'Reasoning' }
const PROVIDER_LABELS = { ollama: 'Ollama', nvidia: 'NVIDIA' }

export const useHealthStore = defineStore('health', () => {
  const ok = ref(null) // null = not probed yet, true = up, false = down
  const llm = ref(null) // { ok, ocr:{provider,model,ok,detail,host?,missing?}, reasoning:{…}, checkedAt }
  const lastError = ref(null)
  const checkedAt = ref(null)

  let timer = null

  async function check() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      ok.value = !!data.ok
      llm.value = data.llm || null
      const failed = ['ocr', 'reasoning'].map((t) => data.llm?.[t]).find((t) => t && !t.ok)
      lastError.value = data.ok ? null : failed?.detail || 'unknown'
      checkedAt.value = Date.now()
    } catch (err) {
      ok.value = false
      llm.value = null
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

  // Per-task view of the llm block — one entry per probed task, in ocr → reasoning order.
  const tasks = computed(() => {
    if (!llm.value) return []
    return ['ocr', 'reasoning']
      .map((task) => {
        const info = llm.value[task]
        if (!info || !info.provider) return null
        return {
          task,
          taskLabel: TASK_LABELS[task] || task,
          provider: info.provider,
          providerLabel: PROVIDER_LABELS[info.provider] || info.provider,
          model: info.model || null,
          ok: info.ok === true,
          detail: info.detail || null,
          host: info.host || null,
          missing: info.missing || [],
        }
      })
      .filter(Boolean)
  })

  const failing = computed(() => tasks.value.filter((t) => !t.ok))
  const missing = computed(() => [...new Set(tasks.value.flatMap((t) => t.missing))])

  // 'Ollama', 'NVIDIA', or 'NVIDIA + Ollama' when the two tasks use different backends.
  const providerLabel = computed(() => {
    const names = [...new Set(tasks.value.map((t) => t.providerLabel))]
    return names.join(' + ') || 'LLM'
  })

  const status = computed(() => {
    if (ok.value === null) return 'unknown'
    if (ok.value === true) {
      if (missing.value.length) return 'degraded'
      return 'ok'
    }
    return 'down'
  })

  const statusLabel = computed(() => {
    switch (status.value) {
      case 'ok':
        return `${providerLabel.value} online`
      case 'degraded':
        return 'Models missing'
      case 'down':
        if (!llm.value) return 'API offline'
        if (failing.value.length === 1) return `${failing.value[0].taskLabel} provider offline`
        return `${providerLabel.value} offline`
      default:
        return 'Checking…'
    }
  })

  return {
    ok,
    llm,
    tasks,
    failing,
    missing,
    providerLabel,
    lastError,
    checkedAt,
    status,
    statusLabel,
    check,
    start,
    stop,
  }
})
