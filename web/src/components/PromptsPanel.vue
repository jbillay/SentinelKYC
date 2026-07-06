<script setup>
import { ref, computed, onMounted } from 'vue'
import { usePrompts } from '../composables/usePrompts.js'

// Versioned prompt editor scoped to ONE agent — every prompt key belongs to
// exactly one agent (server-side `agent` field on /api/prompts). Rendered
// inside the agent's admin section; hides itself entirely when the agent owns
// no prompts (entity resolution and UBO are deterministic).
const props = defineProps({
  agent: { type: String, required: true },
})

const {
  list,
  detail,
  selectedVersionId,
  editorBody,
  editorNotes,
  saving,
  error,
  fetchList,
  selectKey,
  selectVersion,
  saveAsNewVersion,
  setActive,
} = usePrompts()

const showDefault = ref(false)
const loaded = ref(false)

const agentPrompts = computed(() => list.value.filter((p) => p.agent === props.agent))
const selectedKey = computed(() => detail.value?.key || null)
const isActiveSelected = computed(() => detail.value?.active?.id === selectedVersionId.value)

onMounted(async () => {
  await fetchList()
  const first = agentPrompts.value[0]
  if (first) await selectKey(first.key)
  loaded.value = true
})

async function pickKey(key) {
  showDefault.value = false
  await selectKey(key)
}

async function pickVersion(e) {
  showDefault.value = false
  await selectVersion(e.target.value)
}
</script>

<template>
  <section v-if="!loaded || agentPrompts.length" class="sheet sheet--prompts">
    <div class="sheet-head-row">
      <div>
        <h2 class="sheet-title">Prompts</h2>
        <p class="sheet-sub">
          The LLM prompts this agent uses. Saving creates a new version; the active version is the
          one used at runtime, switched instantly.
        </p>
      </div>
    </div>

    <div v-if="error" class="prompt-error">{{ error }}</div>

    <div class="prompts-layout">
      <aside class="prompt-rail">
        <ul class="prompt-list">
          <li
            v-for="p in agentPrompts"
            :key="p.key"
            :class="['prompt-item', { 'prompt-item--active': p.key === selectedKey }]"
            @click="pickKey(p.key)"
          >
            <div class="prompt-item-label">{{ p.label }}</div>
            <div class="prompt-item-key t-mono">{{ p.key }}</div>
            <div class="prompt-item-meta">
              <span class="t-label">Active</span>
              <span class="tabular">v{{ p.activeVersion ?? '–' }}</span>
              <span v-if="p.latestVersion && p.latestVersion !== p.activeVersion" class="prompt-item-stale">
                · latest v{{ p.latestVersion }}
              </span>
            </div>
          </li>
        </ul>
      </aside>

      <div v-if="detail" class="prompt-editor">
        <div class="prompt-editor-head">
          <div>
            <div class="prompt-editor-label">{{ detail.label }}</div>
            <div class="prompt-editor-desc">{{ detail.description }}</div>
          </div>
          <div class="prompt-editor-active">
            <span class="t-label">Active</span>
            <span class="badge">v{{ detail.active?.version ?? '–' }}</span>
          </div>
        </div>

        <label class="field">
          <span class="t-label">Version</span>
          <select :value="selectedVersionId" @change="pickVersion">
            <option v-for="v in detail.versions" :key="v.id" :value="v.id">
              v{{ v.version }}{{ detail.active?.id === v.id ? ' (active)' : '' }}
              · {{ new Date(v.createdAt).toLocaleString() }}
              {{ v.notes ? '— ' + v.notes : '' }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="t-label">Body</span>
          <textarea v-model="editorBody" class="prompt-body" rows="14"></textarea>
        </label>

        <label class="field">
          <span class="t-label">Notes (optional)</span>
          <input v-model="editorNotes" type="text" placeholder="What changed in this version?" />
        </label>

        <div class="actions">
          <button type="button" class="btn btn--ghost" @click="showDefault = !showDefault">
            {{ showDefault ? 'Hide default' : 'Show default body' }}
          </button>
          <div class="actions-spacer" />
          <button
            type="button"
            class="btn btn--secondary"
            :disabled="saving || isActiveSelected"
            @click="setActive()"
          >
            Set as active
          </button>
          <button
            type="button"
            class="btn btn--primary"
            :disabled="saving || !editorBody.trim()"
            @click="saveAsNewVersion()"
          >
            Save as new version
          </button>
        </div>

        <pre v-if="showDefault" class="prompt-default t-mono">{{ detail.defaultBody }}</pre>
      </div>

      <div v-else class="prompt-empty">Select a prompt to view its versions.</div>
    </div>
  </section>
</template>

<style scoped>
.sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-8);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.sheet--prompts {
  gap: var(--sp-5);
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
.prompts-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: var(--sp-6);
  align-items: start;
}
.prompt-rail {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-page);
}
.prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.prompt-item {
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: background-color var(--dur-fast) var(--ease);
}
.prompt-item:last-child {
  border-bottom: 0;
}
.prompt-item:hover {
  background: var(--color-surface);
}
.prompt-item--active {
  background: var(--color-primary-soft);
}
.prompt-item-label {
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-primary);
}
.prompt-item-key {
  font-size: 11px;
  color: var(--color-text-tertiary);
}
.prompt-item-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.prompt-item-stale {
  color: var(--color-tertiary, var(--color-text-tertiary));
}
.prompt-editor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.prompt-editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
}
.prompt-editor-label {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
}
.prompt-editor-desc {
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.prompt-editor-active {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
input[type='text'],
select {
  height: 38px;
  padding: 0 var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font: inherit;
}
input[type='text']:focus,
select:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
.prompt-body {
  width: 100%;
  min-height: 240px;
  padding: var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
}
.prompt-body:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.actions-spacer {
  flex: 1;
}
.prompt-default {
  margin: 0;
  padding: var(--sp-3);
  background: var(--color-page);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  white-space: pre-wrap;
  font-size: 12px;
  color: var(--color-text-secondary);
  max-height: 240px;
  overflow: auto;
}
.prompt-empty {
  padding: var(--sp-6);
  color: var(--color-text-tertiary);
}
.prompt-error {
  padding: var(--sp-3);
  background: rgba(220, 53, 69, 0.08);
  border: 1px solid rgba(220, 53, 69, 0.25);
  border-radius: var(--radius-md);
  color: var(--color-danger, #b00020);
  font-size: var(--fs-meta);
}
</style>
