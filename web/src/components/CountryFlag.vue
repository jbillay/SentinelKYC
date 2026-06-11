<script setup>
// Small flag + label pill. `code` is a lowercase ISO-3166-1 alpha-2 code
// (flag-icons key). When unknown, a neutral globe glyph stands in so the
// label still reads cleanly. SVG-based (flag-icons) so it renders identically
// on Windows, where Unicode emoji flags don't.
defineProps({
  code: { type: String, default: null },
  label: { type: String, default: '' },
})
</script>

<template>
  <span class="country">
    <span v-if="code" :class="['fi', `fi-${code}`, 'country-flag']" aria-hidden="true" />
    <span v-else class="material-symbols-outlined country-globe" aria-hidden="true">public</span>
    <span v-if="label" class="country-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.country {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.country-flag {
  width: 1.5rem;
  height: 1.125rem;
  border-radius: 3px;
  box-shadow: 0 0 0 1px rgba(16, 20, 24, 0.12);
  background-size: cover;
  flex-shrink: 0;
}
.country-globe {
  font-size: 18px;
  color: var(--color-text-tertiary, #737a82);
}
.country-label {
  font-weight: 500;
  color: var(--color-text-primary, #101418);
}
</style>
