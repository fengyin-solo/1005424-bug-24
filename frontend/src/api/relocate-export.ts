import { moduleMeta } from '@/api/local-service'
import { listRows, readJson, writeJson } from '@/data/local-store'
import {
  CODE_FIELD,
  HOUSEHOLD_FIELD,
  RELOCATE_STATUSES,
  parseHouseholds,
  type WarningLedgerEntry,
} from '@/data/relocate'
import type { EntryRow } from '@/data/types'

// 搬迁导出批次、编号去重台账、预警联动台账持久化在这两个 key 下，与业务记录分开存。
const EXPORT_STATE_KEY = 'geohazard-patrol:relocate-export'
const WARNING_LEDGER_KEY = 'geohazard-patrol:warning-relocate-ledger'

export const RELOCATE_FILENAME = '避险搬迁-清单.csv'
const BOM = String.fromCharCode(0xFEFF)
export type RelocateExportFailure = {
  id: number
  code: string
  reason: string
}

export type RelocateExportResult = {
  batchId: string
  mode: 'full' | 'retry'
  exportedAt: string
  totalRows: number
  exported: number
  reused: number
  invalid: number
  skippedDuplicates: number
  settledAdded: number
  failures: RelocateExportFailure[]
  packageCodes: string[]
  // empty：按空态处理，不给空包；noop：没有新结果，沿用第一次结果，不重复出包。
  empty: boolean
  noop: boolean
  message: string
  filename: string
}

// 每个搬迁编号第一次成功导出时的快照：之后重复导出、重试都以它为准，保证同一编号只认第一次。
type ExportLedgerItem = {
  code: string
  id: number
  fields: EntryRow
  csvLine: string
  batchId: string
  exportedAt: string
}

type RelocateExportState = {
  ledger: ExportLedgerItem[]
  lastResult: RelocateExportResult | null
  seq: number
}

function emptyState(): RelocateExportState {
  return { ledger: [], lastResult: null, seq: 0 }
}

function loadState(): RelocateExportState {
  const state = readJson<RelocateExportState>(EXPORT_STATE_KEY, emptyState())
  return {
    ledger: Array.isArray(state.ledger) ? state.ledger : [],
    lastResult: state.lastResult ?? null,
    seq: typeof state.seq === 'number' ? state.seq : 0,
  }
}

function saveState(state: RelocateExportState): void {
  writeJson(EXPORT_STATE_KEY, state)
}

export function lastExportResult(): RelocateExportResult | null {
  return loadState().lastResult
}

export function loadWarningLedger(): WarningLedgerEntry[] {
  const ledger = readJson<WarningLedgerEntry[]>(WARNING_LEDGER_KEY, [])
  return Array.isArray(ledger) ? ledger : []
}

// 预警发布台账里由搬迁导出联动出的「已安置户」条数与户数合计。
export function warningLedgerSummary(): { count: number; households: number } {
  const ledger = loadWarningLedger()
  return {
    count: ledger.length,
    households: ledger.reduce((sum, item) => sum + item.households, 0),
  }
}

function saveWarningLedger(ledger: WarningLedgerEntry[]): void {
  writeJson(WARNING_LEDGER_KEY, ledger)
}

// 整包导出进行中时锁一道，重复点不会再堆出第二份（哪怕是半截的）文件。
let inFlight = false

export function isRelocateExporting(): boolean {
  return inFlight
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function nextBatchId(state: RelocateExportState): string {
  state.seq += 1
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `BN-${stamp}-${state.seq}`
}

function buildCsvLine(id: number, row: EntryRow): string {
  const meta = moduleMeta('relocate')
  return [id, ...meta.fields.map((field) => row[field] ?? '')].map(csvCell).join(',')
}

type CandidateOutcome =
  | { kind: 'exported'; item: ExportLedgerItem }
  | { kind: 'reused'; item: ExportLedgerItem }
  | { kind: 'duplicate'; code: string }
  | { kind: 'failure'; failure: RelocateExportFailure }

function processCandidate(
  row: EntryRow,
  ledgerByCode: Map<string, ExportLedgerItem>,
  batchId: string,
  exportedAt: string,
): CandidateOutcome {
  const code = String(row[CODE_FIELD] ?? '').trim()
  if (!code) {
    return { kind: 'failure', failure: { id: Number(row.id), code: '(无编号)', reason: '搬迁编号缺失，无法核对去重' } }
  }
  const existing = ledgerByCode.get(code)
  if (existing) {
    // 同一搬迁编号只认第一次：原单重复导出 → 复用第一次快照；另一单盗用同号 → 判为重复，不带进包。
    return existing.id === Number(row.id)
      ? { kind: 'reused', item: existing }
      : { kind: 'duplicate', code }
  }
  const parsed = parseHouseholds(row[HOUSEHOLD_FIELD])
  if (!parsed.valid) {
    return { kind: 'failure', failure: { id: Number(row.id), code, reason: parsed.reason } }
  }
  const item: ExportLedgerItem = {
    code,
    id: Number(row.id),
    fields: { ...row },
    csvLine: buildCsvLine(Number(row.id), row),
    batchId,
    exportedAt,
  }
  ledgerByCode.set(code, item)
  return { kind: 'exported', item }
}

function triggerDownload(filename: string, content: string): void {
  if (typeof document === 'undefined') {
    return
  }
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function blankResult(mode: 'full' | 'retry'): RelocateExportResult {
  return {
    batchId: '',
    mode,
    exportedAt: '',
    totalRows: 0,
    exported: 0,
    reused: 0,
    invalid: 0,
    skippedDuplicates: 0,
    settledAdded: 0,
    failures: [],
    packageCodes: [],
    empty: false,
    noop: true,
    message: '',
    filename: RELOCATE_FILENAME,
  }
}

export function runRelocateExport(mode: 'full' | 'retry'): RelocateExportResult {
  if (inFlight) {
    return {
      ...(lastExportResult() ?? blankResult(mode)),
      noop: true,
      message: '上一整包还在导出中，本次点击已忽略，不会重复出包',
    }
  }
  inFlight = true
  try {
    return executeExport(mode)
  } finally {
    inFlight = false
  }
}

function executeExport(mode: 'full' | 'retry'): RelocateExportResult {
  const state = loadState()
  const batchId = nextBatchId(state)
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })

  const rows = listRows('relocate')
  const previousFailures = state.lastResult?.failures ?? []

  // 重试只跑上次没成的；整包导出跑当前全部记录。
  let candidates: EntryRow[]
  if (mode === 'retry') {
    const failedIds = new Set(previousFailures.map((failure) => failure.id))
    candidates = rows.filter((row) => failedIds.has(Number(row.id)))
  } else {
    candidates = [...rows]
  }

  // 整包导出时，上一批失败记录若已被删除则直接销账；重试时旧失败项整体重算，不在这预填。
  const liveIds = new Set(rows.map((row) => Number(row.id)))
  const failures: RelocateExportFailure[] =
    mode === 'full' ? previousFailures.filter((failure) => liveIds.has(failure.id)) : []

  const ledgerByCode = new Map(state.ledger.map((item) => [item.code, item]))
  const newItems: ExportLedgerItem[] = []
  let exported = 0
  let reused = 0
  let skippedDuplicates = 0

  for (const row of candidates) {
    let outcome: CandidateOutcome
    try {
      outcome = processCandidate(row, ledgerByCode, batchId, exportedAt)
    } catch (error) {
      outcome = {
        kind: 'failure',
        failure: {
          id: Number(row.id),
          code: String(row[CODE_FIELD] ?? '').trim() || '(无编号)',
          reason: error instanceof Error ? `导出异常：${error.message}` : '导出异常',
        },
      }
    }
    switch (outcome.kind) {
      case 'exported':
        exported += 1
        newItems.push(outcome.item)
        break
      case 'reused':
        reused += 1
        break
      case 'duplicate':
        skippedDuplicates += 1
        break
      case 'failure': {
        // 同一记录去重后只保留最新一条失败原因。
        const index = failures.findIndex((failure) => failure.id === outcome.failure.id)
        if (index >= 0) {
          failures[index] = outcome.failure
        } else {
          failures.push(outcome.failure)
        }
        break
      }
    }
  }

  if (newItems.length > 0) {
    state.ledger.push(...newItems)
  }

  // 导出收尾驱动预警发布台账：第一次导出时状态为「已完成」的安置单，联动一条已安置户，编号去重。
  const warningLedger = loadWarningLedger()
  const settledCodes = new Set(warningLedger.map((item) => item.code))
  let settledAdded = 0
  for (const item of newItems) {
    const status = String(item.fields.status)
    const parsed = parseHouseholds(item.fields[HOUSEHOLD_FIELD])
    if (status === RELOCATE_STATUSES[3] && parsed.valid && !settledCodes.has(item.code)) {
      warningLedger.push({
        code: item.code,
        hazardPoint: String(item.fields['所属隐患点'] ?? ''),
        households: parsed.value,
        status,
        batchId: item.batchId,
        exportedAt: item.exportedAt,
      })
      settledCodes.add(item.code)
      settledAdded += 1
    }
  }
  saveWarningLedger(warningLedger)

  // 包内内容全部按搬迁编号取自首次导出快照，顺序跟随当前清单；已删除的记录不再出现在包里。
  const packageCodes: string[] = []
  const packaged = new Set<string>()
  for (const row of rows) {
    const code = String(row[CODE_FIELD] ?? '').trim()
    if (!code || packaged.has(code)) {
      continue
    }
    if (ledgerByCode.has(code)) {
      packageCodes.push(code)
      packaged.add(code)
    }
  }

  let empty = false
  let noop = false
  let message: string

  if (rows.length === 0) {
    empty = true
    message = '当前没有任何搬迁安置单记录，按空态处理，未生成空包；登记安置单后再导出。'
  } else if (packageCodes.length === 0) {
    empty = true
    message =
      `本次没有可导出的安置单：${failures.length} 单涉及户数缺失或非法，已单独列出，` +
      '修正后点「重试失败项」即可；按空态处理，未生成空包。'
  } else if (exported === 0 && mode === 'full') {
    // 没有新增成果就不再落第二份文件：内容只认第一次，缺项请走「重试失败项」。
    noop = true
    message =
      `全部 ${packageCodes.length} 个可导出编号此前均已出包，以第一次结果为准，本次不重复出包` +
      (failures.length > 0
        ? `；另有 ${failures.length} 单涉及户数缺失或非法，修正后点「重试失败项」`
        : '') +
      '。'
  } else if (exported === 0 && mode === 'retry') {
    noop = failures.length === 0
    message =
      failures.length === 0
        ? '没有需要重试的失败项。'
        : `重试完成，仍有 ${failures.length} 单涉及户数缺失或非法，已保留在失败清单，未重复出包。`
  } else {
    const meta = moduleMeta('relocate')
    const header = ['编号', ...meta.fields].map(csvCell).join(',')
    const lines = packageCodes.map((code) => ledgerByCode.get(code)?.csvLine ?? '')
    triggerDownload(RELOCATE_FILENAME, `${BOM}${[header, ...lines].join('\n')}`)
    const notes: string[] = [`整包已导出 ${packageCodes.length} 单（本次新增 ${exported} 单）`]
    if (reused > 0) {
      notes.push(`沿用首次结果 ${reused} 单`)
    }
    if (skippedDuplicates > 0) {
      notes.push(`重复编号跳过 ${skippedDuplicates} 单`)
    }
    if (failures.length > 0) {
      notes.push(`${failures.length} 单涉及户数缺失或非法，已单独拎出、未进包，可修正后重试`)
    }
    message = notes.join('；') + '。'
  }

  const result: RelocateExportResult = {
    batchId,
    mode,
    exportedAt,
    totalRows: rows.length,
    exported,
    reused,
    invalid: failures.length,
    skippedDuplicates,
    settledAdded,
    failures,
    packageCodes,
    empty,
    noop,
    message,
    filename: RELOCATE_FILENAME,
  }
  state.lastResult = result
  saveState(state)
  return result
}
