// Phase 5 / Q5 — per-action form drafts for the FinalDecisionPanel.
//
// Keeps the in-progress text/items for each of the four decision actions so
// the reviewer can flip between Reject / Escalate / Request Info forms
// without losing input. Drafts are scoped by runId so opening a different
// dossier doesn't surface stale text. On a successful submit, clearAll()
// wipes the drafts for that run.

import { defineStore } from 'pinia'
import { reactive } from 'vue'

function emptyDrafts() {
  return {
    reject: { reasonCode: '', freeText: '' },
    escalate: { notes: '', suggestedAction: '' },
    request_info: { items: [{ description: '', category: '' }] },
  }
}

export const useDecisionStore = defineStore('decision', () => {
  // runId -> { reject, escalate, request_info }
  const drafts = reactive({})
  // runId -> 'approve' | 'reject' | 'escalate' | 'request_info' | null
  const openAction = reactive({})

  function ensure(runId) {
    if (!runId) return null
    if (!drafts[runId]) drafts[runId] = emptyDrafts()
    return drafts[runId]
  }

  function getDraft(runId, action) {
    const d = ensure(runId)
    return d ? d[action] : null
  }

  function setReject(runId, patch) {
    const d = ensure(runId)
    if (!d) return
    Object.assign(d.reject, patch)
  }

  function setEscalate(runId, patch) {
    const d = ensure(runId)
    if (!d) return
    Object.assign(d.escalate, patch)
  }

  function setRequestInfoItem(runId, idx, patch) {
    const d = ensure(runId)
    if (!d) return
    const item = d.request_info.items[idx]
    if (item) Object.assign(item, patch)
  }

  function addRequestInfoItem(runId) {
    const d = ensure(runId)
    if (!d) return
    d.request_info.items.push({ description: '', category: '' })
  }

  function removeRequestInfoItem(runId, idx) {
    const d = ensure(runId)
    if (!d) return
    if (d.request_info.items.length <= 1) return
    d.request_info.items.splice(idx, 1)
  }

  function setOpenAction(runId, action) {
    if (!runId) return
    openAction[runId] = action
  }

  function getOpenAction(runId) {
    if (!runId) return null
    return openAction[runId] || null
  }

  function clearAll(runId) {
    if (!runId) return
    delete drafts[runId]
    delete openAction[runId]
  }

  return {
    drafts,
    openAction,
    getDraft,
    setReject,
    setEscalate,
    setRequestInfoItem,
    addRequestInfoItem,
    removeRequestInfoItem,
    setOpenAction,
    getOpenAction,
    clearAll,
  }
})
