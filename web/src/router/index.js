import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'

import AppShell from '../layouts/AppShell.vue'
import SignInPage from '../pages/SignInPage.vue'
import DossiersPage from '../pages/DossiersPage.vue'
import SearchPage from '../pages/SearchPage.vue'
import RunPage from '../pages/RunPage.vue'
import DossierViewPage from '../pages/DossierViewPage.vue'
import RunDetailPage from '../pages/RunDetailPage.vue'
import RunDiffPage from '../pages/RunDiffPage.vue'
import GraphPage from '../pages/GraphPage.vue'
import WatchlistPage from '../pages/WatchlistPage.vue'
import AuditLogPage from '../pages/AuditLogPage.vue'
import SettingsPage from '../pages/SettingsPage.vue'
import AdminPage from '../pages/AdminPage.vue'
import PartyDetailPage from '../pages/PartyDetailPage.vue'
import PartiesPage from '../pages/PartiesPage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/signin', name: 'signin', component: SignInPage },

    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', redirect: { name: 'dossiers' } },
        { path: 'dossiers', name: 'dossiers', component: DossiersPage, meta: { breadcrumb: 'Dossiers' } },
        { path: 'search', name: 'search', component: SearchPage, meta: { breadcrumb: 'New search' } },
        { path: 'run/:threadId', name: 'run', component: RunPage, props: true, meta: { breadcrumb: 'Agent run' } },
        { path: 'dossier/current', name: 'dossier-current', component: DossierViewPage, meta: { breadcrumb: 'KYC dossier' } },
        { path: 'dossier/:companyNumber', name: 'dossier', component: DossierViewPage, props: true, meta: { breadcrumb: 'KYC dossier' } },
        { path: 'dossier/:companyNumber/run/:runId', name: 'run-detail', component: RunDetailPage, props: true, meta: { breadcrumb: 'Run detail' } },
        { path: 'dossier/:companyNumber/run/:runId/diff/:otherRunId', name: 'run-diff', component: RunDiffPage, props: true, meta: { breadcrumb: 'Run diff' } },
        { path: 'graph/current', name: 'graph-current', component: GraphPage, meta: { breadcrumb: 'Entity graph' } },
        { path: 'dossier/:companyNumber/graph', name: 'graph', component: GraphPage, props: true, meta: { breadcrumb: 'Entity graph' } },
        { path: 'watchlist', name: 'watchlist', component: WatchlistPage, meta: { breadcrumb: 'Watchlist' } },
        { path: 'parties', name: 'parties', component: PartiesPage, meta: { breadcrumb: 'Parties' } },
        { path: 'party/:partyId', name: 'party-detail', component: PartyDetailPage, props: true, meta: { breadcrumb: 'Party' } },
        { path: 'audit', name: 'audit', component: AuditLogPage, meta: { breadcrumb: 'Audit log' } },
        { path: 'settings', name: 'settings', component: SettingsPage, meta: { breadcrumb: 'Settings' } },
        { path: 'admin', name: 'admin', component: AdminPage, meta: { breadcrumb: 'Admin', requiresAdmin: true } },
      ],
    },
  ],
  scrollBehavior() {
    return { top: 0 }
  },
})

// Auth gate: resolve the session once (GET /api/auth/me), then redirect
// unauthenticated users to /signin and bounce authenticated users away from it.
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.ready) await auth.fetchMe()

  if (to.name !== 'signin' && !auth.isAuthenticated) {
    return { name: 'signin', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
  }
  if (to.name === 'signin' && auth.isAuthenticated) {
    return { name: 'dossiers' }
  }
  // Admin-only section: bounce non-admins back to their dossiers.
  if (to.meta?.requiresAdmin && !auth.hasRole('admin')) {
    return { name: 'dossiers' }
  }
  return true
})

export default router
