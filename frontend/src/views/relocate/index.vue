<template>
  <section class="page" data-module="relocate">
    <header class="page-head">
      <div>
        <h2>避险搬迁管理</h2>
        <p class="page-desc">维护搬迁安置单，围绕搬迁编号、所属隐患点、涉及户数、安置方式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记搬迁安置单</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportRows">
          {{ exporting ? '导出中…' : failedCount > 0 ? `导出避险搬迁清单（重试 ${failedCount} 张未成功）` : '导出避险搬迁清单' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-note">环节按固定次序单向流转：待签订 → 已签订 → 搬迁中 → 已完成</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="detail-layout">
      <div class="detail-main">
        <table class="data-table">
          <thead>
            <tr>
              <th v-for="column in columns" :key="column">{{ column }}</th>
              <th>当前状态</th>
              <th>可执行动作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="String(row.id)"
              :class="{ 'row-selected': Number(row.id) === selectedId }"
              @click="selectRow(Number(row.id))"
            >
              <td v-for="column in columns" :key="column">
                <template v-if="column === '涉及户数'">
                  <span :class="{ 'invalid-text': !isValidHousehold(row) }">{{ displayHouseholds(row) }}</span>
                  <span v-if="!isValidHousehold(row)" class="invalid-tag" :title="householdReason(row)">无效</span>
                </template>
                <template v-else>{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</template>
              </td>
              <td>{{ row.status }}</td>
              <td class="row-actions" @click.stop>
                <button
                  v-for="action in allowedActions(row)"
                  :key="action"
                  class="link"
                  type="button"
                  @click="runAction(action, row)"
                >
                  {{ action }}
                </button>
                <span v-if="allowedActions(row).length === 0" class="muted-text">—</span>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td :colspan="columns.length + 2" class="empty-state">暂无避险搬迁数据，可先登记搬迁安置单</td>
            </tr>
          </tbody>
        </table>

        <footer class="page-foot">
          <span>共 {{ total }} 条避险搬迁记录</span>
          <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
          <span v-else-if="errorMessage" class="error-text">{{ errorMessage }}</span>
        </footer>
      </div>

      <aside class="detail-side">
        <section class="side-card">
          <h3 class="side-title">导出 / 预警台账（已安置户）</h3>
          <p class="side-note">同一搬迁编号重复导出只认第一次结果；失败单修正后点导出即可重试。</p>
          <ul class="side-list">
            <li
              v-for="item in sideItems"
              :key="String(item.rowId)"
              class="side-item"
              :class="{ active: item.rowId === selectedId, failed: item.exportState === '失败待重试' }"
              @click="selectRow(item.rowId)"
            >
              <div class="side-item-head">
                <strong>{{ item.code }}</strong>
                <span class="side-state" :class="item.exportStateClass">{{ item.exportState }}</span>
              </div>
              <!-- 侧栏涉及户数与详情面板、主表同源：都走 readHouseholds 的唯一口径 -->
              <div class="side-item-meta">涉及户数：{{ item.households }}</div>
              <div v-if="item.reason" class="side-item-reason">{{ item.reason }}</div>
            </li>
          </ul>
          <p v-if="!sideItems.length" class="empty-state side-empty">暂无安置单，导出后这里显示已安置户台账</p>
        </section>

        <section class="side-card">
          <h3 class="side-title">安置单详情</h3>
          <template v-if="selectedRow">
            <dl class="detail-list">
              <div v-for="column in columns" :key="column" class="detail-line">
                <dt>{{ column }}</dt>
                <dd v-if="column === '涉及户数'">
                  <span :class="{ 'invalid-text': !isValidHousehold(selectedRow) }">{{ displayHouseholds(selectedRow) }}</span>
                  <span v-if="!isValidHousehold(selectedRow)" class="invalid-text">（{{ householdReason(selectedRow) }}）</span>
                </dd>
                <dd v-else>{{ selectedRow[column] === '' || selectedRow[column] == null ? '—' : selectedRow[column] }}</dd>
              </div>
            </dl>
          </template>
          <p v-else class="empty-state side-empty">点击左侧列表或主表中的安置单，查看同一条详情</p>
        </section>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadCsv, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  displayHouseholds,
  householdReason,
  listFailedExports,
  listSettledHouseholds,
  readHouseholds,
  runRelocateExport,
} from '@/data/relocate-ledger'
import type { EntryRow, FailedExport, SettledHousehold } from '@/data/types'

const meta = moduleMeta('relocate')
const columns = ['搬迁编号', '所属隐患点', '涉及户数', '安置方式', '安置地点', '签订日期', '完成日期', '搬迁状态']
const actions = ['确认签订', '开始搬迁', '确认完成']
const statuses = ['待签订', '已签订', '搬迁中', '已完成']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const exporting = ref(false)
const selectedId = ref<number | null>(null)
const settled = ref<SettledHousehold[]>([])
const failed = ref<FailedExport[]>([])

const allRowsView = computed(() => {
  // 侧栏不受筛选条件影响，始终展示全量安置单（导出/预警台账口径）。
  return listEntries(meta.key).items
})

function isValidHousehold(row: EntryRow): boolean {
  return readHouseholds(row['涉及户数']).valid
}

function sumHouseholds(rowList: EntryRow[], status?: string): number {
  // 所有户数合计只累加通过校验的涉及户数；缺失/非法的不计入，避免合计被脏值带错。
  return rowList.reduce((sum, row) => {
    if (status && String(row.status) !== status) {
      return sum
    }
    const reading = readHouseholds(row['涉及户数'])
    return reading.valid ? sum + reading.value : sum
  }, 0)
}

const stats = computed(() => [
  { label: '待签订户数', value: sumHouseholds(allRowsView.value, '待签订') },
  { label: '搬迁中户数', value: sumHouseholds(allRowsView.value, '搬迁中') },
  // 已安置户数以「导出成功收尾」的台账为唯一口径，与预警发布那边的已安置户合计同源同值。
  { label: '已安置户数', value: settled.value.reduce((sum, item) => sum + item.households, 0) },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: allRowsView.value.filter((row) => String(row.status) === status).length,
  })),
)

const failedCount = computed(() => failed.value.length)

const selectedRow = computed(() =>
  selectedId.value === null ? undefined : allRowsView.value.find((row) => Number(row.id) === selectedId.value),
)

const sideItems = computed(() =>
  allRowsView.value.map((row) => {
    const rowId = Number(row.id)
    const code = String(row['搬迁编号'] ?? '').trim() || `#${rowId}`
    const failedItem = failed.value.find((item) => item.rowId === rowId)
    const settledItem = settled.value.find((item) => item.rowId === rowId)
    const exportState = settledItem
      ? '已导出·已安置'
      : failedItem
        ? '失败待重试'
        : '未导出'
    return {
      rowId,
      code,
      exportState,
      exportStateClass: settledItem ? 'state-done' : failedItem ? 'state-fail' : 'state-pending',
      households: displayHouseholds(row),
      reason: failedItem?.reason ?? '',
    }
  }),
)

// 单向固定次序：只放开「当前环节的下一挡」动作，跳档动作在数据层同样会被拒绝。
function allowedActions(row: EntryRow): string[] {
  const index = statuses.indexOf(String(row.status))
  if (index < 0 || index >= actions.length) {
    return []
  }
  return [actions[index]]
}

function selectRow(id: number) {
  selectedId.value = id
}

function resetFilters() {
  filters.value = {}
  reload()
}

function refreshLedger() {
  settled.value = listSettledHouseholds()
  failed.value = listFailedExports()
}

function exportRows() {
  if (exporting.value) {
    // 重复点击直接吞掉：一份安置单只允许一个在途导出，杜绝堆出两份半截文件。
    return
  }
  errorMessage.value = ''
  noticeMessage.value = ''
  exporting.value = true
  try {
    const result = runRelocateExport()
    if (result.downloadable) {
      downloadCsv(result.filename, result.content)
    }
    // 没有可导记录（空数据或全部已成功/全部失败）时不产生空包，只把说明留在界面上。
    noticeMessage.value = result.message
    refreshLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险搬迁清单导出失败'
  } finally {
    exporting.value = false
  }
}

function openCreate() {
  errorMessage.value = '搬迁安置单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
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
    refreshLedger()
    if (selectedId.value !== null && !allRowsView.value.some((row) => Number(row.id) === selectedId.value)) {
      selectedId.value = null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险搬迁列表读取失败'
  }
}

onMounted(reload)
</script>
