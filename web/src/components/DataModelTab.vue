<script setup>
// Settings → "Data model" tab. Read-only introspection of the agent's data
// surface, served by GET /api/meta/data-model.
//
// Three collapsible sub-sections:
//   1. State schema   — Zod → JSON Schema for the graph state object
//   2. Fragments per node — observed input/output keys from decision_fragments
//   3. Persisted entity   — Drizzle tables grouped by domain
//
// Every section has a "Copy as JSON" button. Nothing here writes.
import { computed, onMounted, ref } from 'vue'

const loading = ref(false)
const error = ref(null)
const data = ref(null)

const collapsed = ref({ state: false, fragments: false, persisted: false })
const sampleOpen = ref({})

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/api/meta/data-model')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    data.value = await res.json()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)

const copied = ref(null)
async function copy(label, payload) {
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    await navigator.clipboard.writeText(text)
    copied.value = label
    setTimeout(() => {
      if (copied.value === label) copied.value = null
    }, 1500)
  } catch {
    /* noop */
  }
}

// ---- helpers for JSON Schema rendering ----

function describeType(schema) {
  if (!schema || typeof schema !== 'object') return '?'
  if (schema.$ref) return schema.$ref.replace('#/definitions/', '')
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const variants = (schema.anyOf || schema.oneOf).map(describeType)
    return variants.join(' | ')
  }
  if (schema.enum) return `enum(${schema.enum.join(' | ')})`
  if (schema.type === 'array') return `array<${describeType(schema.items || {})}>`
  if (schema.type === 'object') return 'object'
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  return schema.type || 'any'
}

function isExpandable(schema) {
  if (!schema) return false
  if (schema.type === 'object' && schema.properties) return true
  if (schema.type === 'array' && schema.items?.type === 'object' && schema.items.properties) return true
  return false
}

function childFields(schema) {
  if (!schema) return []
  let props
  if (schema.type === 'object' && schema.properties) props = schema.properties
  else if (schema.type === 'array' && schema.items?.properties) props = schema.items.properties
  if (!props) return []
  return Object.entries(props).map(([name, def]) => ({ name, schema: def }))
}

// ---- fragments grouping ----
const NODE_CLASSIFICATION_LABEL = {
  decision: 'Decision',
  audit: 'Audit',
  human_action: 'Human action',
  interrupt: 'Interrupt',
  sentinel: 'Sentinel',
}

const fragmentGroups = computed(() => {
  if (!data.value?.fragmentsByNode) return []
  const groups = new Map()
  for (const row of data.value.fragmentsByNode) {
    const cls = row.classification || 'audit'
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls).push(row)
  }
  // Sort the groups in a stable, helpful order.
  const order = ['decision', 'audit', 'human_action', 'interrupt', 'sentinel']
  return order
    .filter((c) => groups.has(c))
    .map((c) => ({
      classification: c,
      label: NODE_CLASSIFICATION_LABEL[c] || c,
      nodes: groups.get(c).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    }))
})

function fmtDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleString()
}

function toggleSample(nodeId) {
  sampleOpen.value[nodeId] = !sampleOpen.value[nodeId]
}
</script>

<template>
  <section class="sheet">
    <div class="sheet-head-row">
      <div>
        <h2 class="sheet-title">Data model</h2>
        <p class="sheet-sub">
          Live view of the agent's data surface: the in-memory state schema, the I/O keys
          actually written by each node (sampled from recent decision fragments), and the
          persisted Drizzle tables. Reload to pull the current shape.
        </p>
      </div>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">
        <span class="material-symbols-outlined icon-sm">refresh</span>
        Reload
      </button>
    </div>

    <div v-if="error" class="prompt-error">{{ error }}</div>

    <!-- ── 1. State schema ───────────────────────────────────────────── -->
    <div class="dm-section">
      <div class="dm-section-head">
        <button
          type="button"
          class="dm-section-toggle"
          :aria-expanded="!collapsed.state"
          @click="collapsed.state = !collapsed.state"
        >
          <span class="material-symbols-outlined icon-sm dm-chevron" :class="{ 'dm-chevron--open': !collapsed.state }">
            chevron_right
          </span>
          <span class="dm-section-title">State schema</span>
          <span class="t-meta">— Zod schema in <code class="t-mono">server/graph/state.js</code></span>
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--xs"
          :class="{ 'btn--success': copied === 'state' }"
          @click="copy('state', data?.state?.jsonSchema)"
        >
          {{ copied === 'state' ? 'Copied' : 'Copy as JSON' }}
        </button>
      </div>

      <div v-if="!collapsed.state" class="dm-section-body">
        <p v-if="loading && !data" class="t-meta">Loading…</p>
        <ul v-else-if="data" class="dm-tree">
          <li v-for="f in data.state.fields" :key="f.name" class="dm-row">
            <details class="dm-details" :open="false">
              <summary>
                <span class="dm-key">{{ f.name }}</span>
                <span class="dm-type t-mono">{{ describeType(f.schema) }}</span>
                <span v-if="f.producedBy" class="dm-producer">
                  ← <span class="t-mono">{{ f.producedBy }}</span>
                </span>
              </summary>
              <ul v-if="isExpandable(f.schema)" class="dm-tree dm-tree--nested">
                <li v-for="c in childFields(f.schema)" :key="c.name" class="dm-row">
                  <details class="dm-details" :open="false">
                    <summary>
                      <span class="dm-key">{{ c.name }}</span>
                      <span class="dm-type t-mono">{{ describeType(c.schema) }}</span>
                    </summary>
                    <ul v-if="isExpandable(c.schema)" class="dm-tree dm-tree--nested">
                      <li v-for="d in childFields(c.schema)" :key="d.name" class="dm-row">
                        <span class="dm-key">{{ d.name }}</span>
                        <span class="dm-type t-mono">{{ describeType(d.schema) }}</span>
                      </li>
                    </ul>
                    <pre v-else class="dm-leaf-json t-mono">{{ JSON.stringify(c.schema, null, 2) }}</pre>
                  </details>
                </li>
              </ul>
              <pre v-else class="dm-leaf-json t-mono">{{ JSON.stringify(f.schema, null, 2) }}</pre>
            </details>
          </li>
        </ul>
      </div>
    </div>

    <!-- ── 2. Fragments per node ─────────────────────────────────────── -->
    <div class="dm-section">
      <div class="dm-section-head">
        <button
          type="button"
          class="dm-section-toggle"
          :aria-expanded="!collapsed.fragments"
          @click="collapsed.fragments = !collapsed.fragments"
        >
          <span class="material-symbols-outlined icon-sm dm-chevron" :class="{ 'dm-chevron--open': !collapsed.fragments }">
            chevron_right
          </span>
          <span class="dm-section-title">Fragments per node</span>
          <span class="t-meta">— observed input / output keys from the last 50 runs of each node</span>
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--xs"
          :class="{ 'btn--success': copied === 'fragments' }"
          @click="copy('fragments', data?.fragmentsByNode)"
        >
          {{ copied === 'fragments' ? 'Copied' : 'Copy as JSON' }}
        </button>
      </div>

      <div v-if="!collapsed.fragments" class="dm-section-body">
        <p v-if="loading && !data" class="t-meta">Loading…</p>
        <p v-else-if="data && !data.fragmentsByNode.length" class="t-meta">
          No fragments captured yet — run a dossier to populate this view.
        </p>
        <div v-else-if="data" class="dm-fragment-groups">
          <div v-for="group in fragmentGroups" :key="group.classification" class="dm-fragment-group">
            <h3 class="dm-fragment-group-title">
              <span :class="['dm-class-pill', `dm-class-pill--${group.classification}`]">{{ group.label }}</span>
              <span class="t-meta">· {{ group.nodes.length }} nodes</span>
            </h3>
            <table class="dm-table">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Input keys</th>
                  <th>Output keys</th>
                  <th>Runs</th>
                  <th>Last seen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <template v-for="node in group.nodes" :key="node.nodeId">
                  <tr>
                    <td class="t-mono">{{ node.nodeId }}</td>
                    <td>
                      <span v-if="!node.observedInputKeys.length" class="t-meta">—</span>
                      <code v-for="k in node.observedInputKeys" :key="k" class="dm-chip t-mono">{{ k }}</code>
                    </td>
                    <td>
                      <span v-if="!node.observedOutputKeys.length" class="t-meta">—</span>
                      <code v-for="k in node.observedOutputKeys" :key="k" class="dm-chip t-mono">{{ k }}</code>
                    </td>
                    <td class="tabular">{{ node.occurrences }}</td>
                    <td class="t-meta tabular">{{ fmtDate(node.lastSeenAt) }}</td>
                    <td>
                      <button type="button" class="btn btn--ghost btn--xs" @click="toggleSample(node.nodeId)">
                        {{ sampleOpen[node.nodeId] ? 'Hide sample' : 'View sample' }}
                      </button>
                    </td>
                  </tr>
                  <tr v-if="sampleOpen[node.nodeId]" class="dm-sample-row">
                    <td colspan="6">
                      <div class="dm-sample">
                        <div class="dm-sample-meta">
                          <span class="t-label">Sample fragment</span>
                          <code class="t-mono">{{ node.sample.fragmentId }}</code>
                          <span class="t-meta">{{ node.sample.summary }}</span>
                        </div>
                        <div class="dm-sample-cols">
                          <div>
                            <span class="t-label">Inputs</span>
                            <pre class="dm-leaf-json t-mono">{{ JSON.stringify(node.sample.inputs, null, 2) }}</pre>
                          </div>
                          <div>
                            <span class="t-label">Outputs</span>
                            <pre class="dm-leaf-json t-mono">{{ JSON.stringify(node.sample.outputs, null, 2) }}</pre>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 3. Persisted entity ──────────────────────────────────────── -->
    <div class="dm-section">
      <div class="dm-section-head">
        <button
          type="button"
          class="dm-section-toggle"
          :aria-expanded="!collapsed.persisted"
          @click="collapsed.persisted = !collapsed.persisted"
        >
          <span class="material-symbols-outlined icon-sm dm-chevron" :class="{ 'dm-chevron--open': !collapsed.persisted }">
            chevron_right
          </span>
          <span class="dm-section-title">Persisted entity</span>
          <span class="t-meta">— Drizzle tables in <code class="t-mono">server/db/schema.js</code></span>
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--xs"
          :class="{ 'btn--success': copied === 'persisted' }"
          @click="copy('persisted', data?.persisted)"
        >
          {{ copied === 'persisted' ? 'Copied' : 'Copy as JSON' }}
        </button>
      </div>

      <div v-if="!collapsed.persisted" class="dm-section-body">
        <p v-if="loading && !data" class="t-meta">Loading…</p>
        <div v-else-if="data" class="dm-persisted-groups">
          <div v-for="group in data.persisted" :key="group.label" class="dm-persisted-group">
            <h3 class="dm-persisted-group-title">{{ group.label }}</h3>
            <div v-for="table in group.tables" :key="table.tableName" class="dm-persisted-table">
              <div class="dm-persisted-head">
                <code class="t-mono dm-table-name">{{ table.tableName }}</code>
                <span v-if="table.foreignKeys.length" class="t-meta">
                  · {{ table.foreignKeys.length }} FK{{ table.foreignKeys.length > 1 ? 's' : '' }}
                </span>
              </div>
              <table class="dm-table">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Constraints</th>
                    <th>Produced by</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="col in table.columns" :key="col.name">
                    <td class="t-mono">{{ col.name }}</td>
                    <td class="t-mono t-meta">{{ col.type }}</td>
                    <td class="t-mono t-meta">
                      <span v-if="col.primary" class="dm-constraint">PK</span>
                      <span v-if="col.notNull && !col.primary" class="dm-constraint">NOT NULL</span>
                    </td>
                    <td class="t-meta">{{ col.producedBy || '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <ul v-if="table.foreignKeys.length" class="dm-fk-list">
                <li v-for="fk in table.foreignKeys" :key="fk.name" class="t-meta">
                  <code class="t-mono">({{ fk.columns.join(', ') }})</code>
                  → <code class="t-mono">{{ fk.foreignTable }}({{ fk.foreignColumns.join(', ') }})</code>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
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
  gap: var(--sp-5);
}
.sheet-title { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 600; color: var(--color-text-primary); }
.sheet-sub { margin: -8px 0 var(--sp-2); color: var(--color-text-secondary); font-size: var(--fs-meta); }
.sheet-head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); }

.prompt-error {
  padding: var(--sp-3);
  background: rgba(220, 53, 69, 0.08);
  border: 1px solid rgba(220, 53, 69, 0.25);
  border-radius: var(--radius-md);
  color: var(--color-danger, #b00020);
  font-size: var(--fs-meta);
}

.dm-section {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-page);
  overflow: hidden;
}
.dm-section-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-3) var(--sp-4);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
}
.dm-section-head:hover { background: var(--color-primary-soft); }
.dm-section-toggle {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex: 1;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  font-size: var(--fs-body);
  color: inherit;
}
.dm-section-title { font-weight: 600; color: var(--color-text-primary); }
.dm-chevron { transition: transform var(--dur-fast) var(--ease); color: var(--color-text-secondary); }
.dm-chevron--open { transform: rotate(90deg); }
.dm-section-body { padding: var(--sp-4) var(--sp-5); }

.btn--xs { padding: 3px var(--sp-2); font-size: 11px; border-radius: var(--radius-sm); }
.btn--success { background: var(--color-success-soft); color: var(--color-success); }

/* State tree */
.dm-tree { list-style: none; margin: 0; padding: 0; }
.dm-tree--nested {
  margin-left: var(--sp-4);
  border-left: 1px dashed var(--color-border);
  padding-left: var(--sp-3);
  margin-top: var(--sp-2);
}
.dm-row { padding: var(--sp-1) 0; }
.dm-details > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  padding: 2px 0;
}
.dm-details > summary::-webkit-details-marker { display: none; }
.dm-details > summary::before {
  content: '▸';
  color: var(--color-text-tertiary);
  font-size: 10px;
  width: 12px;
}
.dm-details[open] > summary::before { content: '▾'; }
.dm-key { color: var(--color-text-primary); font-weight: 500; }
.dm-type { font-size: 12px; color: var(--color-text-secondary); }
.dm-producer { font-size: var(--fs-meta); color: var(--color-text-tertiary); }
.dm-leaf-json {
  margin: var(--sp-2) 0 0 var(--sp-5);
  padding: var(--sp-2) var(--sp-3);
  background: var(--color-page);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-secondary);
  overflow: auto;
  max-height: 200px;
}

/* Fragments table */
.dm-fragment-groups { display: flex; flex-direction: column; gap: var(--sp-5); }
.dm-fragment-group-title {
  margin: 0 0 var(--sp-2);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.dm-class-pill {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
}
.dm-class-pill--decision { background: var(--color-primary-soft); color: var(--color-primary); }
.dm-class-pill--audit { background: var(--color-surface-sunken); color: var(--color-text-secondary); }
.dm-class-pill--human_action { background: var(--color-success-soft); color: var(--color-success); }
.dm-class-pill--interrupt { background: var(--color-tertiary-soft, #FBF1E1); color: var(--color-tertiary, #B45309); }
.dm-class-pill--sentinel { background: var(--color-surface-sunken); color: var(--color-text-tertiary); }

.dm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-meta);
}
.dm-table th,
.dm-table td {
  text-align: left;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}
.dm-table th {
  font-weight: 500;
  color: var(--color-text-tertiary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.dm-chip {
  display: inline-block;
  padding: 1px 6px;
  margin: 1px 4px 1px 0;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--color-text-secondary);
}
.dm-sample-row { background: var(--color-page); }
.dm-sample {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
}
.dm-sample-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.dm-sample-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}

/* Persisted */
.dm-persisted-groups { display: flex; flex-direction: column; gap: var(--sp-6); }
.dm-persisted-group-title {
  margin: 0 0 var(--sp-3);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
}
.dm-persisted-table {
  margin-bottom: var(--sp-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  padding: var(--sp-3);
}
.dm-persisted-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--color-border);
  margin-bottom: var(--sp-2);
}
.dm-table-name { color: var(--color-primary); font-weight: 600; font-size: 13px; }
.dm-constraint {
  display: inline-block;
  padding: 1px 4px;
  margin-right: 4px;
  background: var(--color-surface-sunken);
  border-radius: 2px;
  font-size: 10px;
  color: var(--color-text-tertiary);
}
.dm-fk-list {
  list-style: none;
  margin: var(--sp-2) 0 0;
  padding: 0;
  font-size: var(--fs-meta);
}
.dm-fk-list li { padding: 2px 0; }
</style>
