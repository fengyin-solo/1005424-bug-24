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
          {{ exporting ? '导出中…' : '整包导出避险搬迁清单' }}
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
      <span class="legend-item legend-hint">环节固定次序：待签订 → 已签订 → 搬迁中 → 已完成，单向流转不可回退</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="relocate-layout">
      <!-- 侧栏：只镜像详情面板那一条，选中谁两侧就显示同一条 -->
      <aside class="relocate-side">
        <h3 class="side-title">搬迁安置单（{{ rows.length }}）</h3>
        <ul class="side-list">
          <li v-if="!rows.length" class="side-empty">暂无搬迁安置单</li>
          <li
            v-for="row in rows"
            :key="String(row.id)"
            class="side-item"
            :class="{ active: selectedId === row.id }"
            @click="selectRow(row.id)"
          >
            <span class="side-code">{{ row['搬迁编号'] ?? '—' }}</span>
            <span class="side-status" :class="householdInvalid(row) ? 'side-invalid' : ''">{{ row.status }}</span>
            <span class="side-households" :class="{ 'is-invalid': householdInvalid(row) }">
              涉及户数：{{ householdText(row) }}
            </span>
          </li>
        </ul>
      </aside>

      <div class="relocate-main">
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
              :class="{ 'row-selected': selectedId === row.id }"
              @click="selectRow(row.id)"
            >
              <td v-for="column in columns" :key="column">
                <template v-if="column === '涉及户数'">
                  <span :class="{ 'is-invalid': householdInvalid(row) }">{{ householdText(row) }}</span>
                </template>
                <template v-else>{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</template>
              </td>
              <td>{{ row.status }}</td>
              <td class="row-actions">
                <button
                  v-if="nextAction(row.status)"
                  class="link"
                  type="button"
                  @click.stop="runAction(nextAction(row.status), row)"
                >
                  {{ nextAction(row.status) }}
                </button>
                <span v-else class="action-done">已走完所有环节</span>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td :colspan="columns.length + 2" class="empty-state">暂无避险搬迁数据，可先登记搬迁安置单</td>
            </tr>
          </tbody>
        </table>

        <!-- 详情面板：涉及户数的唯一口径来源，侧栏与这里显示同一条、同一个值 -->
        <section v-if="selected" class="detail-panel">
          <h3 class="detail-title">安置单详情（{{ selected['搬迁编号'] || '—' }}）</h3>
          <dl class="detail-grid">
            <div v-for="column in columns" :key="column" class="detail-cell">
              <dt>{{ column }}</dt>
              <dd v-if="column === '涉及户数'" :class="{ 'is-invalid': householdInvalid(selected) }">
                {{ householdText(selected) }}
                <small v-if="householdInvalid(selected)" class="invalid-reason">{{ householdInvalidReason(selected) }}</small>
              </dd>
              <dd v-else>{{ selected[column] === '' || selected[column] == null ? '—' : selected[column] }}</dd>
            </div>
          </dl>
          <p class="detail-note">口径优先级：涉及户数以安置单详情面板（登记口径）为准，侧栏只镜像此处，两处始终一致；超出 1～9999 范围按无效处理，不参与合计、不进导出包。</p>
        </section>
        <section v-else class="detail-panel detail-empty">
          <h3 class="detail-title">安置单详情</h3>
          <p class="empty-state">侧栏与详情面板显示同一条：请先在左侧选择一张搬迁安置单。</p>
        </section>
      </div>
    </div>

    <!-- 导出收尾：批次结果、缺项清单与重试入口 -->
    <section v-if="exportResult" class="export-panel" :class="exportPanelClass">
      <h3 class="export-title">整包导出结果 · 批次 {{ exportResult.batchId || '—' }} · {{ exportResult.exportedAt || '—' }}</h3>
      <p class="export-message">{{ exportResult.message }}</p>
      <ul class="export-meta">
        <li>清单记录：{{ exportResult.totalRows }} 单</li>
        <li>本次成功入包：{{ exportResult.exported }} 单</li>
        <li>沿用首次结果：{{ exportResult.reused }} 单</li>
        <li>重复编号跳过：{{ exportResult.skippedDuplicates }} 单</li>
        <li>缺项未入包：{{ exportResult.failures.length }} 单</li>
        <li>联动预警已安置户：新增 {{ exportResult.settledAdded }} 条</li>
      </ul>
      <ul v-if="exportResult.failures.length" class="failure-list">
        <li v-for="failure in exportResult.failures" :key="failure.id" class="failure-item">
          <span class="failure-code">{{ failure.code }}</span>
          <span class="failure-reason">{{ failure.reason }}</span>
        </li>
      </ul>
      <div class="export-actions">
        <button
          class="btn"
          type="button"
          :disabled="exporting || !exportResult.failures.length"
          @click="retryFailures"
        >
          重试失败项（{{ exportResult.failures.length }}）
        </button>
        <span class="export-hint">重试只跑上次没成的安置单；同一搬迁编号只认第一次导出结果。</span>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条避险搬迁记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  isRelocateExporting,
  lastExportResult,
  runRelocateExport,
  type RelocateExportResult,
} from '@/api/relocate-export'
import {
  HOUSEHOLD_FIELD,
  NEXT_ACTION_BY_STATUS,
  RELOCATE_STATUSES,
  formatHouseholds,
  parseHouseholds,
  relocateStats,
} from '@/data/relocate'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('relocate')
const columns = ['搬迁编号', '所属隐患点', '涉及户数', '安置方式', '安置地点', '签订日期', '完成日期', '搬迁状态']
const statuses = [...RELOCATE_STATUSES]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedId = ref<number | null>(null)
const exportResult = ref<RelocateExportResult | null>(null)
const exporting = ref(false)

const stats = computed(() => relocateStats(rows.value))
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const selected = computed<EntryRow | null>(
  () => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null,
)

const exportPanelClass = computed(() => ({
  'panel-error': exportResult.value && exportResult.value.failures.length > 0,
  'panel-empty': exportResult.value && exportResult.value.empty,
  'panel-ok': exportResult.value && exportResult.value.failures.length === 0 && !exportResult.value.empty,
}))

function nextAction(status: string): string | undefined {
  return NEXT_ACTION_BY_STATUS[status]
}

// 涉及户数渲染只走这一个口径函数，侧栏、表格、详情面板三处因此天然一致。
function householdText(row: EntryRow): string {
  return formatHouseholds(row[HOUSEHOLD_FIELD])
}

function householdInvalid(row: EntryRow): boolean {
  return !parseHouseholds(row[HOUSEHOLD_FIELD]).valid
}

function householdInvalidReason(row: EntryRow): string {
  const parsed = parseHouseholds(row[HOUSEHOLD_FIELD])
  return parsed.valid ? '' : parsed.reason
}

function selectRow(id: number) {
  selectedId.value = id
}

function resetFilters() {
  filters.value = {}
  reload()
}

function runExport(mode: 'full' | 'retry') {
  errorMessage.value = ''
  if (isRelocateExporting()) {
    errorMessage.value = '上一整包还在导出中，请稍候，重复点击不会再生成第二份文件'
    return
  }
  exporting.value = true
  try {
    exportResult.value = runRelocateExport(mode)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '整包导出失败'
  } finally {
    exporting.value = false
  }
}

function exportRows() {
  runExport('full')
}

function retryFailures() {
  runExport('retry')
  reload()
}

function openCreate() {
  errorMessage.value = '搬迁安置单登记入口尚未接入审批流'
}

function runAction(action: string | undefined, row: EntryRow) {
  if (!action) {
    return
  }
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
    // 侧栏与详情面板永远钉住同一条；当前选中被过滤掉时回落到第一条。
    if (!rows.value.some((row) => Number(row.id) === selectedId.value)) {
      selectedId.value = rows.value.length ? Number(rows.value[0].id) : null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险搬迁列表读取失败'
  }
}

onMounted(() => {
  reload()
  exportResult.value = lastExportResult()
})
</script>

<style scoped>
.relocate-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 16px;
  align-items: start;
}

.relocate-side {
  border: 1px solid var(--border-color, #d9dee5);
  border-radius: 8px;
  background: var(--surface-color, #fff);
  padding: 12px;
  position: sticky;
  top: 12px;
}

.side-title {
  margin: 0 0 8px;
  font-size: 14px;
}

.side-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 520px;
  overflow-y: auto;
}

.side-item {
  display: grid;
  gap: 2px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
}

.side-item:hover {
  background: rgba(24, 144, 255, 0.08);
}

.side-item.active {
  background: rgba(24, 144, 255, 0.16);
}

.side-code {
  font-weight: 600;
}

.side-status {
  font-size: 12px;
  color: #5a6472;
}

.side-households {
  font-size: 12px;
}

.side-invalid,
.is-invalid {
  color: #cf1322;
}

.side-empty {
  padding: 12px 8px;
  color: #8a929e;
  font-size: 13px;
}

.relocate-main {
  display: grid;
  gap: 16px;
}

.data-table tr {
  cursor: pointer;
}

.data-table .row-selected {
  background: rgba(24, 144, 255, 0.08);
}

.action-done {
  color: #8a929e;
  font-size: 12px;
}

.detail-panel {
  border: 1px solid var(--border-color, #d9dee5);
  border-radius: 8px;
  background: var(--surface-color, #fff);
  padding: 16px;
}

.detail-title {
  margin: 0 0 12px;
  font-size: 15px;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin: 0;
}

.detail-cell dt {
  font-size: 12px;
  color: #8a929e;
}

.detail-cell dd {
  margin: 2px 0 0;
}

.invalid-reason {
  display: block;
  color: #cf1322;
  font-size: 12px;
}

.detail-note {
  margin: 12px 0 0;
  font-size: 12px;
  color: #5a6472;
}

.detail-empty .empty-state {
  margin: 0;
}

.export-panel {
  margin-top: 16px;
  border: 1px solid var(--border-color, #d9dee5);
  border-radius: 8px;
  padding: 16px;
  background: var(--surface-color, #fff);
}

.panel-error {
  border-color: #ffa39e;
  background: #fff7f6;
}

.panel-empty {
  border-color: #ffd591;
  background: #fffbe6;
}

.panel-ok {
  border-color: #b7eb8f;
  background: #f6ffed;
}

.export-title {
  margin: 0 0 8px;
  font-size: 14px;
}

.export-message {
  margin: 0 0 8px;
}

.export-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  font-size: 13px;
  color: #5a6472;
}

.failure-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  border-top: 1px dashed #ffa39e;
}

.failure-item {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  font-size: 13px;
}

.failure-code {
  min-width: 110px;
  font-weight: 600;
}

.failure-reason {
  color: #cf1322;
}

.export-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.export-hint,
.legend-hint {
  font-size: 12px;
  color: #8a929e;
}
</style>
