import assert from 'node:assert'
import { buildSchedule } from '../src/lib/batchScheduler'
import type { Device, Rule } from '../src/stores/linkage'

const devices: Device[] = [
  { id: 'T1', name: '一层感烟01', type: '感烟探测器', floor: '1F', zone: 'A', address: 'a1' },
  { id: 'F1', name: '排烟风机PF-1', type: '排烟风机', floor: '1F', zone: 'A', address: 'a2' }, // 5.5 关键
  { id: 'R1', name: '防火卷帘01', type: '防火卷帘', floor: '1F', zone: 'A', address: 'a3' }, // 2.2 关键
  { id: 'B1', name: '消防广播', type: '消防广播', floor: '1F', zone: 'A', address: 'a4' }, // 1.5 关键
  { id: 'L1', name: '电梯归位', type: '电梯', floor: '1F', zone: 'A', address: 'a5' }, // 4 非关键
  { id: 'M1', name: '输出模块1', type: '输出模块', floor: '1F', zone: 'A', address: 'a6' }, // 0.3 非关键
]

function rule(id: string, triggerId: string, actionId: string, patch: Partial<Rule> = {}): Rule {
  return { id, triggerId, actionId, delay: 0, interlock: '无', priority: 2, suppression: '无', enabled: true, ...patch }
}

// 场景1：容量充足（20kW）——全部 t=0，无顺延无超额
{
  const rules = [
    rule('R1', 'T1', 'F1', { priority: 1 }),
    rule('R2', 'T1', 'R1', { priority: 1 }),
    rule('R3', 'T1', 'B1', { delay: 5, priority: 2 }),
    rule('R4', 'T1', 'L1', { delay: 10, priority: 2 }),
    rule('R5', 'T1', 'M1', { priority: 3 }),
  ]
  const result = buildSchedule({ triggerIds: ['T1'], devices, rules, capacities: { '1F': 20 } })
  assert.equal(result.satisfied, true, '容量充足时应满足')
  assert.equal(result.deferredCount, 0)
  assert.equal(result.overCapacityCount, 0)
  const at = Object.fromEntries(result.entries.map((e) => [e.actionId, e.plannedAt]))
  assert.deepEqual(at, { F1: 0, R1: 0, M1: 0, B1: 5, L1: 10 })
  console.log('场景1 通过：容量充足，按延时排程')
}

// 场景2：容量 6kW，t=0 时 F1(5.5关键)+R1(2.2关键)+M1(0.3,P3)
// 关键设备不延期并标超额（7.7>6）；M1 是低优先级，应顺延直到放下
{
  const rules = [
    rule('R1', 'T1', 'F1', { priority: 1 }),
    rule('R2', 'T1', 'R1', { priority: 1 }),
    rule('R5', 'T1', 'M1', { priority: 3 }),
  ]
  const result = buildSchedule({ triggerIds: ['T1'], devices, rules, capacities: { '1F': 6 } })
  const f1 = result.entries.find((e) => e.actionId === 'F1')!
  const r1 = result.entries.find((e) => e.actionId === 'R1')!
  const m1 = result.entries.find((e) => e.actionId === 'M1')!
  assert.equal(f1.plannedAt, 0, '排烟风机必须 t=0 启动')
  assert.equal(r1.plannedAt, 0, '卷帘必须 t=0 启动')
  assert.equal(f1.overCapacity, true, '排烟风机超额照常启动并标记')
  assert.equal(r1.overCapacity, true)
  assert.ok(m1.plannedAt > 0, '低优先级模块应排队顺延')
  assert.equal(m1.deferred, true)
  assert.equal(result.satisfied, false, '绝不能假报已满足')
  assert.ok(result.warnings.some((w) => w.time === 0 && w.overByKw === 1.7), 't=0 缺口 1.7kW')
  console.log('场景2 通过：关键设备照常启动标超额，低优先级顺延，不假报满足')
}

// 场景3：非关键动作竞争——t=0 有 F1(5.5 关键)，容量 6
// M1(0.3,P3) 与风机合计 5.8≤6 可同启；L1(4,P2) 与风机合计 9.5>6 → 顺延
{
  const rules = [
    rule('R1', 'T1', 'F1', { priority: 1 }),
    rule('R4', 'T1', 'L1', { priority: 2 }),
    rule('R5', 'T1', 'M1', { priority: 3 }),
  ]
  const result = buildSchedule({ triggerIds: ['T1'], devices, rules, capacities: { '1F': 6 } })
  const l1 = result.entries.find((e) => e.actionId === 'L1')!
  const m1 = result.entries.find((e) => e.actionId === 'M1')!
  assert.equal(result.entries.find((e) => e.actionId === 'F1')!.plannedAt, 0)
  assert.equal(m1.plannedAt, 0, '小负荷模块与关键风机合计 5.8≤6，可同启')
  assert.ok(l1.plannedAt >= 5, `电梯 4kW 与风机合计超限，须顺延，实际 ${l1.plannedAt}`)
  assert.equal(l1.deferred, true)
  console.log('场景3 通过：放不下的非关键动作顺延，放得下的低优先级动作保留')
}

// 场景3b：两台非关键动作同刻竞争——容量 4，电梯(4,P2) 与模块(0.3,P3) 同在 t=0
// 无关键设备时，高优先级电梯先占满 4kW，模块顺延
{
  const rules = [
    rule('R4', 'T1', 'L1', { priority: 2 }),
    rule('R5', 'T1', 'M1', { priority: 3 }),
  ]
  const result = buildSchedule({ triggerIds: ['T1'], devices, rules, capacities: { '1F': 4 } })
  const l1 = result.entries.find((e) => e.actionId === 'L1')!
  const m1 = result.entries.find((e) => e.actionId === 'M1')!
  assert.equal(l1.plannedAt, 0, '高优先级先占容量')
  assert.ok(m1.plannedAt >= 5, '低优先级排队后移')
  console.log('场景3b 通过：同刻竞争时低优先级先往后顺延')
}

// 场景4：互锁——卷帘 R1(t=0) 是排烟风机 F1 的互锁前置；F1 delay=0 但需等 R1 反馈 → t=1
{
  const rules = [
    rule('R2', 'T1', 'R1', { priority: 1 }),
    rule('R1', 'T1', 'F1', { priority: 1, interlock: '卷帘全开后启动' }),
  ]
  const result = buildSchedule({ triggerIds: ['T1'], devices, rules, capacities: { '1F': 20 } })
  const f1 = result.entries.find((e) => e.actionId === 'F1')!
  const r1 = result.entries.find((e) => e.actionId === 'R1')!
  assert.equal(r1.plannedAt, 0)
  assert.equal(f1.plannedAt, 1, '互锁前置 t=0 + 1s 反馈')
  assert.equal(f1.interlockWait, 1)
  console.log('场景4 通过：互锁反馈顺序生效')
}

// 场景5：非关键动作互锁提到现场设备但本报警点未联动 → 外部互锁，需现场确认
{
  const rules = [rule('R9', 'T1', 'M1', { interlock: '非消防电源切断反馈' })]
  const result = buildSchedule({ triggerIds: ['T1'], devices, rules, capacities: { '1F': 20 } })
  const m1 = result.entries.find((e) => e.actionId === 'M1')!
  assert.equal(m1.externalInterlock, true)
  assert.equal(result.satisfied, false, '有外部互锁未确认不算满足')
  console.log('场景5 通过：非关键动作外部互锁挂起待确认')
}

// 场景5b：关键设备即使带现场互锁也照常启动，不挂起
{
  const rules = [rule('R1', 'T1', 'F1', { interlock: '防火阀开启反馈' })]
  const result = buildSchedule({ triggerIds: ['T1'], devices, rules, capacities: { '1F': 20 } })
  const f1 = result.entries.find((e) => e.actionId === 'F1')!
  assert.equal(f1.externalInterlock, false, '排烟风机不被互锁挂起')
  assert.equal(f1.plannedAt, 0)
  assert.ok(f1.note.includes('照常启动'))
  console.log('场景5b 通过：排烟带现场互锁仍照常启动并提示确认')
}

// 场景6：断点恢复——F1 已在 t=0 完成；容量改为 6，重算时 F1 固定占用且不重做，后续动作避开
{
  const first = buildSchedule({ triggerIds: ['T1'], devices, rules: [
    rule('R1', 'T1', 'F1', { priority: 1 }),
    rule('R4', 'T1', 'L1', { priority: 2 }),
  ], capacities: { '1F': 20 } })
  const done = first.entries.filter((e) => e.actionId === 'F1').map((e) => ({ ...e, state: 'done' as const, startedAt: 0, completedAt: 0 }))
  const restored = buildSchedule({ triggerIds: ['T1'], devices, rules: [
    rule('R1', 'T1', 'F1', { priority: 1 }),
    rule('R4', 'T1', 'L1', { priority: 2 }),
  ], capacities: { '1F': 6 } }, done)
  const f1 = restored.entries.find((e) => e.actionId === 'F1')!
  const l1 = restored.entries.find((e) => e.actionId === 'L1')!
  assert.equal(f1.state, 'done')
  assert.equal(f1.plannedAt, 0, '已完成动作按实际时刻计入')
  assert.ok(l1.plannedAt >= 5, `电梯须避开已完成的风机，实际 ${l1.plannedAt}`)
  assert.ok(!restored.entries.some((e) => e.state === 'done' && e.note.includes('不重做')) === false, '已完成动作带断点恢复说明')
  console.log('场景6 通过：断点恢复，已完成动作不重做且参与容量核算')
}

// 场景7：跨楼层动作设备不互相挤占
{
  const devices2: Device[] = [
    { id: 'T1', name: '探测器', type: '感烟探测器', floor: '1F', zone: 'A', address: 'a' },
    { id: 'F1', name: '1F风机', type: '排烟风机', floor: '1F', zone: 'A', address: 'b' },
    { id: 'F2', name: '2F风机', type: '排烟风机', floor: '2F', zone: 'B', address: 'c' },
  ]
  const rules = [rule('R1', 'T1', 'F1'), rule('R2', 'T1', 'F2')]
  const result = buildSchedule({ triggerIds: ['T1'], devices: devices2, rules, capacities: { '1F': 2, '2F': 10 } })
  const f1 = result.entries.find((e) => e.actionId === 'F1')!
  const f2 = result.entries.find((e) => e.actionId === 'F2')!
  assert.equal(f1.overCapacity, true, '1F 容量 2 < 5.5 超额')
  assert.equal(f2.overCapacity, false, '2F 容量充足不受影响')
  assert.equal(f1.plannedAt, 0)
  assert.equal(f2.plannedAt, 0)
  console.log('场景7 通过：容量按楼层独立核算')
}

// 场景8：停用规则不参与队列；同动作多规则合并为一次动作
{
  const rules = [
    rule('R1', 'T1', 'F1', { priority: 3, enabled: false }),
    rule('R2', 'T1', 'F1', { priority: 1 }),
  ]
  const result = buildSchedule({ triggerIds: ['T1'], devices, rules, capacities: { '1F': 20 } })
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].priority, 1)
  assert.deepEqual(result.entries[0].ruleIds, ['R2'])
  console.log('场景8 通过：停用规则剔除，多规则合并取主规则')
}

console.log('\n全部调度场景验证通过 ✔')
