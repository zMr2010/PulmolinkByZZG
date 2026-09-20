<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { X } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useWorkspaceTabsStore } from '@/stores/workspaceTabs'
import { useReportDraftStore } from '@/stores/reportDrafts'
import type { WorkspaceTab } from '@/stores/workspaceTabs'
import { routeWorkspaceTabKey } from '@/router/workspaceTabs'
import { t } from '@/i18n'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const workspace = useWorkspaceTabsStore()
const drafts = useReportDraftStore()
const visibleTabs = computed(() => workspace.tabs.filter(tab => tab.portal === auth.portal))
const activeKey = computed(() => routeWorkspaceTabKey(route, auth.portal))
const tabButtons = ref<HTMLButtonElement[]>([])

function displayTitle(tab: WorkspaceTab) {
  const translated = t(tab.titleKey, tab.titleParams)
  return tab.titleParams.patient ? `${tab.titleParams.patient} · ${translated}` : translated
}

function setTabButton(element: unknown, index: number) {
  if (element instanceof HTMLButtonElement) tabButtons.value[index] = element
}

function focusTab(index: number) {
  const count = visibleTabs.value.length
  if (!count) return
  tabButtons.value[(index + count) % count]?.focus()
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  if (event.key === 'ArrowRight') focusTab(index + 1)
  else if (event.key === 'ArrowLeft') focusTab(index - 1)
  else if (event.key === 'Home') focusTab(0)
  else if (event.key === 'End') focusTab(visibleTabs.value.length - 1)
  else return
  event.preventDefault()
}

async function closeTab(key: string) {
  const active = activeKey.value === key
  const index = workspace.closeTab(key)
  if (!active) return
  const remaining = visibleTabs.value
  const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]
  await router.push(next?.path || (auth.portal === 'doctor' ? '/doctor/dashboard' : '/patient/dashboard'))
  await nextTick()
  focusTab(Math.min(Math.max(index, 0), remaining.length - 1))
}
</script>

<template>
  <div class="workspace-tabs" role="group" :aria-label="$t('ui.shell.openTabs')">
    <div
      v-for="tab in visibleTabs"
      :key="tab.key"
      class="workspace-tab"
      :class="{ active: activeKey === tab.key, dirty: drafts.hasDirtyPath(tab.path) }"
      :title="displayTitle(tab)"
    >
      <button :ref="element => setTabButton(element, visibleTabs.findIndex(item => item.key === tab.key))" class="tab-main" type="button" :tabindex="activeKey === tab.key ? 0 : -1" :aria-current="activeKey === tab.key ? 'page' : undefined" @keydown="onTabKeydown($event, visibleTabs.findIndex(item => item.key === tab.key))" @click="router.push(tab.path)">
        <span>{{ displayTitle(tab) }}<i v-if="drafts.hasDirtyPath(tab.path)" :aria-label="$t('ui.shell.unsavedDraft')">●</i></span>
      </button>
      <button class="tab-close" type="button" :aria-label="$t('ui.shell.closeTab', { title: displayTitle(tab) })" @click="closeTab(tab.key)">
        <X :size="13" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.workspace-tabs {
  position: sticky;
  z-index: 19;
  top: var(--topbar-height);
  display: flex;
  min-height: 42px;
  align-items: flex-end;
  gap: 3px;
  overflow-x: auto;
  padding: 7px 18px 0;
  border-bottom: 1px solid var(--border);
  background: rgb(245 248 249 / 94%);
  backdrop-filter: blur(10px);
  scrollbar-width: thin;
}

.workspace-tab {
  display: flex;
  min-width: 136px;
  max-width: 230px;
  height: 34px;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 12px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  text-align: left;
}

.tab-main {
  display: flex;
  min-width: 0;
  height: 100%;
  flex: 1;
  align-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}

.tab-main > span {
  overflow: hidden;
  width: 100%;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-main i { margin-left: 6px; color: var(--amber); font-size: 9px; font-style: normal; }

.workspace-tab:hover {
  background: var(--surface-3);
  color: var(--text);
}

.workspace-tab.active {
  border-color: var(--border);
  background: var(--surface);
  color: var(--accent-strong);
  font-weight: 680;
}

.tab-close {
  display: grid;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
}

.tab-close:hover {
  background: var(--border);
  color: var(--text);
}

@media (max-width: 760px) {
  .workspace-tabs { padding-left: 10px; }
  .workspace-tab { min-width: 124px; }
}
</style>
