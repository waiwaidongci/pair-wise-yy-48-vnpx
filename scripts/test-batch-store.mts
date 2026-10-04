import assert from 'node:assert'
import { createPinia, setActivePinia } from 'pinia'

// localStorage 垫片
class MemoryStorage {
  private map = new Map<string, string>()
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  getItem(k: string) { return this.map.get(k) ?? null }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
}
;(globalThis as any).localStorage = new MemoryStorage()

const { useLinkageStore } = await import('../src/stores/linkage')
const { useBatchStore, simulateFaults } = await import('../src/stores/batch')

function freshStores() {
  ;(globalThis as any).localStorage = new MemoryStorage()
  setActivePinia(createPinia())
  const linkage = useLinkageStore()
  const batch = useBatchStore()
  batch.init()
  return { linkage, batch }
}

// 准备：在 linkage store 中找到 1F 报警点 D-01-01
function selectOneFTrigger(batch: ReturnType<typeof useBatchStore>) {
  batch.selectedTriggerIds = ['D-01-01']
  // 小容量制造超额与顺延
  for (const floor of batch.floors) batch.capacities[floor] = 6
}

// 场景A：生成队列 → 规则变化，队列立即失效并重算
{
  const { linkage, batch } = freshStores()
  selectOneFTrigger(batch)
  const s0 = batch.createQueue()!
  assert.equal(batch.queue!.status, 'valid')
  const before = s0.entries.length
  // 修改规则延时
  const rule = linkage.rules.find((r) => r.id === 'R-002')!
  rule.delay = 30
  assert.equal(batch.queue!.status, 'invalidated', '规则一变队列必须立即失效')
  assert.ok(batch.queue!.invalidations.some((r) => r.includes('规则')))
  assert.ok(batch.queue!.schedule.entries.length === before, '失效同时已按新规则重算')
  const broadcast = batch.queue!.schedule.entries.find((e) => e.actionId === 'A-01-03')
  // R-002 delay 30 / P2；R-004 delay 3 / P1 同动作 → 主规则取 P1 delay 3，仍以优先级主规则排程
  assert.ok(broadcast, '广播动作仍在重算队列中')
  console.log('场景A 通过：规则变化 → 队列立即失效并重算')
}

// 场景B：设备换层 → 失效，且重算按新楼层核算
{
  const { linkage, batch } = freshStores()
  selectOneFTrigger(batch)
  batch.createQueue()
  const fan = linkage.devices.find((d) => d.id === 'A-01-01')!
  fan.floor = '2F'
  assert.equal(batch.queue!.status, 'invalidated')
  assert.ok(batch.queue!.invalidations.some((r) => r.includes('换层')))
  const moved = batch.queue!.schedule.entries.find((e) => e.actionId === 'A-01-01')!
  assert.equal(moved.floor, '2F', '重算结果反映新楼层')
  console.log('场景B 通过：设备换层 → 队列失效并按新楼层重算')
}

// 场景C：两名调试员几乎同时提交同一层容量——更早一份生效，后到者保留并标冲突
{
  const { batch } = freshStores()
  const r1 = batch.submitCapacity('1F', 7, '调试员甲')
  assert.equal(r1, 'committed')
  assert.equal(batch.capacities['1F'], 7, '先到者容量生效')
  const r2 = batch.submitCapacity('1F', 5, '调试员乙')
  assert.equal(r2, 'conflict')
  assert.equal(batch.capacities['1F'], 7, '后到者不得覆盖已采用值')
  const conflict = batch.commits.find((c) => c.state === 'conflict')!
  assert.equal(conflict.capacityKw, 5, '后到现场值保留')
  assert.ok(conflict.conflictReason!.includes('调试员甲'))
  // 裁决采用后到现场值
  batch.resolveConflict(conflict.id, true)
  assert.equal(batch.capacities['1F'], 5, '裁决后可采用后到现场值')
  // 窗口外新提交正常受理
  const old = Date.now
  Date.now = () => old() + 5000
  const r3 = batch.submitCapacity('1F', 9, '调试员丙')
  assert.equal(r3, 'committed', '提交窗口外不构成冲突')
  Date.now = old
  console.log('场景C 通过：并发同层提交先到先用，后到者保留现场并标明冲突')
}

// 场景D：容量提交变化 → 队列失效重算
{
  const { batch } = freshStores()
  selectOneFTrigger(batch)
  batch.createQueue()
  assert.equal(batch.queue!.status, 'valid')
  // 先等窗口外
  const oldNow = Date.now
  Date.now = () => oldNow() + 5000
  batch.submitCapacity('1F', 3, '调试员甲')
  Date.now = oldNow
  assert.equal(batch.queue!.status, 'invalidated')
  assert.ok(batch.queue!.invalidations.some((r) => r.includes('容量')))
  console.log('场景D 通过：容量一变队列立即失效重算')
}

// 场景E：写盘失败 → 不推进、不标记完成；恢复后已完成动作不重做
{
  const { batch } = freshStores()
  selectOneFTrigger(batch)
  // 容量给足，使排烟风机/卷帘/广播在各批次正常
  batch.capacities['1F'] = 20
  batch.capacities['2F'] = 20
  batch.createQueue()
  // 先推进一批（此时写盘正常）：t=0 动作完成落盘
  batch.advance(false)
  const doneAfterFirst = batch.queue!.completed.length
  assert.ok(doneAfterFirst >= 1, '首批动作应已完成')
  // 打开写盘故障，再推进：断点写盘失败 → 动作不得执行
  simulateFaults.value = true
  const completedBefore = batch.queue!.completed.length
  batch.advance(false)
  assert.equal(batch.queue!.status, 'write-failed')
  assert.equal(batch.queue!.completed.length, completedBefore, '写盘失败时不得新增已完成动作')
  // 模拟刷新重开：内存态重建，从磁盘断点恢复
  setActivePinia(createPinia())
  const batch2 = useBatchStore()
  batch2.init()
  assert.equal(batch2.queue!.completed.length, doneAfterFirst, '磁盘断点中的已完成动作被恢复')
  assert.ok(batch2.queue!.schedule.entries.filter((e) => e.state === 'done').length === doneAfterFirst, '恢复后已完成动作仍为完成态，不重做')
  // 故障恢复，推进剩余动作
  simulateFaults.value = false
  batch2.retryPersist()
  assert.equal(batch2.queue!.status, 'valid')
  let guard = 0
  while (!batch2.allDone && guard++ < 20) batch2.advance(true)
  assert.ok(batch2.allDone, '恢复后可继续推进至全部完成')
  // 已完成动作数量不重复：推进过程中断点动作没有被重做（startedAt 保持 0）
  const firstDone = batch2.queue!.completed.find((e) => e.startedAt === 0)
  assert.ok(firstDone, '断点恢复的动作保留原始启动时刻')
  simulateFaults.value = false
  console.log('场景E 通过：写盘失败停在断点，恢复后已完成动作不重做')
}

// 场景F：推进过程中关键设备超额也照常完成，且结果始终如实标记不满足
{
  const { batch } = freshStores()
  selectOneFTrigger(batch)
  batch.capacities['1F'] = 4 // 风机 5.5 必然超额
  const s = batch.createQueue()!
  assert.equal(s.satisfied, false)
  assert.ok(s.warnings.length >= 1)
  const fan = s.entries.find((e) => e.actionId === 'A-01-01')!
  assert.equal(fan.critical, true)
  assert.equal(fan.overCapacity, true)
  assert.equal(fan.plannedAt, 0, '关键设备钉死在 t=0')
  batch.advance(false)
  const doneFan = batch.queue!.schedule.entries.find((e) => e.actionId === 'A-01-01')
  assert.equal(doneFan?.state, 'done', '排烟风机超额也照常启动完成')
  console.log('场景F 通过：排烟超额照常启动，核算结论不假报满足')
}

console.log('\n全部 store 场景验证通过 ✔')
