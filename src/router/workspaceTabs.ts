import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type { PortalRole } from '@/types'
import { workspaceTabKey } from '@/stores/workspaceTabs'

export function routeWorkspaceTabKey(route: RouteLocationNormalizedLoaded, fallbackPortal?: PortalRole | null) {
  const portal = (route.meta.portal || fallbackPortal) as PortalRole | undefined
  const kind = String(route.meta.workspaceTabKey || route.meta.tabKind || '')
  return portal && kind ? workspaceTabKey(portal, kind) : ''
}
