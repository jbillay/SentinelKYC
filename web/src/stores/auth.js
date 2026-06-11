// R1 — auth store. Holds the current user, drives login/logout, and exposes
// role helpers. All fetches go through the wrapped window.fetch (lib/api.js),
// so credentials + CSRF are handled transparently.
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { resetCsrf } from '../lib/api.js'

const ROLE_RANK = { analyst: 1, reviewer: 2, admin: 3 }

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const ready = ref(false) // becomes true once we've checked /me at least once

  const isAuthenticated = computed(() => !!user.value)
  const role = computed(() => user.value?.role || null)
  const username = computed(() => user.value?.username || null)
  const displayName = computed(() => user.value?.displayName || null)
  const email = computed(() => user.value?.email || null)

  // Hierarchy-aware: hasRole('reviewer') is true for reviewer AND admin.
  function hasRole(min) {
    return (ROLE_RANK[role.value] || 0) >= (ROLE_RANK[min] || 99)
  }

  async function fetchMe() {
    try {
      const res = await fetch('/api/auth/me')
      user.value = res.ok ? (await res.json()).user : null
    } catch {
      user.value = null
    } finally {
      ready.value = true
    }
    return user.value
  }

  async function login(usernameInput, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameInput, password }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      const msg =
        j.error === 'invalid_credentials'
          ? 'Invalid username or password'
          : j.error === 'too_many_attempts'
            ? 'Too many attempts — try again later'
            : j.error || 'Sign in failed'
      throw new Error(msg)
    }
    resetCsrf() // session regenerated → old CSRF token is invalid
    user.value = (await res.json()).user
    return user.value
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      /* best-effort */
    }
    user.value = null
    resetCsrf()
  }

  // Self-service profile update (display name / username / email). Throws with a
  // friendly message on validation / conflict failures.
  async function updateProfile(patch) {
    const res = await fetch('/api/auth/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      const msg =
        j.error === 'conflict'
          ? `That ${j.field || 'value'} is already taken`
          : j.error === 'invalid_username'
            ? j.detail || 'Invalid username'
            : j.error === 'invalid_email'
              ? 'Enter a valid email address'
              : j.error === 'invalid_display_name'
                ? 'Display name must be 1–80 characters'
                : j.error || 'Update failed'
      throw new Error(msg)
    }
    user.value = (await res.json()).user
    return user.value
  }

  async function changePassword({ currentPassword, newPassword }) {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      const msg =
        j.error === 'wrong_current_password'
          ? 'Current password is incorrect'
          : j.error === 'weak_password'
            ? j.detail || 'Password too short'
            : j.error || 'Could not change password'
      throw new Error(msg)
    }
    return true
  }

  return {
    user,
    ready,
    isAuthenticated,
    role,
    username,
    displayName,
    email,
    hasRole,
    fetchMe,
    login,
    logout,
    updateProfile,
    changePassword,
  }
})
