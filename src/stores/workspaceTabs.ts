import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { PortalRole } from '@/types'

export type WorkspaceTitleParams = Record<string, string | number>

export interface WorkspaceTab {
  key: string
  path: string
  titleKey: string
  titleParams: WorkspaceTitleParams
  portal: PortalRole
  kind: string
}

type LegacyWorkspaceTab = {
  id?: unknown
  path?: unknown
  title?: unknown
  portal?: unknown
}

const STORAGE_KEY = 'pulmolink-workspace-tabs-v2'
const LEGACY_STORAGE_KEY = 'pulmolink-workspace-tabs-v1'
const MAX_TABS = 12

export function workspaceTabKey(portal: PortalRole, kind: string) {
  return `${portal}:${kind}`
}

function legacyDefinition(path: string, title: string) {
  const definitions: Array<[RegExp, string, string]> = [
    [/^\/doctor\/dashboard/, 'dashboard', 'ui.sidebar.patientWorkspace'],
    [/^\/doctor\/admin\/users/, 'admin-users', 'ui.adminUsers.title'],
    [/^\/doctor\/admin\/access/, 'admin-access', 'ui.patientAccess.title'],
    [/^\/doctor\/admin\/stats/, 'admin-stats', 'ui.adminStats.title'],
    [/^\/doctor\/archived/, 'archived', 'ui.archive.title'],
    [/^\/doctor\/agent/, 'agent', 'ui.agent.workspaceTitle'],
    [/^\/doctor\/patients\/[^/]+\/simulation/, 'surgery-simulation', 'ui.simulation.title'],
    [/^\/doctor\/patients\/[^/]+\/anatomy/, 'anatomy-viewer', 'ui.anatomyViewer.title'],
    [/^\/doctor\/patients\/[^/]+\/imaging/, 'patient-imaging', 'ui.nav.medicalImaging'],
    [/^\/doctor\/patients\/[^/]+\/ai/, 'patient-ai', 'ui.sidebar.aiDiagnosis'],
    [/^\/doctor\/patients\/[^/]+\/report/, 'patient-report', 'ui.sidebar.clinicalReport'],
    [/^\/doctor\/patients\/[^/]+\/3d/, 'patient-3d', 'ui.sidebar.organ3d'],
    [/^\/doctor\/patients\/[^/]+/, 'patient-overview', 'ui.sidebar.patientOverview'],
    [/^\/patient\/dashboard/, 'dashboard', 'ui.nav.myHealth'],
    [/^\/patient\/examinations\/[^/]+/, 'examination-detail', 'ui.nav.examinationDetail'],
    [/^\/patient\/examinations/, 'examinations', 'ui.nav.myExaminations'],
    [/^\/patient\/reports/, 'reports', 'ui.nav.myReports'],
    [/^\/patient\/assistant/, 'ai-chat', 'ui.nav.aiAssistant'],
    [/\/profile/, 'profile', 'ui.topbar.profile'],
  ]
  const match = definitions.find(([pattern]) => pattern.test(path))
  return match ? { kind: match[1], titleKey: match[2] } : { kind: `legacy:${title || path}`, titleKey: title || 'PulmoLink' }
}

function isPortal(value: unknown): value is PortalRole {
  return value === 'doctor' || value === 'patient'
}

function normalizeTab(value: unknown): WorkspaceTab | null {
  if (!value || typeof value !== 'object') return null
  const tab = value as Partial<WorkspaceTab>
  if (!isPortal(tab.portal) || typeof tab.kind !== 'string' || typeof tab.path !== 'string' || typeof tab.titleKey !== 'string') return null
  return {
    key: workspaceTabKey(tab.portal, tab.kind),
    path: tab.path,
    titleKey: tab.titleKey,
    titleParams: tab.titleParams && typeof tab.titleParams === 'object' ? tab.titleParams : {},
    portal: tab.portal,
    kind: tab.kind,
  }
}

export function migrateLegacyTabs(value: unknown): WorkspaceTab[] {
  if (!Array.isArray(value)) return []
  const migrated: WorkspaceTab[] = []
  for (const candidate of value.slice(0, MAX_TABS)) {
    const tab = candidate as LegacyWorkspaceTab
    if (!isPortal(tab.portal) || typeof tab.path !== 'string') continue
    const title = typeof tab.title === 'string' ? tab.title : ''
    const { kind, titleKey } = legacyDefinition(tab.path, title)
    const next: WorkspaceTab = {
      key: workspaceTabKey(tab.portal, kind),
      path: tab.path,
      titleKey,
      titleParams: {},
      portal: tab.portal,
      kind,
    }
    const existing = migrated.findIndex(item => item.key === next.key)
    if (existing >= 0) migrated[existing] = next
    else migrated.push(next)
  }
  return migrated
}

export function deserializeWorkspaceTabs(raw: string | null): WorkspaceTab[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const tabs: WorkspaceTab[] = []
    for (const candidate of value.slice(0, MAX_TABS)) {
      const tab = normalizeTab(candidate)
      if (!tab) continue
      const existing = tabs.findIndex(item => item.key === tab.key)
      if (existing >= 0) tabs[existing] = tab
      else tabs.push(tab)
    }
    return tabs
  } catch {
    return []
  }
}

function storedTabs(): WorkspaceTab[] {
  try {
    const currentRaw = sessionStorage.getItem(STORAGE_KEY)
    const current = deserializeWorkspaceTabs(currentRaw)
    if (current.length || currentRaw !== null) return current
    const legacyRaw = sessionStorage.getItem(LEGACY_STORAGE_KEY)
    if (!legacyRaw) return []
    const migrated = migrateLegacyTabs(JSON.parse(legacyRaw))
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    sessionStorage.removeItem(LEGACY_STORAGE_KEY)
    return migrated
  } catch {
    return []
  }
}

export const useWorkspaceTabsStore = defineStore('workspace-tabs', () => {
  const tabs = ref<WorkspaceTab[]>(storedTabs())

  function persist() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs.value))
      sessionStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      /* A private browsing policy may disable session storage. */
    }
  }

  function openTab(tab: WorkspaceTab) {
    const normalized = normalizeTab(tab)
    if (!normalized) return
    const existing = tabs.value.find(item => item.key === normalized.key)
    if (existing) Object.assign(existing, normalized)
    else {
      tabs.value.push(normalized)
      if (tabs.value.length > MAX_TABS) tabs.value.shift()
    }
    persist()
  }

  function closeTab(key: string) {
    const index = tabs.value.findIndex(tab => tab.key === key)
    if (index >= 0) tabs.value.splice(index, 1)
    persist()
    return index
  }

  function reset() {
    tabs.value = []
    try {
      sessionStorage.removeItem(STORAGE_KEY)
      sessionStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      /* Nothing else to clear. */
    }
  }

  return { tabs, openTab, closeTab, reset }
})
