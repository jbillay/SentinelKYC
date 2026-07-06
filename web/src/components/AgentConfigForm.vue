<script setup>
import { reactive, watch } from 'vue'

// Per-agent configuration form — renders the agent definition's `fields`
// metadata as inputs over a local draft, emits the full config body on save.
// The parent owns the API call and passes the refreshed agent back down,
// which reseeds the draft.
const props = defineProps({
  agent: { type: Object, required: true },
  canEdit: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
})
const emit = defineEmits(['save'])

const draft = reactive({})

function seed() {
  for (const k of Object.keys(draft)) delete draft[k]
  for (const f of props.agent.fields || []) draft[f.key] = props.agent.config?.[f.key]
}
watch(() => props.agent, seed, { immediate: true })

function coerce(field, value) {
  if (field.type === 'number') {
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  if (field.type === 'boolean') return !!value
  if (field.type === 'multiselect') return Array.isArray(value) ? value : []
  return value
}

function isDirty() {
  return (props.agent.fields || []).some(
    (f) => JSON.stringify(coerce(f, draft[f.key])) !== JSON.stringify(props.agent.config?.[f.key])
  )
}

function toggleMulti(key, opt, checked) {
  const current = Array.isArray(draft[key]) ? [...draft[key]] : []
  const ix = current.indexOf(opt)
  if (checked && ix === -1) current.push(opt)
  if (!checked && ix !== -1) current.splice(ix, 1)
  draft[key] = current
}

function onSave() {
  const body = { ...props.agent.config, enabled: props.agent.enabled }
  for (const f of props.agent.fields || []) body[f.key] = coerce(f, draft[f.key])
  emit('save', body)
}

function onReset() {
  seed()
}
</script>

<template>
  <div class="config-form">
    <div class="fields">
      <label v-for="field in agent.fields" :key="field.key" class="field">
        <span class="t-label">{{ field.label }}</span>

        <input
          v-if="field.type === 'boolean'"
          type="checkbox"
          :checked="!!draft[field.key]"
          :disabled="!canEdit"
          @change="draft[field.key] = $event.target.checked"
        />
        <select v-else-if="field.type === 'select'" v-model="draft[field.key]" :disabled="!canEdit">
          <option v-for="opt in field.options" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <span v-else-if="field.type === 'multiselect'" class="multiselect">
          <label v-for="opt in field.options" :key="opt" class="multiselect-opt">
            <input
              type="checkbox"
              :checked="(draft[field.key] || []).includes(opt)"
              :disabled="!canEdit"
              @change="toggleMulti(field.key, opt, $event.target.checked)"
            />
            {{ opt }}
          </label>
          <span v-if="!field.options.length" class="t-meta">No vendors available yet.</span>
        </span>
        <input
          v-else-if="field.type === 'number'"
          v-model="draft[field.key]"
          type="number"
          :min="field.min"
          :max="field.max"
          :step="field.step || 1"
          :disabled="!canEdit"
        />
        <input v-else v-model="draft[field.key]" type="text" :disabled="!canEdit" />

        <span v-if="field.description" class="field-hint t-meta">{{ field.description }}</span>
      </label>
    </div>

    <div v-if="canEdit" class="form-actions">
      <button type="button" class="btn btn--primary" :disabled="!isDirty() || saving" @click="onSave">
        {{ saving ? 'Saving…' : 'Save changes' }}
      </button>
      <button type="button" class="btn" :disabled="!isDirty() || saving" @click="onReset">Reset</button>
      <span class="t-meta config-version">v{{ agent.activeVersion ?? '—' }}</span>
    </div>
  </div>
</template>

<style scoped>
.config-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
input[type='text'],
input[type='number'],
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
input[type='number']:focus,
select:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
.form-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.config-version {
  margin-left: auto;
}
.multiselect {
  display: flex;
  gap: var(--sp-4);
  flex-wrap: wrap;
}
.multiselect-opt {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
</style>
