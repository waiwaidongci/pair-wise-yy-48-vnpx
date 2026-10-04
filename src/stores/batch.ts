import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useLinkageStore } from './linkage'
import { buildSchedule, type ScheduledEntry, type ScheduleResult } from '../lib/batchScheduler'

const STORAGE_KEY = 'fire-linkage-batch-v1'
const CAP_KEY_PREFIX = 'fire-linkage-floor-capacity-v1:'
const COMMIT_WINDOW_MS = 3000

/** 写盘适配器：localStorage 配额满 / 隐私模式时会抛错，模拟现场写盘失败 */
export const disk = {
  write(key: string, value: string) {
    if (simulateFaults.value) throw new Error('现场存储不可用（模拟写盘失败）')
    localStorage.setItem(key, value)
  },
  read(key: string) {
    return localStorage.getItem(key)
  },
  remove(key: string) {
    localStorage.removeItem(key)
  },
}

/** 测试/演练开关：打开后所有写盘直接失败，用于验证断点恢复 */
export const simulateFaults = ref(false)

export type QueueStatus = 'empty' | 'valid' | 'invalidated' | 'write-failed'
export type CommitState = 'queued' | 'committed' | 'conflict'

export interface CapacityCommit {
  id: string
  floor: string
  capacityKw: number
  operator: string
  submittedAt: number
  state: CommitState
  /** 冲突时保留的后来者现场值 */
  conflictWith?: string
  conflictReason?: string
}

export interface QueueRecord {
  id: string
  triggerIds: string[]
  capacities: Record<string, number>
  schedule: ScheduleResult
  createdAt: number
  /** 失效签名：设备换层、容量或规则一变，队列立即失效 */
  signature: string
  status: QueueStatus
  /** 已完成动作（断点恢复用，不重做） */
  completed: ScheduledEntry[]
  /** 本次会话已推进到的动作时刻 */
  cursorTime: number
  writeError: string | null
  /** 失效原因列表 */
  invalidations: string[]
}

interface PersistedQueue {
  queue: Omit<QueueRecord, 'schedule'> & { schedule: ScheduleResult }
  pendingWrite: boolean
  updatedAt: number
}

/**
 * 失效签名：纳入规则内容、动作设备的楼层/类型、选定报警点与楼层容量。
 * 任一字段变化都会得到不同签名，旧队列立即作废并重算。
 */
export function computeSignature(
  triggerIds: string[],
  capacities: Record<string, number>,
  devices: { id: string; floor: string; type: string }[],
  rules: { id: string; enabled: boolean; triggerId: string; actionId: string; delay: number; priority: number; interlock: string }[],
): string {
  const rulePart = rules
    .map((rule) => `${rule.id}:${rule.enabled ? 1 : 0}:${rule.triggerId}>${rule.actionId}:d${rule.delay}:p${rule.priority}:${rule.interlock}`)
    .sort()
    .join('|')
  const triggerSet = new Set(triggerIds)
  const devicePart = devices
    .filter((device) => triggerSet.has(device.id) || rules.some((rule) => triggerSet.has(rule.triggerId) && rule.actionId === device.id))
    .map((device) => `${device.id}@${device.floor}/${device.type}`)
    .sort()
    .join('|')
  const triggerPart = [...triggerIds].sort().join(',')
  const capPart = Object.entries(capacities)
    .map(([floor, kw]) => `${floor}=${kw}`)
    .sort()
    .join(',')
  return [triggerPart, capPart, devicePart, rulePart].join('||')
}

function loadPersisted(): PersistedQueue | null {
  try {
    const raw = disk.read(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PersistedQueue) : null
  }
  catch {
    return null
  }
}

export const useBatchStore = defineStore('batchQueue', () => {
  const linkage = useLinkageStore()
  const devices = computed(() => linkage.devices)
  const rules = computed(() => linkage.rules)
  const floors = computed(() => [...new Set(devices.value.map((device) => device.floor))].sort())
  const triggerDevices = computed(() =>
    devices.value.filter((device) => ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块'].includes(device.type)),
  )

  const selectedTriggerIds = ref<string[]>([])
  const capacities = ref<Record<string, number>>({})
  const operator = ref('调试员甲')
  const initialized = ref(false)

  const queue = ref<QueueRecord | null>(null)
  const pendingWrite = ref(false)
  const commits = ref<CapacityCommit[]>([])
  const lastPersistAt = ref<number | null>(null)
  const lastRecoveredAt = ref<number | null>(null)
  const writeRetries = ref(0)
  const notice = ref<string | null>(null)

  function defaultCapacities(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const floor of floors.value) result[floor] = 8
    return result
  }

  /** 启动恢复：读回写盘失败后留下的断点，已完成动作不重做 */
  function init() {
    if (initialized.value) return
    initialized.value = true
    capacities.value = defaultCapacities()
    commits.value = loadCommits()
    const persisted = loadPersisted()
    if (!persisted) return
    const record = persisted.queue
    selectedTriggerIds.value = record.triggerIds
    capacities.value = { ...record.capacities }
    const currentSignature = computeSignature(record.triggerIds, record.capacities, devices.value, rules.value)
    if (currentSignature !== record.signature) {
      // 设备换层 / 容量 / 规则在离线期间变化：旧队列作废，按新现场重算，已完成动作不重做
      queue.value = { ...record, status: 'invalidated', writeError: null }
      recompute('invalidated', diffSignature(record.signature, currentSignature))
      writeSnapshot(false)
    }
    else {
      queue.value = { ...record, status: persisted.pendingWrite ? 'write-failed' : 'valid', writeError: persisted.pendingWrite ? '上次写盘中断，已从断点恢复，已完成动作不重做' : null }
      if (persisted.pendingWrite) lastRecoveredAt.value = persisted.updatedAt
    }
    lastPersistAt.value = persisted.updatedAt
  }

  function recompute(statusOverride?: QueueStatus, invalidations?: string[]): ScheduleResult | null {
    if (!queue.value) return null
    const completed = queue.value.completed
    const schedule = buildSchedule(
      { triggerIds: queue.value.triggerIds, devices: devices.value, rules: rules.value, capacities: queue.value.capacities },
      completed,
    )
    queue.value = {
      ...queue.value,
      schedule,
      signature: computeSignature(queue.value.triggerIds, queue.value.capacities, devices.value, rules.value),
      status: statusOverride ?? 'valid',
      invalidations: invalidations ?? [],
    }
    return schedule
  }

  /** 任何编辑后调用：签名变化 → 旧队列立即失效并按新现场重算 */
  function reconcile() {
    if (!initialized.value || !queue.value) return
    const current = computeSignature(queue.value.triggerIds, queue.value.capacities, devices.value, rules.value)
    if (current === queue.value.signature) return
    const reasons = diffSignature(queue.value.signature, current)
    // 已完成动作是现场事实：换层/容量/规则变化后旧队列失效，但已完成动作仍按实际时刻计入重算结果，不重做
    recompute('invalidated', reasons)
    writeSnapshot(false)
  }

  function createQueue(): ScheduleResult | null {
    if (selectedTriggerIds.value.length === 0) {
      notice.value = '请先选定报警点'
      return null
    }
    const schedule = buildSchedule(
      { triggerIds: selectedTriggerIds.value, devices: devices.value, rules: rules.value, capacities: capacities.value },
      [],
    )
    queue.value = {
      id: `BQ-${Date.now()}`,
      triggerIds: [...selectedTriggerIds.value],
      capacities: { ...capacities.value },
      schedule,
      createdAt: Date.now(),
      signature: computeSignature(selectedTriggerIds.value, capacities.value, devices.value, rules.value),
      status: 'valid',
      completed: [],
      cursorTime: 0,
      writeError: null,
      invalidations: [],
    }
    writeSnapshot(false)
    return schedule
  }

  /** 容量变更入口：受提交窗口保护，同一楼层几乎同时提交时只采用更早的一份 */
  function submitCapacity(floor: string, kw: number, who: string): 'committed' | 'conflict' {
    const now = Date.now()
    const recent = commits.value.find(
      (commit) => commit.floor === floor && commit.state === 'committed' && now - commit.submittedAt < COMMIT_WINDOW_MS,
    )
    const id = `CAP-${now}-${Math.random().toString(36).slice(2, 6)}`
    if (recent) {
      const conflict: CapacityCommit = {
        id,
        floor,
        capacityKw: kw,
        operator: who,
        submittedAt: now,
        state: 'conflict',
        conflictWith: recent.id,
        conflictReason: `与 ${recent.operator} 于 ${new Date(recent.submittedAt).toLocaleTimeString()} 提交的 ${recent.capacityKw}kW 冲突：本层容量已采用更早的一份，现场值 ${kw}kW 保留待裁决`,
      }
      commits.value.unshift(conflict)
      persistCommits()
      notice.value = conflict.conflictReason!
      return 'conflict'
    }
    commits.value.unshift({ id, floor, capacityKw: kw, operator: who, submittedAt: now, state: 'committed' })
    persistCommits()
    capacities.value = { ...capacities.value, [floor]: kw }
    if (queue.value) {
      // 同步队列容量快照，再由签名比对驱动失效重算
      queue.value = { ...queue.value, capacities: { ...capacities.value } }
      reconcile()
    }
    return 'committed'
  }

  function resolveConflict(id: string, adopt: boolean) {
    const commit = commits.value.find((item) => item.id === id)
    if (!commit || commit.state !== 'conflict') return
    if (adopt) {
      const winner = commits.value.find((item) => item.id === commit.conflictWith)
      if (winner) commit.conflictReason = `${commit.conflictReason}；裁决：采用后来者现场值 ${commit.capacityKw}kW（${commit.operator}）`
      capacities.value = { ...capacities.value, [commit.floor]: commit.capacityKw }
      commit.state = 'committed'
      if (queue.value) {
        queue.value = { ...queue.value, capacities: { ...capacities.value } }
        reconcile()
      }
    }
    else {
      commit.state = 'committed'
      commit.conflictReason = `${commit.conflictReason}；裁决：维持更早的一份 ${commit.capacityKw}kW 以现场复核为准`
    }
    persistCommits()
  }

  /**
   * 模拟推进：把时刻推进到下一个有动作的批次并执行；外部互锁需人工确认。
   * 断点协议：先写“推进前断点(pendingWrite=true)”→ 再执行动作 → 再写“已确认(pendingWrite=false)”。
   * 写盘失败时不推进、不假报完成；中断后 init() 从断点恢复，已完成动作绝不重做。
   */
  function advance(confirmExternal = false) {
    if (!queue.value || queue.value.status === 'invalidated') return
    if (queue.value.status === 'write-failed') {
      notice.value = '写盘尚未恢复，不能推进新动作，避免在无断点情况下执行'
      return
    }
    const entries = queue.value.schedule.entries
    // 推进到下一个有待执行动作的时刻（外部互锁动作未确认时跳过）
    let cursor = queue.value.cursorTime
    let aboutToRun = entries.filter((entry) => entry.state === 'pending' && entry.plannedAt <= cursor && (!entry.externalInterlock || confirmExternal))
    if (aboutToRun.length === 0) {
      const nextTimes = entries
        .filter((entry) => entry.state === 'pending' && (!entry.externalInterlock || confirmExternal))
        .map((entry) => entry.plannedAt)
      if (nextTimes.length === 0) return
      cursor = Math.min(...nextTimes)
      aboutToRun = entries.filter((entry) => entry.state === 'pending' && entry.plannedAt <= cursor && (!entry.externalInterlock || confirmExternal))
    }
    if (aboutToRun.length === 0) return
    if (!writeSnapshot(true)) return // 断点写盘失败：本次动作不执行
    queue.value.cursorTime = cursor
    for (const entry of aboutToRun) {
      entry.state = 'running'
      entry.startedAt = cursor
    }
    // 同一节拍内动作完成（关键动作即使超额也照常启动完成）
    for (const entry of aboutToRun) {
      entry.state = 'done'
      entry.completedAt = cursor
      if (!queue.value.completed.some((done) => done.actionId === entry.actionId)) {
        queue.value.completed.push({ ...entry })
      }
    }
    const nextTimes = entries.filter((entry) => entry.state === 'pending').map((entry) => entry.plannedAt)
    if (nextTimes.length) queue.value.cursorTime = Math.min(...nextTimes)
    writeSnapshot(false)
  }

  function confirmExternalAndAdvance() {
    advance(true)
  }

  /**
   * 写盘：成功返回 true；失败时保留上一份成功快照（localStorage 未被覆盖），
   * 内存态标记 write-failed；恢复后从断点继续，已完成动作不重做。
   */
  function writeSnapshot(pendingWriteFlag: boolean): boolean {
    if (!queue.value) return false
    const payload: PersistedQueue = {
      queue: JSON.parse(JSON.stringify(queue.value)) as PersistedQueue['queue'],
      pendingWrite: pendingWriteFlag,
      updatedAt: Date.now(),
    }
    try {
      disk.write(STORAGE_KEY, JSON.stringify(payload))
      pendingWrite.value = pendingWriteFlag
      lastPersistAt.value = payload.updatedAt
      if (!pendingWriteFlag) {
        writeRetries.value = 0
        if (queue.value.status === 'write-failed') queue.value.status = 'valid'
        queue.value.writeError = null
      }
      return true
    }
    catch (error) {
      pendingWrite.value = true
      queue.value.status = 'write-failed'
      queue.value.writeError = error instanceof Error ? error.message : '写盘失败，断点已保留（维持上一份成功快照）'
      writeRetries.value += 1
      return false
    }
  }

  /** 故障恢复后重试写盘 */
  function retryPersist() {
    if (!queue.value) return
    if (writeSnapshot(false)) notice.value = '写盘恢复，断点已确认，可继续推进'
  }

  /** 演练：从磁盘断点重新装载（模拟写盘中断后刷新/重开页面），已完成动作不重做 */
  function reloadFromCheckpoint() {
    initialized.value = false
    queue.value = null
    init()
  }

  function clearQueue() {
    queue.value = null
    pendingWrite.value = false
    disk.remove(STORAGE_KEY)
  }

  function persistCommits() {
    disk.write(`${CAP_KEY_PREFIX}${operator.value}`, JSON.stringify(commits.value))
  }

  function loadCommits(): CapacityCommit[] {
    try {
      const raw = disk.read(`${CAP_KEY_PREFIX}${operator.value}`)
      return raw ? (JSON.parse(raw) as CapacityCommit[]) : []
    }
    catch {
      return []
    }
  }

  const allDone = computed(() => queue.value?.schedule.entries.every((entry) => entry.state === 'done') ?? false)
  const pendingExternal = computed(() => queue.value?.schedule.entries.filter((entry) => entry.state === 'pending' && entry.externalInterlock) ?? [])

  // 设备换层、容量（submitCapacity 内）或规则一变，已有队列立即失效并重算
  watch([devices, rules], () => reconcile(), { deep: true, flush: 'sync' })

  return {
    floors,
    triggerDevices,
    selectedTriggerIds,
    capacities,
    operator,
    queue,
    commits,
    pendingWrite,
    lastPersistAt,
    lastRecoveredAt,
    writeRetries,
    notice,
    allDone,
    pendingExternal,
    simulateFaults,
    init,
    createQueue,
    reconcile,
    submitCapacity,
    resolveConflict,
    advance,
    confirmExternalAndAdvance,
    retryPersist,
    reloadFromCheckpoint,
    clearQueue,
    writeSnapshot,
  }
})

/** 对比两个签名，给出人可读的失效原因 */
function diffSignature(oldSig: string, newSig: string): string[] {
  const reasons: string[] = []
  const [oldTrigger, oldCap, oldDevice, oldRule] = oldSig.split('||')
  const [, newCap, newDevice, newRule] = newSig.split('||')
  if (oldCap !== newCap) reasons.push('楼层供电容量已变更')
  const oldDeviceMap = new Map(oldDevice.split('|').filter(Boolean).map((part) => part.split(/[@/]/).slice(0, 2) as [string, string]).map(([id, floor]) => [id, floor]))
  for (const part of newDevice.split('|').filter(Boolean)) {
    const [id, meta] = part.split('@')
    const [floor, type] = meta.split('/')
    const before = oldDeviceMap.get(id)
    if (before && before !== floor) reasons.push(`设备 ${id} 换层（${before} → ${floor}）`)
    void type
  }
  if (oldRule !== newRule) reasons.push('联动规则（延时 / 优先级 / 互锁 / 启停）已变更')
  if (reasons.length === 0) reasons.push('报警点选择或现场配置已变更')
  return [...new Set(reasons)]
}
