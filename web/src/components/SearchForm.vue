<script setup>
import { ref } from 'vue'

defineProps({
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['submit'])

const name = ref('')
const postcode = ref('')
const incorporationYear = ref('')
const companyNumber = ref('')

function submit() {
  const input = {}
  if (name.value.trim()) input.name = name.value.trim()
  if (postcode.value.trim()) input.postcode = postcode.value.trim()
  if (incorporationYear.value) input.incorporationYear = Number(incorporationYear.value)
  if (companyNumber.value.trim()) input.companyNumber = companyNumber.value.trim()
  emit('submit', input)
}
</script>

<template>
  <form class="search" @submit.prevent="submit">
    <label class="field field--full">
      <span class="t-label">Company name</span>
      <input
        v-model="name"
        placeholder="e.g. Barclays Bank PLC"
        autofocus
        :disabled="disabled"
      />
      <span class="t-meta hint">Required.</span>
    </label>

    <label class="field">
      <span class="t-label">Postcode</span>
      <input
        v-model="postcode"
        placeholder="EC2N 4AA"
        class="mono-input"
        :disabled="disabled"
      />
      <span class="t-meta hint">Optional · sharpens the match.</span>
    </label>

    <label class="field">
      <span class="t-label">Incorporation year</span>
      <input
        v-model="incorporationYear"
        type="number"
        placeholder="1985"
        class="mono-input"
        :disabled="disabled"
      />
      <span class="t-meta hint">Optional.</span>
    </label>

    <label class="field field--full">
      <span class="t-label">Company number</span>
      <input
        v-model="companyNumber"
        placeholder="00006245"
        class="mono-input"
        :disabled="disabled"
      />
      <span class="t-meta hint">Optional · exact match wins.</span>
    </label>

    <div class="actions">
      <button type="submit" class="btn btn--primary" :disabled="disabled">
        <span v-if="disabled" class="spinner spinner--sm spinner--on-primary" aria-hidden="true"></span>
        {{ disabled ? 'Running' : 'Run' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.search {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4) var(--sp-6);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.field--full {
  grid-column: 1 / -1;
}

input {
  width: 100%;
  padding: 10px var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  transition: border-color var(--dur-fast) var(--ease),
              box-shadow var(--dur-fast) var(--ease);
}
input::placeholder {
  color: var(--color-text-tertiary);
}
input:hover:not(:disabled) {
  border-color: var(--color-border-strong);
}
input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
input:disabled {
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
  cursor: not-allowed;
}
.mono-input {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.01em;
}

.hint {
  display: block;
}

.actions {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
}

@media (max-width: 640px) {
  .search {
    grid-template-columns: 1fr;
  }
}
</style>
