import type { Device, Rule } from '../stores/linkage'

/** 关键动作：排烟、防火卷帘、疏散广播——容量不够也照常启动，只标出超额，绝不顺延 */
export const CRITICAL_DEVICE_TYPES = new Set(['排烟风机', '防火卷帘', '消防广播'])

/** 各动作设备同时启动时对楼层配电回路的占用估算（kW） */
export const DEVICE_LOAD_KW: Record<string, number> = {
  排烟风机: 5.5,
  防火卷帘: 2.2,
  消防广播: 1.5,
  电梯: 4,
  输出模块: 0.3,
  输入模块: 0.2,
}

export const DEFER_STEP_S = 5
export const MAX_DEFERS = 12

export type EntryState = 'pending' | 'running' | 'done'

export interface ScheduledEntry {
  /** 稳定标识：同一动作设备只动作一次，用动作点位 ID */
  id: string
  actionId: string
  actionName: string
  actionType: string
  floor: string
  /** 触发该动作的全部规则（按优先级、规则号排序，取主规则排程） */
  ruleIds: string[]
  triggerNames: string[]
  priority: 1 | 2 | 3
  /** 规则原始延时（主规则） */
  ruleDelay: number
  /** 互锁原文（主规则） */
  interlock: string
  critical: boolean
  loadKw: number
  /** 规划启动时刻（秒）：延时 + 互锁 + 容量顺延之后 */
  plannedAt: number
  baseDelay: number
  interlockWait: number
  deferredFrom: number | null
  deferCount: number
  /** 容量不够被排队顺延（关键设备不顺延，只标超额） */
  deferred: boolean
  /** 关键设备超额启动；非关键设备在最终时刻仍超额也会被标出 */
  overCapacity: boolean
  /** 等待外部现场反馈，模拟器中需调试员确认 */
  externalInterlock: boolean
  externalInterlockText: string
  /** 互锁环路，互锁时间无法成立，按优先级/延时排程并提示现场确认 */
  interlockCycle: boolean
  state: EntryState
  /** 已完成动作的实际启动时刻（断点恢复用） */
  startedAt: number | null
  completedAt: number | null
  note: string
}

export interface Batch {
  floor: string
  time: number
  capacityKw: number
  simultaneousKw: number
  overCapacity: boolean
  overByKw: number
  entries: string[]
}

export interface CapacityWarning {
  floor: string
  time: number
  capacityKw: number
  simultaneousKw: number
  overByKw: number
  criticalEntryIds: string[]
}

export interface ScheduleResult {
  entries: ScheduledEntry[]
  batches: Batch[]
  warnings: CapacityWarning[]
  satisfied: boolean
  totalEntries: number
  overCapacityCount: number
  deferredCount: number
  externalInterlockCount: number
  generatedAt: number
}

export interface ScheduleInput {
  triggerIds: string[]
  devices: Device[]
  rules: Rule[]
  capacities: Record<string, number>
}

interface WorkingEntry extends ScheduledEntry {
  predecessor: string | null
}

const INTERLOCK_KEYWORDS: { key: string; types: string[] }[] = [
  { key: '卷帘', types: ['防火卷帘'] },
  { key: '排烟', types: ['排烟风机'] },
  { key: '风机', types: ['排烟风机'] },
  { key: '广播', types: ['消防广播'] },
  { key: '电梯', types: ['电梯'] },
]

function byRuleOrder(a: Rule, b: Rule) {
  return a.priority - b.priority || a.delay - b.delay || a.id.localeCompare(b.id)
}

/** 解析互锁原文，找到被本报警点联动、且同楼层的前置动作设备 */
export function resolveInterlock(
  rule: Rule,
  merged: Map<string, Rule[]>,
  deviceById: Map<string, Device>,
): { predecessorActionId: string | null; external: boolean } {
  const text = (rule.interlock || '无').trim()
  if (!text || text === '无') return { predecessorActionId: null, external: false }
  const match = INTERLOCK_KEYWORDS.find((item) => text.includes(item.key))
  if (!match) return { predecessorActionId: null, external: true }
  const action = deviceById.get(rule.actionId)
  for (const [actionId, group] of merged) {
    if (actionId === rule.actionId) continue
    const candidate = deviceById.get(actionId)
    if (!candidate || (action && candidate.floor !== action.floor)) continue
    if (match.types.includes(candidate.type)) return { predecessorActionId: actionId, external: false }
    void group
  }
  // 互锁提到了设备类别，但本报警点在同楼层没有联动该设备 → 需要现场反馈
  return { predecessorActionId: null, external: true }
}

/**
 * 联动批次核算：
 * 按规则延时、互锁反馈、优先级排出动作队列；每个启动时刻按楼层核算同时动作的供电占用，
 * 容量不足时低优先级非关键动作向后顺延（每步 5s），排烟/卷帘/疏散广播照常启动并标出超额。
 * 已完成动作（来自断点）按实际启动时刻重新计入，绝不重做。
 */
export function buildSchedule(input: ScheduleInput, completed: ScheduledEntry[] = []): ScheduleResult {
  const { triggerIds, devices, rules, capacities } = input
  const deviceById = new Map(devices.map((device) => [device.id, device]))
  const triggerSet = new Set(triggerIds)

  // 同一动作设备可能被多条规则命中：合并为一次动作，主规则 = 优先级最高、延时最短
  const merged = new Map<string, Rule[]>()
  for (const rule of rules) {
    if (!rule.enabled || !triggerSet.has(rule.triggerId)) continue
    if (!deviceById.has(rule.actionId)) continue
    const group = merged.get(rule.actionId)
    if (group) group.push(rule)
    else merged.set(rule.actionId, [rule])
  }

  const completedById = new Map(completed.map((entry) => [entry.actionId, entry]))
  const entries: WorkingEntry[] = []

  for (const [actionId, group] of merged) {
    group.sort(byRuleOrder)
    const primary = group[0]
    const action = deviceById.get(actionId)!
    const triggerNames = [...new Set(group.map((rule) => deviceById.get(rule.triggerId)?.name).filter((name): name is string => Boolean(name)))]
    const done = completedById.get(actionId)
    const { predecessorActionId, external } = resolveInterlock(primary, merged, deviceById)
    // 排烟/卷帘/疏散广播即使互锁指向现场反馈也必须照常启动，只挂提示，不做等待
    const critical = CRITICAL_DEVICE_TYPES.has(action.type)
    const blockedExternal = external && !critical
    entries.push({
      id: actionId,
      actionId,
      actionName: action.name,
      actionType: action.type,
      floor: action.floor,
      ruleIds: group.map((rule) => rule.id),
      triggerNames,
      priority: primary.priority,
      ruleDelay: primary.delay,
      interlock: primary.interlock || '无',
      critical,
      loadKw: DEVICE_LOAD_KW[action.type] ?? 0.5,
      plannedAt: done?.startedAt ?? primary.delay,
      baseDelay: primary.delay,
      interlockWait: 0,
      deferredFrom: null,
      deferCount: 0,
      deferred: false,
      overCapacity: false,
      externalInterlock: blockedExternal,
      externalInterlockText: external ? primary.interlock : '',
      interlockCycle: false,
      state: done?.state === 'done' ? 'done' : 'pending',
      startedAt: done?.startedAt ?? null,
      completedAt: done?.completedAt ?? null,
      note: '',
      predecessor: predecessorActionId,
    })
  }

  // 互锁等待：沿前置链递归；链路成环时互锁时间不成立，按优先级/延时排程并标注环路
  const entryByAction = new Map(entries.map((entry) => [entry.actionId, entry]))
  function chainHasCycle(start: WorkingEntry): boolean {
    let node: WorkingEntry | undefined = start
    const seen = new Set<string>()
    while (node && node.predecessor) {
      if (seen.has(node.actionId)) return true
      seen.add(node.actionId)
      node = entryByAction.get(node.predecessor)
    }
    return false
  }
  function effectiveTime(actionId: string, stack: Set<string>): number {
    const entry = entryByAction.get(actionId)
    if (!entry) return 0
    if (entry.state === 'done') return entry.plannedAt
    if (!entry.predecessor) return entry.baseDelay
    if (stack.has(actionId)) {
      entry.interlockCycle = true
      return entry.baseDelay // 环路：互锁不成立，退回按延时排程
    }
    const nextStack = new Set(stack)
    nextStack.add(actionId)
    const predecessorTime = effectiveTime(entry.predecessor, nextStack)
    if (chainHasCycle(entry)) {
      entry.interlockCycle = true
      entry.plannedAt = entry.baseDelay
      return entry.plannedAt
    }
    entry.interlockWait = Math.max(0, predecessorTime + 1 - entry.baseDelay)
    entry.plannedAt = entry.baseDelay + entry.interlockWait
    return entry.plannedAt
  }
  for (const entry of entries) effectiveTime(entry.actionId, new Set())

  // 容量核算：按楼层贪心排程。关键设备钉死在规划时刻；非关键动作按
  // “规划时刻升序、优先级升序（P1 先放行）”逐个放入，放不下就顺延 5s 再试。
  const warnings: CapacityWarning[] = []
  const floors = [...new Set(entries.map((entry) => entry.floor))]

  for (const floor of floors) {
    const capacity = capacities[floor] ?? 0
    const floorEntries = entries.filter((entry) => entry.floor === floor)
    // 已完成动作与关键动作为固定占用，任何情况下都不移位
    const fixed = floorEntries.filter((entry) => entry.state === 'done' || entry.critical)
    const movable = floorEntries
      .filter((entry) => entry.state !== 'done' && !entry.critical)
      .sort((a, b) => a.plannedAt - b.plannedAt || a.priority - b.priority || a.id.localeCompare(b.id))

    // 互锁后继（同楼层非环路边）；前驱顺延时后继同步顺延，保持互锁先后
    const children = new Map<string, WorkingEntry[]>()
    for (const entry of movable) {
      if (!entry.predecessor || entry.interlockCycle) continue
      if (movable.some((item) => item.actionId === entry.predecessor)) {
        const list = children.get(entry.predecessor) ?? []
        list.push(entry)
        children.set(entry.predecessor, list)
      }
    }
    const originalPlanned = new Map(movable.map((entry) => [entry.actionId, entry.plannedAt]))
    function shiftChain(entry: WorkingEntry, delta: number) {
      entry.plannedAt += delta
      for (const child of children.get(entry.actionId) ?? []) shiftChain(child, delta)
    }

    const placed = new Set<string>()
    const loadAt = (time: number, self: WorkingEntry) =>
      fixed
        .filter((item) => item.plannedAt === time && item.actionId !== self.actionId)
        .reduce((sum, item) => sum + item.loadKw, 0)
      + movable
        .filter((item) => item !== self && item.plannedAt === time && placed.has(item.actionId))
        .reduce((sum, item) => sum + item.loadKw, 0)

    // 升序处理即满足互锁拓扑（后继规划时刻严格晚于前驱）；只与已排好的动作争容量
    for (const entry of movable) {
      let time = entry.plannedAt
      let guard = 0
      while (loadAt(time, entry) + entry.loadKw > capacity + 1e-9 && guard++ < MAX_DEFERS) {
        time += DEFER_STEP_S
      }
      if (time !== entry.plannedAt) shiftChain(entry, time - entry.plannedAt)
      placed.add(entry.actionId)
    }
    for (const entry of movable) {
      const original = originalPlanned.get(entry.actionId)!
      if (entry.plannedAt > original) {
        entry.deferred = true
        entry.deferredFrom = original
        entry.deferCount = (entry.plannedAt - original) / DEFER_STEP_S
      }
    }

    // 修复扫描：互锁链联动后移可能让后继落入超额时刻，逐轮继续顺延直至稳定
    let repairGuard = 0
    while (repairGuard++ < MAX_DEFERS * movable.length) {
      const victim = movable
        .filter((entry) => loadAt(entry.plannedAt, entry) + entry.loadKw > capacity + 1e-9)
        .sort((a, b) => b.priority - a.priority || b.plannedAt - a.plannedAt || b.id.localeCompare(a.id))[0]
      if (!victim) break
      shiftChain(victim, DEFER_STEP_S)
      victim.deferred = true
      victim.deferCount += 1
    }

    // 最终时刻核算：仍超额的批次整批标出（关键设备照常启动；非关键顺延到上限仍放不下也如实标记）
    const times = [...new Set(floorEntries.map((entry) => entry.plannedAt))].sort((a, b) => a - b)
    for (const time of times) {
      const simultaneous = floorEntries.filter((entry) => entry.plannedAt === time)
      const load = round1(simultaneous.reduce((sum, entry) => sum + entry.loadKw, 0))
      if (load > capacity + 1e-9) {
        const overBy = round1(load - capacity)
        const criticalIds = simultaneous.filter((entry) => entry.critical).map((entry) => entry.id)
        for (const entry of simultaneous) {
          entry.overCapacity = true
          if (!entry.note) {
            entry.note = entry.critical
              ? `${entry.actionType} 属必须立即启动动作，容量缺口 ${overBy}kW，照常启动并标出超额`
              : `所在批次容量缺口 ${overBy}kW，已顺延 ${entry.deferCount} 次仍无法满足，按超额标记，不假报已满足`
          }
        }
        warnings.push({ floor, time, capacityKw: capacity, simultaneousKw: load, overByKw: overBy, criticalEntryIds: criticalIds })
      }
    }
  }

  // 说明文字
  for (const entry of entries) {
    if (entry.interlockCycle && !entry.note) entry.note = '互锁条件与前置动作构成环路，互锁时间无法成立，按优先级/延时排程，需现场人工确认'
    if (entry.deferred && !entry.overCapacity && !entry.note) {
      entry.note = `低优先级排队：由 ${entry.deferredFrom}s 顺延至 ${entry.plannedAt}s（顺延 ${entry.deferCount} 次）`
    }
    if (entry.externalInterlock && !entry.note) entry.note = `互锁「${entry.interlock}」需现场反馈确认，确认前不启动`
    if (entry.critical && entry.externalInterlockText && !entry.note) entry.note = `关键动作照常启动；互锁「${entry.interlock}」需现场同步确认反馈`
    if (entry.state === 'done' && !entry.note) entry.note = '断点恢复：已完成动作不重做'
  }

  // 汇总批次
  const batches: Batch[] = []
  for (const floor of floors) {
    const capacity = capacities[floor] ?? 0
    const floorEntries = entries.filter((entry) => entry.floor === floor)
    const times = [...new Set(floorEntries.map((entry) => entry.plannedAt))].sort((a, b) => a - b)
    for (const time of times) {
      const simultaneous = floorEntries.filter((entry) => entry.plannedAt === time)
      const load = round1(simultaneous.reduce((sum, entry) => sum + entry.loadKw, 0))
      batches.push({
        floor,
        time,
        capacityKw: capacity,
        simultaneousKw: load,
        overCapacity: load > capacity + 1e-9,
        overByKw: Math.max(0, round1(load - capacity)),
        entries: simultaneous.map((entry) => entry.id),
      })
    }
  }
  batches.sort((a, b) => a.time - b.time || a.floor.localeCompare(b.floor))
  entries.sort((a, b) => a.plannedAt - b.plannedAt || a.priority - b.priority || a.id.localeCompare(b.id))

  const pendingExternals = entries.filter((entry) => entry.state !== 'done' && entry.externalInterlock)
  return {
    entries,
    batches,
    warnings,
    satisfied: warnings.length === 0 && pendingExternals.length === 0,
    totalEntries: entries.length,
    overCapacityCount: entries.filter((entry) => entry.overCapacity).length,
    deferredCount: entries.filter((entry) => entry.deferred).length,
    externalInterlockCount: pendingExternals.length,
    generatedAt: Date.now(),
  }
}

function round1(value: number) {
  return Math.round(value * 10) / 10
}
