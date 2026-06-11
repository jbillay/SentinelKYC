<script setup>
const props = defineProps({
  candidates: { type: Array, required: true },
  resolution: { type: Object, default: null },
})

const emit = defineEmits(['pick'])

function fmtScore(s) {
  if (typeof s !== 'number') return ''
  return s.toFixed(2)
}

function isAutoMatch(c) {
  return props.resolution?.status === 'auto_match' && c.companyNumber === props.resolution?.chosen
}

function pick(num) {
  emit('pick', num)
}
</script>

<template>
  <div class="disambig">
    <header class="head">
      <span class="step-num">02b</span>
      <div>
        <h2 class="t-title">Confirm the company</h2>
        <p class="t-meta">
          {{ resolution?.reason || `Top ${candidates.length} matches from Companies House. Pick one to continue.` }}
        </p>
      </div>
    </header>

    <ul class="list">
      <li v-for="c in candidates" :key="c.companyNumber">
        <button
          type="button"
          class="row"
          :class="{ 'row--auto': isAutoMatch(c) }"
          @click="pick(c.companyNumber)"
        >
          <div class="row-main">
            <div class="row-top">
              <span class="row-title">{{ c.title }}</span>
              <span
                v-if="c.status"
                :class="['status-pill', `status-pill--${c.status}`]"
              >
                {{ c.status }}
              </span>
            </div>

            <div class="row-meta">
              <span class="row-num t-mono">#{{ c.companyNumber }}</span>
              <span v-if="c.incorporationDate" class="meta-item">
                <span class="t-label meta-label">Incorporated</span>
                <span class="meta-val tabular">{{ c.incorporationDate }}</span>
              </span>
              <span v-if="c.type" class="meta-item">
                <span class="t-label meta-label">Type</span>
                <span class="meta-val">{{ c.type }}</span>
              </span>
            </div>

            <div v-if="c.address" class="row-addr">{{ c.address }}</div>
          </div>

          <div class="row-right">
            <span
              v-if="isAutoMatch(c)"
              class="chip chip--primary"
              title="Auto-matched: high confidence and clear lead over other candidates."
            >
              Auto-matched
            </span>
            <span v-else class="chip chip--score" :title="`Resolver score for this candidate`">
              <span class="chip-label t-label">Score</span>
              <span class="chip-val tabular">{{ fmtScore(c.score) }}</span>
            </span>
            <span class="row-cta" aria-hidden="true">
              Select
              <svg viewBox="0 0 12 12" width="10" height="10">
                <path
                  d="M3.5 2.5 L7.5 6 L3.5 9.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </div>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.disambig {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.head {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-start;
}
.head h2 {
  margin: 0;
}
.head p {
  margin: var(--sp-1) 0 0;
}

.list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.row {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--sp-4);
  align-items: center;
  text-align: left;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-left: 3px solid transparent;
  border-radius: var(--radius-md);
  padding: var(--sp-4) var(--sp-4) var(--sp-4) var(--sp-4);
  cursor: pointer;
  color: var(--color-text-primary);
  transition: background-color var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease),
              transform var(--dur-fast) var(--ease);
}
.row:hover {
  background: var(--color-page);
  border-left-color: var(--color-primary);
}
.row:hover .row-cta {
  color: var(--color-primary);
  transform: translateX(2px);
}
.row:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.row--auto {
  background: var(--color-primary-soft);
  border-color: rgba(11, 61, 145, 0.18);
  border-left-color: var(--color-primary);
}
.row--auto:hover {
  background: #DDE6F9;
}

.row-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.row-top {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.row-title {
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--color-text-primary);
  line-height: 1.3;
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4);
  align-items: baseline;
}
.row-num {
  color: var(--color-text-secondary);
  font-weight: 500;
}
.meta-item {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
}
.meta-label {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--color-text-tertiary);
}
.meta-val {
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  font-weight: 500;
}

.row-addr {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
  line-height: 1.5;
  max-width: 60ch;
}

.row-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--sp-2);
  flex-shrink: 0;
}

/* Score chip */
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-pill);
  background: var(--color-surface-sunken);
  font-size: var(--fs-meta);
  white-space: nowrap;
}
.chip--score .chip-label {
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--color-text-tertiary);
}
.chip--score .chip-val {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
}
.chip--primary {
  background: var(--color-primary);
  color: var(--color-text-on-primary);
  font-weight: 500;
  letter-spacing: 0.01em;
  font-size: 11px;
  padding: 3px var(--sp-3);
}

.row-cta {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--color-text-tertiary);
  transition: color var(--dur-fast) var(--ease),
              transform var(--dur-fast) var(--ease);
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: 1fr;
  }
  .row-right {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}
</style>
