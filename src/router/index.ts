import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppLayout from '@/components/layout/AppLayout.vue'
import LoginView from '@/views/LoginView.vue'

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: '/',
      redirect: '/login',
    },
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { public: true },
    },
    {
      path: '/doctor',
      component: AppLayout,
      meta: { portal: 'doctor', requiresAuth: true },
      children: [
        { path: 'profile', component: () => import('@/views/ProfileView.vue'), meta: { tabKind: 'profile', titleKey: 'ui.topbar.profile' } },
        {
          path: '',
          redirect: '/doctor/dashboard',
        },
        {
          path: 'dashboard',
          name: 'doctor-dashboard',
          component: () => import('@/views/doctor/DoctorDashboardView.vue'),
          meta: { tabKind: 'dashboard', titleKey: 'ui.sidebar.patientWorkspace' },
        },
        {
          path: 'agent',
          name: 'doctor-agent',
          component: () => import('@/views/doctor/AgentWorkspaceView.vue'),
          meta: { tabKind: 'agent', titleKey: 'ui.agent.workspaceTitle' },
        },
        {
          path: 'admin/users',
          name: 'doctor-admin-users',
          component: () => import('@/views/doctor/AdminUsersView.vue'),
          meta: { requiresAdmin: true, tabKind: 'admin-users', titleKey: 'ui.adminUsers.title' },
        },
        {
          path: 'admin/access',
          name: 'doctor-admin-access',
          component: () => import('@/views/doctor/PatientAccessView.vue'),
          meta: { requiresAdmin: true, tabKind: 'admin-access', titleKey: 'ui.patientAccess.title' },
        },
        {
          path: 'admin/stats',
          name: 'doctor-admin-stats',
          component: () => import('@/views/doctor/AdminStatsView.vue'),
          meta: { requiresAdmin: true, tabKind: 'admin-stats', titleKey: 'ui.adminStats.title' },
        },
        {
          path: 'archived',
          name: 'doctor-archived',
          component: () => import('@/views/doctor/ArchivedPatientsView.vue'),
          meta: { tabKind: 'archived', titleKey: 'ui.archive.title' },
        },
        {
          path: 'patients',
          name: 'doctor-patients',
          redirect: { name: 'doctor-dashboard' },
        },
        {
          path: 'patients/:id',
          component: () => import('@/views/doctor/PatientDetailView.vue'),
          children: [
            {
              path: '',
              name: 'doctor-patient-overview',
              component: () => import('@/views/doctor/PatientOverviewView.vue'),
              meta: { tabKind: 'patient-overview', titleKey: 'ui.sidebar.patientOverview' },
            },
            {
              path: 'overview',
              redirect: { name: 'doctor-patient-overview' },
            },
            {
              path: 'imaging',
              name: 'doctor-patient-imaging',
              component: () => import('@/views/doctor/PatientImagingView.vue'),
              meta: { tabKind: 'patient-imaging', titleKey: 'ui.nav.medicalImaging' },
            },
            {
              path: 'ai',
              name: 'doctor-patient-ai',
              component: () => import('@/views/doctor/PatientAIView.vue'),
              meta: { tabKind: 'patient-ai', titleKey: 'ui.sidebar.aiDiagnosis' },
            },
            {
              path: 'report',
              name: 'doctor-patient-report',
              component: () => import('@/views/doctor/PatientReportView.vue'),
              meta: { tabKind: 'patient-report', titleKey: 'ui.sidebar.clinicalReport' },
            },
            {
              path: '3d',
              name: 'doctor-patient-3d',
              component: () => import('@/views/doctor/Patient3DView.vue'),
              meta: { tabKind: 'patient-3d', titleKey: 'ui.sidebar.organ3d' },
            },
            {
              path: 'anatomy',
              name: 'doctor-patient-anatomy',
              component: () => import('@/views/doctor/AnatomyViewerPage.vue'),
              meta: { tabKind: 'anatomy-viewer', titleKey: 'ui.anatomyViewer.title' },
            },
            {
              path: 'simulation',
              name: 'doctor-patient-simulation',
              component: () => import('@/views/doctor/SurgerySimulation.vue'),
              meta: { tabKind: 'surgery-simulation', titleKey: 'ui.simulation.title' },
            },
            {
              path: 'viewer',
              name: 'doctor-patient-study-viewer',
              redirect: (to) => ({
                name: 'study-viewer',
                params: { patientId: to.params.id },
                query: to.query,
              }),
            },
          ],
        },
      ],
    },
    {
      path: '/viewer/study/:patientId',
      name: 'study-viewer',
      component: () => import('@/views/viewer/StudyViewerWindow.vue'),
      meta: { portal: 'doctor', requiresAuth: true, tabKind: 'study-viewer', titleKey: 'ui.viewer3d.title' },
    },
    {
      path: '/patient',
      component: AppLayout,
      meta: { portal: 'patient', requiresAuth: true },
      children: [
        { path: 'profile', component: () => import('@/views/ProfileView.vue'), meta: { tabKind: 'profile', titleKey: 'ui.topbar.profile' } },
        {
          path: 'onboarding',
          name: 'patient-onboarding',
          component: () => import('@/views/patient/PatientOnboardingView.vue'),
          meta: { tabKind: 'onboarding', titleKey: 'ui.onboarding.title' },
        },
        {
          path: '',
          redirect: '/patient/dashboard',
        },
        {
          path: 'dashboard',
          name: 'patient-dashboard',
          component: () => import('@/views/patient/PatientDashboardView.vue'),
          meta: { tabKind: 'dashboard', titleKey: 'ui.nav.myHealth' },
        },
        {
          path: 'examinations',
          name: 'patient-examinations',
          component: () => import('@/views/patient/ExaminationsView.vue'),
          meta: { tabKind: 'examinations', titleKey: 'ui.nav.myExaminations' },
        },
        {
          path: 'examinations/:id',
          name: 'patient-examination-detail',
          component: () => import('@/views/patient/ExaminationDetailView.vue'),
          meta: { tabKind: 'examination-detail', titleKey: 'ui.nav.examinationDetail' },
        },
        {
          path: 'reports',
          name: 'patient-reports',
          component: () => import('@/views/patient/ReportsView.vue'),
          meta: { tabKind: 'reports', titleKey: 'ui.nav.myReports' },
        },
        {
          path: 'body',
          name: 'patient-body',
          redirect: { name: 'patient-dashboard' },
        },
        {
          path: 'assistant',
          name: 'patient-ai',
          component: () => import('@/views/doctor/PatientAIView.vue'),
          meta: { tabKind: 'ai-chat', titleKey: 'ui.nav.aiAssistant' },
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { requiresAuth: true },
    },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  const isPublic = Boolean(to.meta.public)

  if (!isPublic && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (isPublic && auth.isAuthenticated) {
    return auth.portal === 'doctor'
      ? { name: 'doctor-dashboard' }
      : { name: 'patient-dashboard' }
  }

  if (to.meta.portal && to.meta.portal !== auth.portal) {
    return auth.portal === 'doctor'
      ? { name: 'doctor-dashboard' }
      : { name: 'patient-dashboard' }
  }

  if (to.meta.requiresAdmin && auth.session?.accountRole !== 'admin') {
    return { name: 'doctor-dashboard' }
  }

  if (
    auth.portal === 'patient'
    && !auth.session?.profileCompleted
    && !['/patient/onboarding', '/patient/profile'].includes(to.path)
  ) {
    return { name: 'patient-onboarding' }
  }

  return true
})

export default router
