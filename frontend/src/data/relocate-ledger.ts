import { listRows } from './local-store'
import type {
  EntryRow,
  FailedExport,
  RelocateExportResult,
  SettledHousehold,
} from './types'
import { RELOCATE_HOUSEHOLD_MAX, RELOCATE_HOUSEHOLD_MIN } from './types'

// 导出台账独立存放：成功结果（同时是预警发布那边「已安置户」台账的数据源）与待重试的失败单分开记。
const LEDGER_KEY = 'geohazard-patrol:relocate-export-ledger'

const CODE_FIELD = '搬迁编号'
const HAZARD_FIELD = '所属隐患点'
const HOUSEHOLD_FIELD = '涉及户数'
const LOCATION_FIELD = '安置地点'

export type HouseholdReading =
  | { valid: true; value: number }
  | { valid: false; reason: string }

// 涉及户数口径的唯一校验入口：侧栏、详情面板、导出、预警台账都走这里，保证两处显示一致。
// 规则：缺失（空着）或非法（非整数/带非数字字符）一律无效；超出 1～9999 范围也按无效处理。
export function readHouseholds(raw: unknown): HouseholdReading {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { valid: false, reason: '涉及户数缺失' }
  }
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    return { valid: false, reason: '涉及户数非法（须为整数）' }
  }
  const value = Number(text)
  if (value < RELOCATE_HOUSEHOLD_MIN || value > RELOCATE_HOUSEHOLD_MAX) {
    return { valid: false, reason: `涉及户数超出范围（${RELOCATE_HOUSEHOLD_MIN}～${RELOCATE_HOUSEHOLD_MAX}）` }
  }
  return { valid: true, value }
}

// 详情面板/侧栏展示用的统一读法：无效就回退成占位符，不展示脏值。
export function displayHouseholds(row: EntryRow): string {
  const reading = readHouseholds(row[HOUSEHOLD_FIELD])
  return reading.valid ? String(reading.value) : '—'
}

export function householdReason(row: EntryRow): string {
  const reading = readHouseholds(row[HOUSEHOLD_FIELD])
  return reading.valid ? '' : reading.reason
}

type Ledger = {
  // key 为搬迁编号；同一搬迁编号重复导出，只认第一次成功的结果，这里不再覆盖。
  success: Record<string, SettledHousehold>
  failed: FailedExport[]
}

function emptyLedger(): Ledger {
  return { success: {}, failed: [] }
}

function readLedger(): Ledger {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyLedger()
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    return emptyLedger()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger>
    return {
      success: parsed.success && typeof parsed.success === 'object' ? parsed.success : {},
      failed: Array.isArray(parsed.failed) ? parsed.failed : [],
    }
  } catch {
    return emptyLedger()
  }
}

function persistLedger(ledger: Ledger): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger))
  }
}

export function resetRelocateLedger(): void {
  persistLedger(emptyLedger())
}

// 预警发布台账读取「已安置户」：直接拿搬迁安置单第一次导出成功的结果，不另存第二份。
// 口径优先级：以搬迁安置单登记的涉及户数为唯一准绳；台账是只读镜像，绝不回改安置单。
export function listSettledHouseholds(): SettledHousehold[] {
  return Object.values(readLedger().success).sort((a, b) => a.settledAt.localeCompare(b.settledAt))
}

export function listFailedExports(): FailedExport[] {
  return readLedger().failed
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 搬迁清单整包导出（导出按钮与失败重试共用这一条入口）：
// 1. 涉及户数缺失/非法的安置单单独拎出来记为失败，其余照常出包，一份都不少；
// 2. 同一搬迁编号只认第一次成功的结果，重复导出/重复点击不会再出第二份；
// 3. 重试只重跑上一轮没成的那些，已成功的不重复打包；
// 4. 没有可导记录时按空态处理：不给空包，只给说明。
export function runRelocateExport(now: Date = new Date()): RelocateExportResult {
  const rows = listRows('relocate')
  const ledger = readLedger()
  const stamp = now.toISOString()

  const newSuccess: SettledHousehold[] = []
  const newFailed: FailedExport[] = []
  let skipped = 0

  for (const row of rows) {
    const code = String(row[CODE_FIELD] ?? '').trim()
    const successKey = code !== '' ? code : `#${row.id}`

    // 同一搬迁编号只认第一次成功的结果：整包或重试时直接跳过，不再出第二份半截文件。
    if (ledger.success[successKey]) {
      skipped += 1
      continue
    }

    const reading = readHouseholds(row[HOUSEHOLD_FIELD])
    if (!reading.valid) {
      // 缺项兜底：缺/非法的单独拎进失败列表，下一轮重试只重跑它们，不连累其余安置单。
      newFailed.push({
        rowId: Number(row.id),
        code: code || `#${row.id}`,
        reason: reading.reason,
        exportedAt: stamp,
      })
      continue
    }

    const settled: SettledHousehold = {
      rowId: Number(row.id),
      code: code || `#${row.id}`,
      hazard: String(row[HAZARD_FIELD] ?? ''),
      households: reading.value,
      location: String(row[LOCATION_FIELD] ?? ''),
      settledAt: stamp,
    }
    newSuccess.push(settled)
    ledger.success[successKey] = settled
  }

  // 失败列表每轮按当前数据整体重算：重试转成功的自动摘出，对应安置单被删掉的也自然清掉。
  ledger.failed = newFailed
  persistLedger(ledger)

  const downloadable = newSuccess.length > 0
  let message: string
  if (rows.length === 0) {
    message = '暂无避险搬迁记录可导出（空态：未生成空包），登记安置单后再导出'
  } else if (!downloadable) {
    if (skipped > 0) {
      message = `已成功导出的 ${skipped} 张安置单沿用首次结果不再重出；${newFailed.length} 张涉及户数缺失/非法，已单独列出，修正后点导出重试`
    } else {
      message = `本次没有可导出的安置单：${newFailed.length} 张涉及户数缺失/非法，已单独列出，修正后点导出重试（未生成空包）`
    }
  } else {
    message = `本次导出 ${newSuccess.length} 张安置单`
    if (skipped > 0) {
      message += `；${skipped} 张重复导出的安置单只认第一次结果，已跳过`
    }
    if (newFailed.length > 0) {
      message += `；另有 ${newFailed.length} 张涉及户数缺失/非法未入包，已单独列出待重试`
    }
  }

  if (!downloadable) {
    return {
      filename: '',
      content: '',
      newSuccess: [],
      downloadable: false,
      failed: newFailed,
      skipped,
      total: rows.length,
      message,
    }
  }

  // 出包字段与列表保持一致；只有本轮新成功的入包，重试不重复已成功的。
  const fields = [
    CODE_FIELD,
    HAZARD_FIELD,
    HOUSEHOLD_FIELD,
    '安置方式',
    LOCATION_FIELD,
    '签订日期',
    '完成日期',
    '搬迁状态',
  ]
  const header = ['编号', ...fields, '当前状态']
  const byId = new Map(rows.map((row) => [Number(row.id), row]))
  const lines = [header.map(csvCell).join(',')]
  for (const settled of newSuccess) {
    const row = byId.get(settled.rowId)
    if (!row) {
      continue
    }
    lines.push(
      [row.id, ...fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','),
    )
  }

  const pad = (value: number) => String(value).padStart(2, '0')
  const filename = `避险搬迁-清单-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`

  return {
    filename,
    content: `﻿${lines.join('\n')}`,
    newSuccess,
    downloadable: true,
    failed: newFailed,
    skipped,
    total: rows.length,
    message,
  }
}
