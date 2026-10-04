<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'
import { useBatchStore } from '../stores/batch'
import { DEFER_STEP_S } from '../lib/batchScheduler'

const linkage = useLinkageStore()
const batch = useBatchStore()
onMounted(() => batch.init())

const capacityDrafts = ref<Record<string, number>>({})
const secondOperator = ref('调试员乙')
const conflictFloor = ref(batch.floors[0] ?? '1F')
const conflictKw = ref(6)
const conflictGapMs = ref(400)

onMounted(() => {
  const drafts: Record<string, number> = {}
  for (const floor of batch.floors) drafts[floor] = batch.capacities[floor] ?? 8
  capacityDrafts.value = drafts
})

const queue = computed(() => batch.queue)
const schedule = computed(() => batch.queue?.schedule ?? null)
const deviceById = computed(() => new Map(linkage.devices.map((device) => [device.id, device])))

function draftCapacity(floor: string) {
  return batch.submitCapacity(floor, capacityDrafts.value[floor] ?? 0, batch.operator)
}

/** 两名调试员几乎同时提交同一层容量：只采用更早的一份 */
function simulateConcurrentSubmit() {
  batch.notice = null
  const floor = conflictFloor.value
  const kw = conflictKw.value
  const first = batch.submitCapacity(floor, kw, batch.operator)
  if (first !== 'committed') return
  setTimeout(() => {
    batch.submitCapacity(floor, Math.max(1, kw - 2), secondOperator.value)
  }, conflictGapMs.value)
}

function deviceName(id: string) {
  return deviceById.value.get(id)?.name ?? id
}

function stateChip(state: string) {
  if (state === 'done') return { color: 'success', text: '已完成' }
  if (state === 'running') return { color: 'primary', text: '动作中' }
  return { color: 'default', text: '待动作' }
}

const stepLabel = computed(() => `推进到下一批次（步长 ${DEFER_STEP_S}s 顺延核算）`)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">BATCH COMMISSIONING / 联动批次核算</p>
        <h1>报警点动作队列与楼层供电余量</h1>
        <p class="muted">按规则延时、优先级和互锁排出动作队列；容量不够时低优先级动作排队顺延，排烟、卷帘、疏散广播照常启动并标出超额，不假报已满足。</p>
      </div>
      <div class="actions">
        <v-switch v-model="batch.simulateFaults" hide-details color="error" label="模拟写盘故障" density="compact" />
        <v-btn variant="outlined" prepend-icon="mdi-backup-restore" @click="batch.reloadFromCheckpoint()">从断点重载</v-btn>
        <v-btn v-if="queue" variant="text" color="error" prepend-icon="mdi-delete-outline" @click="batch.clearQueue()">清除队列</v-btn>
      </div>
    </div>

    <v-alert v-if="batch.notice" type="info" variant="tonal" density="compact" class="mb-3" closable @click="batch.notice = null">{{ batch.notice }}</v-alert>
    <v-alert v-if="queue?.status === 'write-failed'" type="error" variant="tonal" class="mb-3">
      <div class="alert-row">
        <span><v-icon icon="mdi-database-alert" start />写盘失败：{{ queue.writeError }}。动作已暂停推进，恢复后从断点继续，已完成动作不重做。</span>
        <v-btn size="small" variant="tonal" @click="batch.retryPersist()">恢复写盘并重试</v-btn>
      </div>
    </v-alert>
    <v-alert v-else-if="batch.pendingWrite" type="warning" variant="tonal" density="compact" class="mb-3">断点待确认（pendingWrite）：若此刻中断，恢复后最后一批将按断点重新执行，已完成动作不重做。</v-alert>
    <v-alert v-if="batch.lastRecoveredAt" type="success" variant="tonal" density="compact" class="mb-3">
      <v-icon icon="mdi-check-decagram" start />已于 {{ new Date(batch.lastRecoveredAt).toLocaleTimeString() }} 从写盘中断断点恢复，{{ queue?.completed.length ?? 0 }} 个已完成动作保持完成态、未重做。
    </v-alert>
    <v-alert v-if="queue?.status === 'invalidated'" type="warning" variant="tonal" class="mb-3">
      <div class="alert-row">
        <span><strong>原动作队列已失效</strong>：{{ queue.invalidations.join('；') }}。下表为按新现场自动重算的队列，原执行结论不再有效。</span>
      </div>
    </v-alert>

    <div class="setup-grid">
      <section class="panel">
        <div class="panel-head"><h3>1. 选定报警点</h3><v-chip size="small" variant="tonal">{{ batch.selectedTriggerIds.length }} 个</v-chip></div>
        <div class="trigger-list">
          <div v-for="device in batch.triggerDevices" :key="device.id" class="trigger-row" :class="{ active: batch.selectedTriggerIds.includes(device.id) }">
            <v-checkbox-btn
              :model-value="batch.selectedTriggerIds.includes(device.id)"
              @update:model-value="(on) => { batch.selectedTriggerIds = on ? [...batch.selectedTriggerIds, device.id] : batch.selectedTriggerIds.filter((id) => id !== device.id) }"
            />
            <div><strong>{{ device.name }}</strong><small>{{ device.id }} · {{ device.floor }} / {{ device.zone }}</small></div>
          </div>
          <p v-if="batch.triggerDevices.length === 0" class="muted pad">暂无报警点位</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h3>2. 楼层容量（kW）与提交仲裁</h3><v-chip size="small" color="primary" variant="tonal">先到先得</v-chip></div>
        <div class="cap-list">
          <div v-for="floor in batch.floors" :key="floor" class="cap-row">
            <strong>{{ floor }}</strong>
            <v-text-field v-model.number="capacityDrafts[floor]" type="number" density="compact" hide-details suffix="kW" style="max-width:120px" />
            <v-btn size="small" variant="tonal" @click="draftCapacity(floor)">{{ batch.operator }} 提交</v-btn>
            <v-chip v-if="queue?.capacities[floor] !== undefined" size="x-small" variant="outlined">生效 {{ queue?.capacities[floor] }}kW</v-chip>
          </div>
        </div>
        <v-divider class="my-3" />
        <div class="concurrent">
          <p class="muted small">两人几乎同时提交同一层（演练并发冲突，只采用更早的一份，后到者保留现场并标明冲突）：</p>
          <div class="concurrent-row">
            <v-select v-model="conflictFloor" :items="batch.floors" label="楼层" density="compact" hide-details style="max-width:96px" />
            <v-text-field v-model.number="conflictKw" type="number" label="先到值 kW" density="compact" hide-details style="max-width:110px" />
            <v-text-field v-model="secondOperator" label="后到调试员" density="compact" hide-details style="max-width:120px" />
            <v-text-field v-model.number="conflictGapMs" type="number" label="间隔 ms" density="compact" hide-details style="max-width:100px" />
            <v-btn size="small" color="warning" variant="tonal" @click="simulateConcurrentSubmit">并发提交</v-btn>
          </div>
        </div>
      </section>

      <section class="panel action-panel">
        <div class="panel-head"><h3>3. 生成动作队列</h3></div>
        <div class="compute-box">
          <p class="muted small">队列纳入：规则延时、优先级（P1&gt;P2&gt;P3）、互锁反馈顺序与同楼层同时动作供电占用。关键动作（排烟/卷帘/广播）不顺延。</p>
          <v-btn color="primary" prepend-icon="mdi-playlist-play" size="large" block @click="batch.createQueue()">排出动作队列并核算批次</v-btn>
          <div v-if="schedule" class="summary">
            <div><span>动作总数</span><strong>{{ schedule.totalEntries }}</strong></div>
            <div><span>排队顺延</span><strong class="warning">{{ schedule.deferredCount }}</strong></div>
            <div><span>超额标记</span><strong :class="schedule.overCapacityCount ? 'error' : 'success'">{{ schedule.overCapacityCount }}</strong></div>
            <div><span>待现场互锁</span><strong class="warning">{{ schedule.externalInterlockCount }}</strong></div>
          </div>
          <v-alert v-if="schedule" :type="schedule.satisfied ? 'success' : 'error'" variant="tonal" density="compact">
            <strong v-if="schedule.satisfied">全部批次在容量内，核算结果满足。</strong>
            <strong v-else>核算未满足：{{ schedule.warnings.length }} 个批次超额、{{ schedule.externalInterlockCount }} 个动作等待现场互锁反馈，不得判定为已满足。</strong>
          </v-alert>
        </div>
      </section>
    </div>

    <template v-if="schedule && queue">
      <div class="sim-bar panel">
        <div>
          <strong>执行模拟（断点可恢复）</strong>
          <p class="muted small mb-0">当前时刻 T={{ queue.cursorTime }}s · 已完成 {{ queue.completed.length }}/{{ schedule.entries.length }}</p>
        </div>
        <v-btn color="primary" variant="tonal" prepend-icon="mdi-step-forward" :disabled="batch.allDone || queue.status === 'invalidated'" @click="batch.advance(false)">{{ stepLabel }}</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-hand-back-right" :disabled="batch.pendingExternal.length === 0" @click="batch.confirmExternalAndAdvance()">确认现场互锁并推进</v-btn>
        <v-chip v-if="batch.allDone" color="success" variant="tonal" prepend-icon="mdi-flag-checkered">全部动作完成</v-chip>
      </div>

      <div class="result-grid">
        <section class="panel">
          <div class="panel-head"><h3>动作队列</h3><span class="muted small">按启动时刻 / 优先级排序</span></div>
          <v-table density="compact">
            <thead><tr><th>时刻</th><th>动作设备</th><th>规则/优先级</th><th>构成</th><th>负荷</th><th>状态</th><th>核算标记</th></tr></thead>
            <tbody>
              <tr v-for="entry in schedule.entries" :key="entry.id" :class="{ done: entry.state === 'done', critical: entry.critical, over: entry.overCapacity }">
                <td class="mono"><strong>T={{ entry.plannedAt }}s</strong><br /><small v-if="entry.deferredFrom !== null" class="warning">原 {{ entry.deferredFrom }}s</small></td>
                <td>
                  <strong>{{ entry.actionName }}</strong>
                  <v-chip v-if="entry.critical" size="x-small" color="error" variant="tonal" class="ml-1">{{ entry.actionType }}·必启</v-chip>
                  <v-chip v-else size="x-small" variant="outlined">{{ entry.actionType }}</v-chip>
                  <br /><small class="muted">{{ entry.floor }} · 触发：{{ entry.triggerNames.join('、') }}</small>
                </td>
                <td><v-chip size="x-small" :color="entry.priority === 1 ? 'error' : entry.priority === 2 ? 'warning' : 'default'" variant="tonal">P{{ entry.priority }}</v-chip><br /><small>{{ entry.ruleIds.join(', ') }}</small></td>
                <td class="small">
                  <span v-if="entry.baseDelay">延时 {{ entry.baseDelay }}s</span><span v-else>即时</span>
                  <v-icon v-if="entry.interlockWait" icon="mdi-link-lock" size="13" color="warning" />
                  <span v-if="entry.interlockWait"> +互锁 {{ entry.interlockWait }}s</span>
                  <v-icon v-if="entry.deferred" icon="mdi-clock-fast" size="13" color="warning" />
                  <span v-if="entry.deferred"> 顺延×{{ entry.deferCount }}</span>
                </td>
                <td class="mono">{{ entry.loadKw }}kW</td>
                <td><v-chip size="x-small" :color="stateChip(entry.state).color" variant="tonal">{{ stateChip(entry.state).text }}</v-chip></td>
                <td>
                  <v-chip v-if="entry.overCapacity" size="x-small" color="error" variant="tonal" prepend-icon="mdi-flash-alert">超额照常启动</v-chip>
                  <v-chip v-else-if="entry.deferred" size="x-small" color="warning" variant="tonal" prepend-icon="mdi-clock-outline">低优先级排队</v-chip>
                  <v-chip v-else-if="entry.externalInterlock && entry.state !== 'done'" size="x-small" color="info" variant="tonal" prepend-icon="mdi-hand-back-right">待现场互锁</v-chip>
                  <v-chip v-else-if="entry.interlockCycle" size="x-small" color="warning" variant="tonal" prepend-icon="mdi-sync-alert">互锁环路</v-chip>
                  <v-chip v-else size="x-small" color="success" variant="tonal">容量内</v-chip>
                  <p v-if="entry.note" class="note">{{ entry.note }}</p>
                </td>
              </tr>
            </tbody>
          </v-table>
        </section>

        <aside>
          <section class="panel mb-3">
            <div class="panel-head"><h3>批次供电核算</h3></div>
            <div class="batch-list">
              <article v-for="(batchItem, index) in schedule.batches" :key="`${batchItem.floor}-${batchItem.time}-${index}`" :class="{ over: batchItem.overCapacity }">
                <div class="batch-head">
                  <strong>{{ batchItem.floor }} · T={{ batchItem.time }}s</strong>
                  <v-chip size="x-small" :color="batchItem.overCapacity ? 'error' : 'success'" variant="tonal">
                    {{ batchItem.simultaneousKw }}/{{ batchItem.capacityKw }}kW
                  </v-chip>
                </div>
                <v-progress-linear :model-value="Math.min(100, (batchItem.simultaneousKw / Math.max(1, batchItem.capacityKw)) * 100)" :color="batchItem.overCapacity ? 'error' : batchItem.simultaneousKw > batchItem.capacityKw * 0.85 ? 'warning' : 'success'" height="8" rounded />
                <p class="small muted mb-0">{{ batchItem.entries.map(deviceName).join('、') }}</p>
                <p v-if="batchItem.overCapacity" class="over-note"><v-icon icon="mdi-flash-alert" size="14" />缺口 {{ batchItem.overByKw }}kW：排烟/卷帘/广播照常启动，其余按优先级排队后仍超额，如实标记</p>
              </article>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>容量提交仲裁记录</h3><v-chip size="small" variant="tonal">{{ batch.commits.length }}</v-chip></div>
            <div class="commit-list">
              <article v-for="commit in batch.commits" :key="commit.id" :class="commit.state">
                <div class="commit-head">
                  <strong>{{ commit.floor }} · {{ commit.capacityKw }}kW</strong>
                  <v-chip size="x-small" :color="commit.state === 'conflict' ? 'error' : 'success'" variant="tonal">{{ commit.state === 'conflict' ? '冲突·现场保留' : '已采用' }}</v-chip>
                </div>
                <p class="small mb-0">{{ commit.operator }} · {{ new Date(commit.submittedAt).toLocaleTimeString() }}</p>
                <p v-if="commit.conflictReason" class="conflict-reason">{{ commit.conflictReason }}</p>
                <div v-if="commit.state === 'conflict'" class="commit-actions">
                  <v-btn size="x-small" variant="tonal" @click="batch.resolveConflict(commit.id, true)">采用后到现场值</v-btn>
                  <v-btn size="x-small" variant="text" @click="batch.resolveConflict(commit.id, false)">维持更早一份</v-btn>
                </div>
              </article>
              <p v-if="batch.commits.length === 0" class="muted small pad">暂无提交记录</p>
            </div>
          </section>
        </aside>
      </div>
    </template>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.alert-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.setup-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1.35fr) minmax(0,.9fr); gap: 14px; margin-bottom: 14px; }
.trigger-list { padding: 8px 12px 14px; max-height: 320px; overflow-y: auto; }
.trigger-row { display: flex; align-items: center; gap: 4px; padding: 7px 6px; border-radius: 8px; }
.trigger-row.active { background: #fdf1ee; }
.trigger-row strong, .trigger-row small { display: block; }
.trigger-row small { color: #7b878c; }
.pad { padding: 12px; }
.cap-list { padding: 12px; display: grid; gap: 10px; }
.cap-row { display: flex; align-items: center; gap: 10px; }
.cap-row strong { min-width: 34px; }
.concurrent { padding: 0 12px 14px; }
.concurrent-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.small { font-size: 12px; }
.action-panel .compute-box { padding: 14px; display: grid; gap: 12px; }
.summary { display: grid; grid-template-columns: repeat(4,1fr); gap: 8px; text-align: center; }
.summary div { border: 1px solid #e4e9e9; border-radius: 8px; padding: 8px 4px; }
.summary span { display: block; color: #758187; font-size: 11px; }
.summary strong { font-size: 20px; color: #293e45; }
.summary .error { color: #b23e2a; }
.summary .warning { color: #bd7928; }
.summary .success { color: #39785f; }
.sim-bar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 14px; flex-wrap: wrap; }
.result-grid { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; }
.result-grid table { min-width: 760px; }
.mono { font-family: ui-monospace,monospace; }
tr.done { opacity: .62; }
tr.critical td { background: #fff8f6; }
tr.over td { background: #fdecea !important; }
.warning { color: #bd7928; }
.error { color: #b23e2a; }
.note { margin: 4px 0 0; color: #8a6a33; font-size: 11px; line-height: 1.4; }
.batch-list { padding: 10px 14px 14px; display: grid; gap: 12px; max-height: 420px; overflow-y: auto; }
.batch-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; }
.batch-list article.over { padding: 8px; border: 1px solid #f0c4bc; border-radius: 8px; background: #fdf3f1; }
.over-note { margin: 6px 0 0; color: #b23e2a; font-size: 11px; display: flex; align-items: center; gap: 4px; }
.commit-list { padding: 10px 14px 14px; display: grid; gap: 10px; max-height: 320px; overflow-y: auto; }
.commit-head { display: flex; align-items: center; justify-content: space-between; }
.commit-list article { border-bottom: 1px solid #eef1f1; padding-bottom: 8px; }
.commit-list article.conflict { background: #fdf3f1; border: 1px solid #f0c4bc; border-radius: 8px; padding: 8px; }
.conflict-reason { margin: 6px 0; color: #a54b35; font-size: 11px; line-height: 1.5; }
.commit-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.mb-3 { margin-bottom: 14px; }
@media (max-width: 1180px) { .setup-grid { grid-template-columns: 1fr; } .result-grid { grid-template-columns: 1fr; } }
</style>
