import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setLocale, t } from '@/i18n'
import {
  deserializeWorkspaceTabs,
  migrateLegacyTabs,
  useWorkspaceTabsStore,
  workspaceTabKey,
  type WorkspaceTab,
} from './workspaceTabs'

function tab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    key: workspaceTabKey('doctor', 'patient-imaging'),
    path: '/doctor/patients/1/imaging?exam=1',
    titleKey: 'ui.nav.medicalImaging',
    titleParams: { patient: 'Patient A' },
    portal: 'doctor',
    kind: 'patient-imaging',
    ...overrides,
  }
}

describe('workspace tab identity', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('replaces the same page kind across patients and query changes', () => {
    const store = useWorkspaceTabsStore()
    store.openTab(tab())
    store.openTab(tab({ path: '/doctor/patients/2/imaging?exam=9', titleParams: { patient: 'Patient B' } }))
    expect(store.tabs).toHaveLength(1)
    expect(store.tabs[0]?.path).toContain('/patients/2/')
    expect(store.tabs[0]?.titleParams.patient).toBe('Patient B')
  })

  it('updates one imaging tab when only the examination query changes', () => {
    const store = useWorkspaceTabsStore()
    store.openTab(tab())
    store.openTab(tab({ path: '/doctor/patients/1/imaging?exam=2' }))
    expect(store.tabs).toHaveLength(1)
    expect(store.tabs[0]?.path).toBe('/doctor/patients/1/imaging?exam=2')
  })

  it('preserves position while updating title parameters', () => {
    const store = useWorkspaceTabsStore()
    store.openTab(tab())
    store.openTab(tab({ titleParams: { patient: 'Patient B' } }))
    expect(store.tabs[0]).toMatchObject({
      key: 'doctor:patient-imaging',
      titleKey: 'ui.nav.medicalImaging',
      titleParams: { patient: 'Patient B' },
    })
  })

  it('keeps distinct page kinds and separates portals', () => {
    const store = useWorkspaceTabsStore()
    store.openTab(tab())
    store.openTab(tab({ key: workspaceTabKey('doctor', 'patient-report'), kind: 'patient-report', path: '/doctor/patients/1/report' }))
    store.openTab(tab({ key: workspaceTabKey('patient', 'dashboard'), portal: 'patient', kind: 'dashboard', path: '/patient/dashboard' }))
    expect(store.tabs.map(item => item.key)).toEqual([
      'doctor:patient-imaging',
      'doctor:patient-report',
      'patient:dashboard',
    ])
  })

  it('returns the closed position so the UI can select an adjacent tab', () => {
    const store = useWorkspaceTabsStore()
    store.openTab(tab())
    store.openTab(tab({ key: workspaceTabKey('doctor', 'patient-report'), kind: 'patient-report', path: '/doctor/patients/1/report' }))
    expect(store.closeTab('doctor:patient-imaging')).toBe(0)
    expect(store.tabs[0]?.kind).toBe('patient-report')
  })

  it('translates a stored semantic title immediately after locale changes', () => {
    const stored = tab()
    setLocale('zh')
    expect(t(stored.titleKey)).toBe('医学影像')
    setLocale('en')
    expect(t(stored.titleKey)).toBe('Medical imaging')
    setLocale('zh')
  })

  it('restores valid v2 tabs and migrates legacy full-path tabs', () => {
    expect(deserializeWorkspaceTabs(JSON.stringify([tab()]))).toEqual([tab()])
    const migrated = migrateLegacyTabs([
      { id: '/doctor/patients/1/imaging?exam=1', path: '/doctor/patients/1/imaging?exam=1', title: 'Medical Imaging', portal: 'doctor' },
      { id: '/doctor/patients/2/imaging?exam=2', path: '/doctor/patients/2/imaging?exam=2', title: 'Medical Imaging', portal: 'doctor' },
    ])
    expect(migrated).toHaveLength(1)
    expect(migrated[0]?.path).toContain('/patients/2/')
  })

  it('ignores corrupt persisted entries while restoring valid v2 tabs', () => {
    const restored = deserializeWorkspaceTabs(JSON.stringify([
      { path: '/missing-metadata' },
      tab(),
      tab({ path: '/doctor/patients/3/imaging' }),
    ]))
    expect(restored).toHaveLength(1)
    expect(restored[0]?.path).toContain('/patients/3/')
  })
})
