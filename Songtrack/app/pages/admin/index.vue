<script setup lang="ts">
definePageMeta({ middleware: 'admin' })

interface AdminUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'user'
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  songCount: number
  bytes: number
}

interface AuditEntry {
  id: string
  action: string
  actorName: string
  targetName: string | null
  detail: string | null
  createdAt: string
}

const { data: usersList, refresh: refreshUsers } = await useFetch<AdminUser[]>('/api/admin/users')
const { data: settings, refresh: refreshSettings } = await useFetch<{ signupsEnabled: boolean }>('/api/admin/settings')
const { data: auditLog } = await useFetch<AuditEntry[]>('/api/admin/audit-log')

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

const busyUserId = ref<string | null>(null)
async function act(userId: string, action: 'approve' | 'reject' | 'revoke') {
  busyUserId.value = userId
  try {
    await $fetch(`/api/admin/users/${userId}/${action}`, { method: 'POST' })
    await refreshUsers()
  } finally {
    busyUserId.value = null
  }
}

async function toggleSignups() {
  await $fetch('/api/admin/settings', {
    method: 'POST',
    body: { signupsEnabled: !settings.value?.signupsEnabled },
  })
  await refreshSettings()
}

const router = useRouter()
async function impersonate(userId: string) {
  await $fetch(`/api/admin/impersonate/${userId}`, { method: 'POST' })
  await router.push('/')
  window.location.reload()
}
</script>

<template>
  <div class="max-w-3xl mx-auto p-4 flex flex-col gap-8">
    <h1 class="text-2xl font-semibold">Admin</h1>

    <section>
      <div class="flex items-center gap-3">
        <span class="font-medium">Signups</span>
        <input
          type="checkbox"
          class="toggle toggle-primary"
          :checked="settings?.signupsEnabled"
          @change="toggleSignups"
        >
        <span class="text-sm text-base-content/60">
          {{ settings?.signupsEnabled ? 'Open — new Google accounts can join' : 'Closed — only existing accounts can sign in' }}
        </span>
      </div>
    </section>

    <section>
      <h2 class="text-lg font-medium mb-2">Users</h2>
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Songs</th>
              <th>Storage</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in usersList" :key="u.id">
              <td>{{ u.name }}</td>
              <td class="text-base-content/60">{{ u.email }}</td>
              <td>{{ u.role }}</td>
              <td>
                <span
                  class="badge badge-sm"
                  :class="{
                    'badge-success': u.status === 'approved',
                    'badge-warning': u.status === 'pending',
                    'badge-error': u.status === 'rejected',
                  }"
                >
                  {{ u.status }}
                </span>
              </td>
              <td>{{ u.songCount }}</td>
              <td>{{ formatBytes(u.bytes) }}</td>
              <td class="flex gap-1 flex-wrap justify-end">
                <button
                  v-if="u.status !== 'approved'"
                  class="btn btn-xs btn-success"
                  :disabled="busyUserId === u.id"
                  @click="act(u.id, 'approve')"
                >
                  Approve
                </button>
                <button
                  v-if="u.status === 'approved' && u.role !== 'admin'"
                  class="btn btn-xs"
                  :disabled="busyUserId === u.id"
                  @click="act(u.id, 'revoke')"
                >
                  Revoke
                </button>
                <button
                  v-if="u.status !== 'rejected' && u.role !== 'admin'"
                  class="btn btn-xs btn-error btn-outline"
                  :disabled="busyUserId === u.id"
                  @click="act(u.id, 'reject')"
                >
                  Reject
                </button>
                <button
                  v-if="u.role !== 'admin'"
                  class="btn btn-xs btn-outline"
                  @click="impersonate(u.id)"
                >
                  View as
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2 class="text-lg font-medium mb-2">Audit log</h2>
      <p class="text-sm text-base-content/60 mb-2">Actions taken while impersonating another user.</p>
      <ul class="flex flex-col gap-1 text-sm">
        <li v-for="entry in auditLog" :key="entry.id" class="flex gap-2">
          <span class="text-base-content/40 whitespace-nowrap">{{ new Date(entry.createdAt).toLocaleString() }}</span>
          <span>{{ entry.actorName }} → {{ entry.action }}<template v-if="entry.targetName"> ({{ entry.targetName }})</template></span>
        </li>
        <li v-if="!auditLog?.length" class="text-base-content/40">No impersonated actions yet.</li>
      </ul>
    </section>
  </div>
</template>
