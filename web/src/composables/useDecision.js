// Phase 5 / Q5 — POST a reviewer decision and surface server errors.
//
// The server validates the payload with the same Zod schema that's also
// imported by the panel, so the only errors expected here are 409
// (invalid_transition) and 5xx. The composable returns reactive state so the
// panel can disable buttons and show inline errors without rolling its own
// fetch wrapper.

import { ref } from 'vue'

export function useDecision() {
  const submitting = ref(false)
  const error = ref(null)
  // server's Zod issues array (when error.code === 'invalid_payload')
  const validationErrors = ref(null)

  async function submitDecision({ companyNumber, runId, payload }) {
    if (!companyNumber || !runId) {
      throw new Error('submitDecision: companyNumber and runId required')
    }
    submitting.value = true
    error.value = null
    validationErrors.value = null
    try {
      const res = await fetch(
        `/api/dossiers/${encodeURIComponent(companyNumber)}/runs/${encodeURIComponent(runId)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 400 && body?.validationErrors) {
          validationErrors.value = body.validationErrors
          error.value = 'Invalid payload.'
        } else if (res.status === 409) {
          const from = body?.from || 'unknown'
          if (from === 'approved' || from === 'rejected') {
            error.value = `This case has already been finalised (${from}). The view will refresh — no further action is needed.`
          } else {
            error.value = `Cannot ${body.action || payload.action} a case in state "${from}".`
          }
        } else {
          error.value = body?.error || `Request failed: ${res.status}`
        }
        const e = new Error(error.value)
        e.status = res.status
        e.body = body
        throw e
      }
      return body
    } catch (err) {
      if (!error.value) error.value = err.message
      throw err
    } finally {
      submitting.value = false
    }
  }

  return {
    submitting,
    error,
    validationErrors,
    submitDecision,
  }
}
