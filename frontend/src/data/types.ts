/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 环节是否为单向固定次序流转（如搬迁：待签订→已签订→搬迁中→已完成）。
  orderedFlow?: boolean
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 避险搬迁导出：涉及户数的合法范围，超出范围（含缺失/非法）一律按无效处理。
export const RELOCATE_HOUSEHOLD_MIN = 1
export const RELOCATE_HOUSEHOLD_MAX = 9999

// 导出收尾落进预警发布台账的「已安置户」记录：字段只从安置单复制，不再存第二份口径。
export type SettledHousehold = {
  rowId: number
  code: string
  hazard: string
  households: number
  location: string
  settledAt: string
}

// 上一轮没导成的安置单（涉及户数缺失或非法）：重试时只重跑这些。
export type FailedExport = {
  rowId: number
  code: string
  reason: string
  exportedAt: string
}

export type RelocateExportResult = {
  filename: string
  content: string
  newSuccess: SettledHousehold[]
  // 本轮新成功的才给下载；一条都没有时不出空包。
  downloadable: boolean
  failed: FailedExport[]
  skipped: number
  total: number
  message: string
}
