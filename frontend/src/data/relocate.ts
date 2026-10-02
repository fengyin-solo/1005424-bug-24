import type { EntryRow } from './types'

// 避险搬迁环节是单向的，只能沿这个固定次序流转，不允许跨环节、不允许回退。
export const RELOCATE_STATUSES = ['待签订', '已签订', '搬迁中', '已完成'] as const

export const RELOCATE_ACTIONS = ['确认签订', '开始搬迁', '确认完成'] as const

// 动作 → 下一环节；每个环节只暴露这一个后继动作。
export const NEXT_ACTION_BY_STATUS: Record<string, (typeof RELOCATE_ACTIONS)[number] | undefined> = {
  待签订: '确认签订',
  已签订: '开始搬迁',
  搬迁中: '确认完成',
  已完成: undefined,
}

export const HOUSEHOLD_FIELD = '涉及户数'
export const CODE_FIELD = '搬迁编号'

// 涉及户数允许的业务范围：1～9999 的正整数；空着、非整数、带非数字字符、越界一律按无效处理。
export const HOUSEHOLD_MIN = 1
export const HOUSEHOLD_MAX = 9999

export type HouseholdIssue =
  | { valid: true; value: number }
  | { valid: false; value: null; reason: string }

export function parseHouseholds(raw: unknown): HouseholdIssue {
  if (raw === undefined || raw === null) {
    return { valid: false, value: null, reason: '涉及户数缺失' }
  }
  const text = String(raw).trim()
  if (text === '') {
    return { valid: false, value: null, reason: '涉及户数缺失' }
  }
  if (!/^\d+$/.test(text)) {
    return { valid: false, value: null, reason: `涉及户数非法：「${text}」不是正整数` }
  }
  const value = Number(text)
  if (value < HOUSEHOLD_MIN || value > HOUSEHOLD_MAX) {
    return { valid: false, value: null, reason: `涉及户数超出范围（${HOUSEHOLD_MIN}～${HOUSEHOLD_MAX}）：${value}` }
  }
  return { valid: true, value }
}

// 详情面板（搬迁安置单登记口径）是唯一口径来源，侧栏只镜像它，两处都用这一个函数渲染。
export function formatHouseholds(raw: unknown): string {
  const parsed = parseHouseholds(raw)
  return parsed.valid ? String(parsed.value) : '—'
}

export type RelocateStat = { label: string; value: number }

// 涉及户数无效的安置单不参与任何合计，已安置户数合计因此不会再被脏数据带偏。
export function relocateStats(rows: EntryRow[]): RelocateStat[] {
  const sum = (status: string) =>
    rows
      .filter((row) => String(row.status) === status)
      .reduce((total, row) => {
        const parsed = parseHouseholds(row[HOUSEHOLD_FIELD])
        return total + (parsed.valid ? parsed.value : 0)
      }, 0)
  return [
    { label: '待签订户数', value: sum('待签订') },
    { label: '搬迁中户数', value: sum('搬迁中') },
    { label: '已安置户数', value: sum('已完成') },
  ]
}

// 导出收尾写入预警发布侧的「搬迁安置联动台账」：同一搬迁编号只认第一次导出的结果，重复导出不追加。
export type WarningLedgerEntry = {
  code: string
  hazardPoint: string
  households: number
  status: string
  batchId: string
  exportedAt: string
}
