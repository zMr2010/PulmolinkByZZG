import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean
    portal?: 'doctor' | 'patient'
    requiresAuth?: boolean
    requiresAdmin?: boolean
    workspaceTabKey?: string
    tabKind?: string
    titleKey?: string
  }
}
