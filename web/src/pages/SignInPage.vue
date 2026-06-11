<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const username = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  submitting.value = true
  try {
    await auth.login(username.value.trim(), password.value)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : null
    router.push(redirect || { name: 'dossiers' })
  } catch (err) {
    error.value = err.message || 'Sign in failed'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="signin-page">
    <div class="signin-card">
      <header class="signin-head">
        <div class="brand">
          <div class="brand-mark">S</div>
          <div>
            <div class="brand-name">Sentinel</div>
            <div class="brand-sub">UK company due diligence</div>
          </div>
        </div>
        <p class="lede">Sign in to compile, review, and sign off on KYC dossiers.</p>
      </header>

      <form class="form" @submit.prevent="submit">
        <label class="field">
          <span class="t-label">Username</span>
          <input
            v-model="username"
            type="text"
            placeholder="analyst"
            autocomplete="username"
            required
            :disabled="submitting"
          />
        </label>

        <label class="field">
          <div class="field-head">
            <span class="t-label">Password</span>
          </div>
          <input
            v-model="password"
            type="password"
            placeholder="••••••••"
            autocomplete="current-password"
            required
            :disabled="submitting"
          />
        </label>

        <p v-if="error" class="signin-error" role="alert">{{ error }}</p>

        <button type="submit" class="btn btn--primary signin-btn" :disabled="submitting">
          <span v-if="submitting" class="spinner spinner--sm spinner--on-primary" aria-hidden="true"></span>
          {{ submitting ? 'Signing in' : 'Sign in' }}
        </button>
      </form>

      <footer class="signin-foot">
        <p class="t-label">Audit-grade · Built for compliance teams</p>
        <p class="signin-foot-meta">Data sourced via Companies House API and verified registers.</p>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.signin-page {
  min-height: 100vh;
  background: var(--color-page);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-6);
}
.signin-card {
  width: 100%;
  max-width: 440px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sheet);
  padding: var(--sp-8);
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.signin-head {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.brand-mark {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  background: var(--color-primary);
  color: var(--color-text-on-primary);
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.brand-name {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}
.brand-sub {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  margin-top: 2px;
}
.lede {
  margin: var(--sp-2) 0 0;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.field-link {
  font-size: var(--fs-meta);
  color: var(--color-primary);
}
input {
  width: 100%;
  height: 40px;
  padding: 0 var(--sp-3);
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
input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
input:disabled {
  background: var(--color-surface-sunken);
}

.signin-error {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--color-danger, #c0392b);
}

.signin-btn {
  width: 100%;
  margin-top: var(--sp-2);
}

.divider {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--color-border);
}
.divider span {
  padding: 0 var(--sp-3);
  font-size: var(--fs-label);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}

.sso {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.sso-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: 40px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease);
}
.sso-btn:hover {
  background: var(--color-page);
  color: var(--color-text-primary);
}
.sso-glyph {
  font-family: var(--font-mono);
  color: var(--color-text-tertiary);
}

.signin-foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  text-align: center;
}
.signin-foot-meta {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-tertiary);
}
</style>
