<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AICopilotDrawer from '@/components/agent/AICopilotDrawer.vue'
import { usePatientStore } from '@/stores/patients'

const route = useRoute()
const router = useRouter()
const patients = usePatientStore()
const patientId = computed(() => String(route.query.patientId || patients.selectedPatientId || ''))

function closeWorkspace() {
  void router.push(patientId.value
    ? { name: 'doctor-patient-overview', params: { id: patientId.value } }
    : { name: 'doctor-dashboard' })
}

function openRecords() {
  if (patientId.value) void router.push({ name: 'doctor-patient-report', params: { id: patientId.value } })
}
</script>

<template>
  <section class="agent-workspace" data-testid="agent-workspace">
    <AICopilotDrawer open embedded @close="closeWorkspace" @open-records="openRecords" />
  </section>
</template>

<style scoped>
.agent-workspace{height:calc(100dvh - var(--topbar-height) - 110px);min-height:620px}
</style>
