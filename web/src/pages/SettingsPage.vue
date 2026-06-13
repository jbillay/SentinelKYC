<script setup>
import { ref, onMounted, watch } from 'vue'
import { useAuthStore } from '../stores/auth.js'

// Settings is now profile-only. Admin configuration (agents, screening, risk
// matrix, prompts, data model, process, members) lives in the admin-gated
// /admin section.
const auth = useAuthStore()

const profileForm = ref({ displayName: '', username: '', email: '' })
const profileSaving = ref(false)
const profileError = ref('')
const profileStatus = ref('')

const pwForm = ref({ currentPassword: '', newPassword: '', confirmPassword: '' })
const pwSaving = ref(false)
const pwError = ref('')
const pwStatus = ref('')

function syncProfileForm() {
  profileForm.value = {
    displayName: auth.displayName || '',
    username: auth.username || '',
    email: auth.email || '',
  }
}

onMounted(syncProfileForm)
watch(() => auth.user, syncProfileForm)

async function onSaveProfile() {
  profileError.value = ''
  profileStatus.value = ''
  profileSaving.value = true
  try {
    await auth.updateProfile({
      displayName: profileForm.value.displayName.trim(),
      username: profileForm.value.username.trim(),
      email: profileForm.value.email.trim(),
    })
    profileStatus.value = 'Profile updated.'
  } catch (err) {
    profileError.value = err.message || 'Update failed'
  } finally {
    profileSaving.value = false
  }
}

async function onChangePassword() {
  pwError.value = ''
  pwStatus.value = ''
  if (pwForm.value.newPassword !== pwForm.value.confirmPassword) {
    pwError.value = 'New passwords do not match'
    return
  }
  if (pwForm.value.newPassword.length < 8) {
    pwError.value = 'New password must be at least 8 characters'
    return
  }
  pwSaving.value = true
  try {
    await auth.changePassword({
      currentPassword: pwForm.value.currentPassword,
      newPassword: pwForm.value.newPassword,
    })
    pwStatus.value = 'Password changed.'
    pwForm.value = { currentPassword: '', newPassword: '', confirmPassword: '' }
  } catch (err) {
    pwError.value = err.message || 'Could not change password'
  } finally {
    pwSaving.value = false
  }
}
</script>

<template>
  <div class="settings">
    <header class="page-head">
      <div>
        <h1 class="t-headline">Settings</h1>
        <p class="t-meta page-sub">Your profile and password.</p>
      </div>
    </header>

    <section id="account" class="sheet">
      <h2 class="sheet-title">Profile</h2>
      <p class="sheet-sub">Update your name, sign-in username, and contact email.</p>
      <form class="fields" @submit.prevent="onSaveProfile">
        <label class="field">
          <span class="t-label">Display name</span>
          <input v-model="profileForm.displayName" type="text" maxlength="80" placeholder="Your name" />
        </label>
        <label class="field">
          <span class="t-label">Username</span>
          <input v-model="profileForm.username" type="text" autocomplete="username" placeholder="username" />
          <span class="field-hint">3–32 characters: letters, digits, and . _ -</span>
        </label>
        <label class="field">
          <span class="t-label">Email</span>
          <input v-model="profileForm.email" type="email" autocomplete="email" placeholder="you@firm.co.uk" />
        </label>

        <p v-if="profileError" class="form-msg form-msg--error" role="alert">{{ profileError }}</p>
        <p v-else-if="profileStatus" class="form-msg form-msg--ok">{{ profileStatus }}</p>

        <div class="form-actions">
          <button type="submit" class="btn btn--primary" :disabled="profileSaving">
            {{ profileSaving ? 'Saving…' : 'Save profile' }}
          </button>
        </div>
      </form>

      <div class="divider" />

      <h2 class="sheet-title">Password</h2>
      <p class="sheet-sub">Choose a strong password of at least 8 characters.</p>
      <form class="fields" @submit.prevent="onChangePassword">
        <label class="field">
          <span class="t-label">Current password</span>
          <input v-model="pwForm.currentPassword" type="password" autocomplete="current-password" />
        </label>
        <label class="field">
          <span class="t-label">New password</span>
          <input v-model="pwForm.newPassword" type="password" autocomplete="new-password" />
        </label>
        <label class="field">
          <span class="t-label">Confirm new password</span>
          <input v-model="pwForm.confirmPassword" type="password" autocomplete="new-password" />
        </label>

        <p v-if="pwError" class="form-msg form-msg--error" role="alert">{{ pwError }}</p>
        <p v-else-if="pwStatus" class="form-msg form-msg--ok">{{ pwStatus }}</p>

        <div class="form-actions">
          <button type="submit" class="btn btn--primary" :disabled="pwSaving">
            {{ pwSaving ? 'Updating…' : 'Change password' }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.page-head h1 { margin: 0; }
.page-sub { margin: var(--sp-1) 0 0; }

.sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-8);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
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
input[type='email'],
input[type='password'] {
  height: 38px;
  padding: 0 var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font: inherit;
}
input[type='text']:focus,
input[type='email']:focus,
input[type='password']:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}

.field-hint {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
}
.form-actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-start;
}
.form-msg {
  grid-column: 1 / -1;
  margin: 0;
  font-size: var(--fs-meta);
}
.form-msg--error {
  color: var(--color-danger, #c0392b);
}
.form-msg--ok {
  color: var(--color-success, #1f8a4c);
}

.divider {
  height: 1px;
  background: var(--color-border);
  margin: var(--sp-2) 0;
}
</style>
