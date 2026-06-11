<script setup>
// Social-profile-style identity card for the party detail page.
//
// One component, two faces:
//   * individual  — monogram avatar, full name breakdown, DOB + calculated
//                   age, nationality + country of residence (with flags)
//   * organisation — building avatar, registration number + country (flag)
//
// An `#aside` slot carries page-owned controls (stats, watchlist button) into
// the top-right so this component stays presentation-only.

import { computed } from 'vue'
import CountryFlag from './CountryFlag.vue'
import { nationalityIso2, countryIso2, calcAge, formatDob } from '../lib/countries.js'

const props = defineProps({
  party: { type: Object, required: true },
})

const isOrg = computed(() => props.party?.partyType === 'organisation')

const displayName = computed(() => props.party?.fullName || '—')

const initials = computed(() => {
  const p = props.party || {}
  const fore = (p.forename || '').trim()
  const sur = (p.surname || '').trim()
  if (fore || sur) {
    return ((fore[0] || '') + (sur[0] || '')).toUpperCase() || '?'
  }
  const words = String(p.fullName || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
})

const typeLabel = computed(() => (isOrg.value ? 'Organisation' : 'Individual'))

// Primary identifier shown in the subline: entity/registration for orgs,
// the CH appointment id for individuals.
const primaryId = computed(() => {
  const p = props.party || {}
  if (isOrg.value) {
    if (p.registrationNumber) return p.registrationNumber
    return null
  }
  if (p.chOfficerAppointmentId) return `CH appt ${p.chOfficerAppointmentId}`
  return null
})

// ── Individual attributes ────────────────────────────────────────────────
const dob = computed(() => formatDob(props.party?.dateOfBirthYear, props.party?.dateOfBirthMonth))
const age = computed(() => calcAge(props.party?.dateOfBirthYear, props.party?.dateOfBirthMonth))
const dobValue = computed(() => {
  if (!dob.value) return null
  return age.value != null ? `${dob.value} · ${age.value} yrs` : dob.value
})

const nationalities = computed(() => {
  const raw = props.party?.nationality
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list.filter(Boolean).map((n) => ({ label: n, code: nationalityIso2(n) }))
})

const residence = computed(() => {
  const c = props.party?.countryOfResidence
  if (!c) return null
  return { label: c, code: countryIso2(c) }
})

// ── Organisation attributes ──────────────────────────────────────────────
const regCountry = computed(() => {
  const c = props.party?.registrationCountry
  if (!c) return null
  return { label: c, code: countryIso2(c) }
})

const nameParts = computed(() => {
  const p = props.party || {}
  return [
    { label: 'Title', value: p.title },
    { label: 'Given name', value: p.forename },
    { label: 'Middle name(s)', value: p.middleNames },
    { label: 'Family name', value: p.surname },
  ].filter((x) => x.value)
})
</script>

<template>
  <article :class="['id-card', isOrg ? 'id-card--org' : 'id-card--person']">
    <div class="cover" />

    <div class="card-body">
      <div class="top-row">
        <div class="avatar" :title="typeLabel">
          <span v-if="isOrg" class="material-symbols-outlined avatar-icon">apartment</span>
          <span v-else class="avatar-initials">{{ initials }}</span>
        </div>
        <div class="aside">
          <slot name="aside" />
        </div>
      </div>

      <div class="headline">
        <span class="kicker">{{ typeLabel }}</span>
        <h1 class="name">{{ displayName }}</h1>
        <div class="subline">
          <span :class="['type-chip', isOrg ? 'type-chip--org' : 'type-chip--person']">
            <span class="material-symbols-outlined icon-xs">{{ isOrg ? 'corporate_fare' : 'person' }}</span>
            {{ typeLabel }}
          </span>
          <span v-if="primaryId" class="primary-id t-mono">{{ primaryId }}</span>
        </div>
      </div>

      <!-- Individual identity -->
      <dl v-if="!isOrg" class="attrs">
        <div v-for="np in nameParts" :key="np.label" class="attr">
          <span class="material-symbols-outlined attr-icon">badge</span>
          <div class="attr-body">
            <dt class="attr-label">{{ np.label }}</dt>
            <dd class="attr-value">{{ np.value }}</dd>
          </div>
        </div>

        <div class="attr">
          <span class="material-symbols-outlined attr-icon">cake</span>
          <div class="attr-body">
            <dt class="attr-label">Date of birth</dt>
            <dd class="attr-value">{{ dobValue || 'Not recorded' }}</dd>
          </div>
        </div>

        <div class="attr">
          <span class="material-symbols-outlined attr-icon">flag</span>
          <div class="attr-body">
            <dt class="attr-label">Nationality</dt>
            <dd class="attr-value">
              <template v-if="nationalities.length">
                <span class="flag-chips">
                  <CountryFlag
                    v-for="n in nationalities"
                    :key="n.label"
                    :code="n.code"
                    :label="n.label"
                  />
                </span>
              </template>
              <span v-else class="muted">Not recorded</span>
            </dd>
          </div>
        </div>

        <div class="attr">
          <span class="material-symbols-outlined attr-icon">home_pin</span>
          <div class="attr-body">
            <dt class="attr-label">Country of residence</dt>
            <dd class="attr-value">
              <CountryFlag v-if="residence" :code="residence.code" :label="residence.label" />
              <span v-else class="muted">Not recorded</span>
            </dd>
          </div>
        </div>
      </dl>

      <!-- Organisation identity -->
      <dl v-else class="attrs">
        <div class="attr attr--wide">
          <span class="material-symbols-outlined attr-icon">tag</span>
          <div class="attr-body">
            <dt class="attr-label">Registration number</dt>
            <dd class="attr-value t-mono">{{ party.registrationNumber || 'Not recorded' }}</dd>
          </div>
        </div>

        <div class="attr">
          <span class="material-symbols-outlined attr-icon">public</span>
          <div class="attr-body">
            <dt class="attr-label">Registration country</dt>
            <dd class="attr-value">
              <CountryFlag v-if="regCountry" :code="regCountry.code" :label="regCountry.label" />
              <span v-else class="muted">Not recorded</span>
            </dd>
          </div>
        </div>
      </dl>
    </div>
  </article>
</template>

<style scoped>
.id-card {
  position: relative;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e4e4dc);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow-sheet, 0 1px 2px rgba(16, 20, 24, 0.06));
}

/* Social-profile cover banner — a subtle gradient that differs by type. */
.cover {
  height: 84px;
  background: linear-gradient(120deg, #0b3d91 0%, #2563eb 60%, #3b82f6 100%);
}
.id-card--org .cover {
  background: linear-gradient(120deg, #7c3a09 0%, #b45309 55%, #d97706 100%);
}

.card-body {
  padding: 0 var(--sp-6, 24px) var(--sp-6, 24px);
}

.top-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4, 16px);
}

/* Avatar overlaps the cover, profile-style. */
.avatar {
  width: 92px;
  height: 92px;
  margin-top: -46px;
  border-radius: 50%;
  background: var(--color-surface, #fff);
  border: 4px solid var(--color-surface, #fff);
  box-shadow: 0 2px 8px rgba(16, 20, 24, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}
.avatar-initials {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  background: linear-gradient(135deg, #1d4ed8, #3b82f6);
}
.id-card--org .avatar-icon {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 42px;
  color: #fff;
  background: linear-gradient(135deg, #b45309, #d97706);
}

.aside {
  padding-top: var(--sp-3, 12px);
  display: flex;
  align-items: flex-start;
}

.headline {
  margin-top: var(--sp-2, 8px);
}
.kicker {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-tertiary, #737a82);
}
.name {
  margin: 2px 0 var(--sp-2, 8px);
  font-size: 1.9rem;
  line-height: 1.15;
  font-weight: 700;
  color: var(--color-text-primary, #101418);
}
.subline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2, 8px) var(--sp-3, 12px);
}
.type-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
}
.type-chip--person { background: #e0e7ff; color: #3730a3; }
.type-chip--org { background: #fef3c7; color: #92400e; }
.primary-id {
  font-size: 0.82rem;
  color: var(--color-text-secondary, #475569);
}

/* Attribute grid */
.attrs {
  margin: var(--sp-5, 20px) 0 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sp-4, 16px) var(--sp-6, 24px);
  border-top: 1px solid var(--color-border, #eee);
  padding-top: var(--sp-5, 20px);
}
.attr {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3, 12px);
  min-width: 0;
}
.attr--wide { grid-column: 1 / -1; }
.attr-icon {
  font-size: 20px;
  color: var(--color-text-tertiary, #737a82);
  margin-top: 2px;
  flex-shrink: 0;
}
.attr-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.attr-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary, #737a82);
}
.attr-value {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--color-text-primary, #101418);
  word-break: break-word;
}
.attr-value.t-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.85rem; }
.muted { color: var(--color-text-tertiary, #999); font-weight: 400; }
.flag-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--sp-2, 8px) var(--sp-4, 16px);
}
.icon-xs { font-size: 15px; }
</style>
