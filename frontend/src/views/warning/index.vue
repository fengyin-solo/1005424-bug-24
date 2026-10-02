<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警发布管理</h2>
        <p class="page-desc">维护预警信息，围绕预警编号、发布对象、预警级别、触发雨量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记预警信息</button>
        <button class="btn" type="button" @click="exportRows">导出预警发布清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="linked-ledger">
      <header class="linked-head">
        <h3>搬迁安置联动台账（已安置户）</h3>
        <p class="side-note">
          由避险搬迁导出收尾驱动：每张安置单导出成功后在此多出一条已安置户。涉及户数口径以搬迁安置单登记值为准，本台账只读镜像、不另存第二份；两处不一致时以安置单为优先口径。
        </p>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>搬迁编号</th>
            <th>所属隐患点</th>
            <th>涉及户数</th>
            <th>安置地点</th>
            <th>导出收尾时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in settledHouseholds" :key="`${item.rowId}-${item.code}`">
            <td>{{ item.code }}</td>
            <td>{{ item.hazard || '—' }}</td>
            <!-- 与搬迁侧栏、详情面板同一数据源：保证两处涉及户数一致 -->
            <td>{{ item.households }}</td>
            <td>{{ item.location || '—' }}</td>
            <td>{{ formatTime(item.settledAt) }}</td>
          </tr>
          <tr v-if="!settledHouseholds.length">
            <td colspan="5" class="empty-state">暂无已安置户记录：搬迁安置单导出成功后会自动登记到这里（空态，不产生空包）</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>已安置户数合计：<strong>{{ settledHouseholdTotal }}</strong>（与避险搬迁页「已安置户数」同值）</span>
      </footer>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无预警发布数据，可先登记预警信息</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警发布记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listSettledHouseholds } from '@/data/relocate-ledger'
import type { EntryRow, SettledHousehold } from '@/data/types'

const meta = moduleMeta('warning')
const columns = ["预警编号", "发布对象", "预警级别", "触发雨量", "发布时间", "发布渠道", "解除时间", "预警状态"]
const actions = ["确认发布", "解除预警", "标记误报"]
const statuses = ["待发布", "已发布", "已解除", "已误报"]
const stats = [{"label": "待发布预警", "value": 0}, {"label": "已发布预警", "value": 0}, {"label": "本月误报数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 搬迁导出收尾驱动的已安置户台账：进入本页即读最新结果。
const settledHouseholds = ref<SettledHousehold[]>([])
const settledHouseholdTotal = computed(() =>
  settledHouseholds.value.reduce((sum, item) => sum + item.households, 0),
)

function formatTime(value: string): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '预警信息登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    settledHouseholds.value = listSettledHouseholds()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警发布列表读取失败'
  }
}

onMounted(reload)
</script>
