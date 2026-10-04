import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useLinkageStore, ESSENTIAL_LOAD_TYPES, type Device, type DeviceType, type Rule } from './linkage'

export type JobStatus = '已启动' | '排队中' | '已完成' | '超额启动'
export type ExecStatus = '待执行' | '已完成'
export type CapacityStatus = '已采用' | '已替代' | '冲突未采用'

export type BatchJob = {
  actionId: string
  actionName: string
  floor: string
  power: number
  duration: number
  priority: 1 | 2 | 3
  ruleIds: string[]
  interlocks: string[]
  essential: boolean
  baseEarliest: number
  prereqId: string | null
  travel: number
  start: number
  end: number
  started: boolean
  status: JobStatus
  overload: number
  waitReason: string
}

export type FloorLoad = {
  floor: string
  capacity: number
  peak: number
  margin: number
  overload: number
  overloaded: boolean
}

export type CapacitySubmission = {
  id: string
  floor: string
  capacity: number
  by: string
  at: number
  status: CapacityStatus
}

const CONCURRENCY_WINDOW = 10_000
const BATCH_DRAFT_KEY = 'fire-linkage-batch-v1'

function interlockExternalDelay(interlock: string): number {
  if (!interlock || interlock === '无') return 0
  if (interlock.includes('防火阀')) return 5
  if (interlock.includes('轿厢')) return 8
  return 0
}

function interlockPrereq(interlock: string, batchActions: Device[]): { prereqId: string | null; travel: number } {
  if (!interlock || interlock === '无') return { prereqId: null, travel: 0 }
  if (interlock.includes('卷帘')) {
    const shutter = batchActions.find((device) => device.type === '防火卷帘')
    return { prereqId: shutter?.id ?? null, travel: 15 }
  }
  if (interlock.includes('排烟风机')) {
    const fan = batchActions.find((device) => device.type === '排烟风机')
    return { prereqId: fan?.id ?? null, travel: 0 }
  }
  return { prereqId: null, travel: 0 }
}

function breakCycles(jobs: BatchJob[]) {
  const order = new Map(jobs.map((job, index) => [job.actionId, index]))
  const byId = new Map(jobs.map((job) => [job.actionId, job]))
  for (const job of jobs) {
    const path: string[] = []
    let cur: string | null = job.actionId
    while (cur) {
      if (path.includes(cur)) {
        const cycle = path.slice(path.indexOf(cur))
        let dropNode = cycle[0]
        for (const node of cycle) {
          if ((order.get(node) ?? -1) > (order.get(dropNode) ?? -1)) dropNode = node
        }
        const dropJob = byId.get(dropNode)
        if (dropJob) dropJob.prereqId = null
        break
      }
      path.push(cur)
      cur = byId.get(cur)?.prereqId ?? null
    }
  }
}

function scheduleJobs(jobs: BatchJob[], floorCapacity: Record<string, number>): { jobs: BatchJob[]; floorLoads: FloorLoad[] } {
  const byId = new Map(jobs.map((job) => [job.actionId, job]))
  const remaining = new Set(jobs.map((job) => job.actionId))
  const running: BatchJob[] = []
  const overloadByFloor = new Map<string, number>()
  let t = 0
  let guard = 0

  while (remaining.size > 0 && guard < 10000) {
    guard += 1
    for (const job of [...running]) {
      if (job.end <= t) {
        job.status = '已完成'
        running.splice(running.indexOf(job), 1)
      }
    }

    const effectiveEarliest = (job: BatchJob) => {
      const prereq = job.prereqId ? byId.get(job.prereqId) : undefined
      if (prereq && !prereq.started) return Number.POSITIVE_INFINITY
      return Math.max(job.baseEarliest, prereq ? prereq.start + job.travel : 0)
    }
    const ready = jobs.filter((job) => remaining.has(job.actionId) && effectiveEarliest(job) <= t)
    ready.sort((a, b) => a.priority - b.priority || a.baseEarliest - b.baseEarliest || a.actionId.localeCompare(b.actionId))

    for (const job of ready) {
      const cap = floorCapacity[job.floor] ?? Infinity
      const load = running.filter((item) => item.floor === job.floor).reduce((sum, item) => sum + item.power, 0)
      if (load + job.power <= cap) {
        job.start = Math.max(t, effectiveEarliest(job))
        job.end = job.start + job.duration
        job.started = true
        job.status = '已启动'
        running.push(job)
        remaining.delete(job.actionId)
      } else if (job.essential) {
        job.start = Math.max(t, effectiveEarliest(job))
        job.end = job.start + job.duration
        job.started = true
        job.status = '超额启动'
        job.overload = load + job.power - cap
        overloadByFloor.set(job.floor, Math.max(overloadByFloor.get(job.floor) ?? 0, job.overload))
        running.push(job)
        remaining.delete(job.actionId)
      } else {
        job.waitReason = `${job.floor} 容量 ${cap}kW，当前已用 ${load}kW，${job.power}kW 无法接入，排队等待容量释放`
      }
    }

    if (remaining.size === 0) break

    let nextEvent = Infinity
    for (const job of running) nextEvent = Math.min(nextEvent, job.end)
    for (const job of jobs) {
      if (!remaining.has(job.actionId)) continue
      const prereq = job.prereqId ? byId.get(job.prereqId) : undefined
      const eff = Math.max(job.baseEarliest, prereq?.started ? prereq.start + job.travel : -Infinity)
      if (eff > t) nextEvent = Math.min(nextEvent, eff)
    }
    if (!Number.isFinite(nextEvent) || nextEvent <= t) {
      for (const job of jobs) {
        if (remaining.has(job.actionId)) {
          job.status = '排队中'
          job.waitReason = job.waitReason || '容量不足且无运行设备释放容量，无法启动'
        }
      }
      break
    }
    t = nextEvent
  }

  for (const job of jobs) {
    if (remaining.has(job.actionId)) job.status = '排队中'
  }

  const floorSet = new Set(jobs.map((job) => job.floor))
  const floorLoads: FloorLoad[] = [...floorSet].map((floor) => {
    const cap = floorCapacity[floor] ?? 0
    const started = jobs.filter((job) => job.floor === floor && (job.status === '已启动' || job.status === '超额启动' || job.status === '已完成'))
    let peak = 0
    const events: number[] = []
    for (const job of started) {
      events.push(job.start, job.end)
    }
    for (const ev of events) {
      const load = started.filter((job) => job.start <= ev && ev < job.end).reduce((sum, job) => sum + job.power, 0)
      peak = Math.max(peak, load)
    }
    const overload = overloadByFloor.get(floor) ?? 0
    return {
      floor,
      capacity: cap,
      peak: Math.round(peak * 10) / 10,
      margin: Math.round((cap - peak) * 10) / 10,
      overload: Math.round(overload * 10) / 10,
      overloaded: overload > 0,
    }
  })

  return { jobs, floorLoads }
}

export const useBatchStore = defineStore('batch', () => {
  const linkage = useLinkageStore()
  const saved = localStorage.getItem(BATCH_DRAFT_KEY)
  const restored = saved ? JSON.parse(saved) : null

  const selectedTriggerIds = ref<string[]>(restored?.selectedTriggerIds ?? ['D-02-01'])
  const floorCapacity = ref<Record<string, number>>(restored?.floorCapacity ?? { '1F': 16, '2F': 10 })
  const capacitySubmissions = ref<CapacitySubmission[]>(restored?.capacitySubmissions ?? [])
  const executions = ref<Record<string, ExecStatus>>(restored?.executions ?? {})
  const checkpoint = ref(restored?.checkpoint ?? 0)
  const writeError = ref<string | null>(null)
  const failNextWrite = ref(false)
  const conflictNotice = ref<string | null>(null)
  const executor = ref('调试员·本机')

  const triggers = computed(() =>
    linkage.devices.filter((device) => ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块'].includes(device.type)),
  )

  const jobs = computed<BatchJob[]>(() => {
    const selected = new Set(selectedTriggerIds.value)
    const rules = linkage.rules.filter((rule) => rule.enabled && selected.has(rule.triggerId))
    const actionIds = new Set(rules.map((rule) => rule.actionId))
    const actionDevices = linkage.devices.filter((device) => actionIds.has(device.id))

    const merged = new Map<string, BatchJob>()
    for (const rule of rules) {
      const action = linkage.devices.find((device) => device.id === rule.actionId)
      if (!action) continue
      const ext = interlockExternalDelay(rule.interlock)
      const baseEarliest = rule.delay + ext
      const existing = merged.get(action.id)
      if (existing) {
        existing.ruleIds.push(rule.id)
        existing.interlocks.push(rule.interlock)
        existing.priority = Math.min(existing.priority, rule.priority) as 1 | 2 | 3
        existing.baseEarliest = Math.min(existing.baseEarliest, baseEarliest)
      } else {
        const { prereqId, travel } = interlockPrereq(rule.interlock, actionDevices)
        merged.set(action.id, {
          actionId: action.id,
          actionName: action.name,
          floor: action.floor,
          power: action.power,
          duration: action.duration,
          priority: rule.priority,
          ruleIds: [rule.id],
          interlocks: [rule.interlock],
          essential: ESSENTIAL_LOAD_TYPES.includes(action.type as DeviceType),
          baseEarliest,
          prereqId,
          travel,
          start: 0,
          end: 0,
          started: false,
          status: '排队中',
          overload: 0,
          waitReason: '',
        })
      }
    }
    const list = [...merged.values()]
    breakCycles(list)
    const { jobs: scheduled } = scheduleJobs(list, floorCapacity.value)
    return scheduled
  })

  const floorLoads = computed<FloorLoad[]>(() => {
    const floorSet = new Set(jobs.value.map((job) => job.floor))
    const result: FloorLoad[] = []
    for (const floor of floorSet) {
      const started = jobs.value.filter(
        (job) => job.floor === floor && (job.status === '已启动' || job.status === '超额启动' || job.status === '已完成'),
      )
      let peak = 0
      const times = new Set<number>()
      for (const job of started) {
        times.add(job.start)
        times.add(job.end)
      }
      for (const t of times) {
        const load = started.filter((job) => job.start <= t && t < job.end).reduce((sum, job) => sum + job.power, 0)
        peak = Math.max(peak, load)
      }
      const cap = floorCapacity.value[floor] ?? 0
      const overload = peak > cap ? peak - cap : 0
      result.push({
        floor,
        capacity: cap,
        peak: Math.round(peak * 10) / 10,
        margin: Math.round((cap - peak) * 10) / 10,
        overload: Math.round(overload * 10) / 10,
        overloaded: overload > 0,
      })
    }
    return result
  })

  const queuedJobs = computed(() => jobs.value.filter((job) => job.status === '排队中'))
  const overloadedJobs = computed(() => jobs.value.filter((job) => job.status === '超额启动'))
  const satisfied = computed(() => floorLoads.value.every((fl) => !fl.overloaded) && queuedJobs.value.length === 0)
  const hasBatch = computed(() => jobs.value.length > 0)

  const orderedJobs = computed(() =>
    [...jobs.value].sort((a, b) => a.start - b.start || a.priority - b.priority || a.actionId.localeCompare(b.actionId)),
  )

  watch(
    [selectedTriggerIds, floorCapacity, () => linkage.devices, () => linkage.rules],
    () => {
      executions.value = {}
      checkpoint.value = 0
      writeError.value = null
    },
    { deep: true },
  )

  watch(
    [selectedTriggerIds, floorCapacity, capacitySubmissions, executions, checkpoint, executor],
    () => {
      localStorage.setItem(
        BATCH_DRAFT_KEY,
        JSON.stringify({
          selectedTriggerIds: selectedTriggerIds.value,
          floorCapacity: floorCapacity.value,
          capacitySubmissions: capacitySubmissions.value,
          executions: executions.value,
          checkpoint: checkpoint.value,
        }),
      )
    },
    { deep: true },
  )

  function persistCheckpoint() {
    localStorage.setItem(
      BATCH_DRAFT_KEY,
      JSON.stringify({
        selectedTriggerIds: selectedTriggerIds.value,
        floorCapacity: floorCapacity.value,
        capacitySubmissions: capacitySubmissions.value,
        executions: executions.value,
        checkpoint: checkpoint.value,
      }),
    )
  }

  function executeBatch() {
    writeError.value = null
    const order = orderedJobs.value
    for (let i = checkpoint.value; i < order.length; i += 1) {
      const job = order[i]
      if (executions.value[job.actionId] === '已完成') continue
      if (failNextWrite.value) {
        failNextWrite.value = false
        checkpoint.value = i
        writeError.value = `写盘失败：断点 ${i}（${job.actionName}）。已完成 ${i} 项动作未重做，可从断点恢复。`
        persistCheckpoint()
        return
      }
      executions.value[job.actionId] = '已完成'
      checkpoint.value = i + 1
      persistCheckpoint()
    }
    checkpoint.value = order.length
  }

  function resumeBatch() {
    writeError.value = null
    executeBatch()
  }

  function resetExecution() {
    executions.value = {}
    checkpoint.value = 0
    writeError.value = null
    persistCheckpoint()
  }

  function submitCapacity(floor: string, capacity: number, by: string, at?: number) {
    const now = at ?? Date.now()
    const adopted = capacitySubmissions.value.find((item) => item.floor === floor && item.status === '已采用')
    const submission: CapacitySubmission = {
      id: `CAP-${now}-${Math.random().toString(36).slice(2, 7)}`,
      floor,
      capacity,
      by,
      at: now,
      status: '已采用',
    }
    if (!adopted) {
      capacitySubmissions.value.push(submission)
      floorCapacity.value = { ...floorCapacity.value, [floor]: capacity }
      conflictNotice.value = null
      return
    }
    if (now < adopted.at && adopted.at - now < CONCURRENCY_WINDOW) {
      submission.status = '已采用'
      adopted.status = '冲突未采用'
      capacitySubmissions.value.push(submission)
      floorCapacity.value = { ...floorCapacity.value, [floor]: capacity }
      conflictNotice.value = `冲突：${by} 提交的 ${floor} 容量 ${capacity}kW 时间戳更早，已采用；${adopted.by} 的 ${adopted.capacity}kW 标记为冲突未采用，现场值保留。`
    } else if (now >= adopted.at && now - adopted.at < CONCURRENCY_WINDOW) {
      submission.status = '冲突未采用'
      capacitySubmissions.value.push(submission)
      conflictNotice.value = `冲突：${by} 提交的 ${floor} 容量 ${capacity}kW 晚于 ${adopted.by} 的版本，未采用；提交值已保留现场。`
    } else if (now < adopted.at) {
      submission.status = '已采用'
      adopted.status = '已替代'
      capacitySubmissions.value.push(submission)
      floorCapacity.value = { ...floorCapacity.value, [floor]: capacity }
      conflictNotice.value = null
    } else {
      adopted.status = '已替代'
      capacitySubmissions.value.push(submission)
      floorCapacity.value = { ...floorCapacity.value, [floor]: capacity }
      conflictNotice.value = null
    }
  }

  function simulatePeerSubmission(floor: string) {
    const adopted = capacitySubmissions.value.find((item) => item.floor === floor && item.status === '已采用')
    const peerAt = adopted ? adopted.at - 1 : Date.now() - 1
    const peerCap = Math.max(1, Math.round((adopted?.capacity ?? 10) + (Math.random() > 0.5 ? 4 : -4)))
    submitCapacity(floor, peerCap, '调试员·同事', peerAt)
  }

  function changeDeviceFloor(deviceId: string, floor: string) {
    const device = linkage.devices.find((item) => item.id === deviceId)
    if (device) device.floor = floor
  }

  return {
    selectedTriggerIds,
    floorCapacity,
    capacitySubmissions,
    executions,
    checkpoint,
    writeError,
    failNextWrite,
    conflictNotice,
    executor,
    triggers,
    jobs,
    floorLoads,
    queuedJobs,
    overloadedJobs,
    satisfied,
    hasBatch,
    orderedJobs,
    executeBatch,
    resumeBatch,
    resetExecution,
    submitCapacity,
    simulatePeerSubmission,
    changeDeviceFloor,
  }
})
