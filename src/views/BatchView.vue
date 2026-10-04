<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useBatchStore } from '../stores/batch'

const store = useBatchStore()
const { selectedTriggerIds, floorCapacity, capacitySubmissions, jobs, floorLoads, queuedJobs, overloadedJobs, satisfied, hasBatch, orderedJobs, executions, checkpoint, writeError, failNextWrite, conflictNotice, executor } = storeToRefs(store)

const capDrafts = ref<Record<string, number>>({ '1F': floorCapacity.value['1F'] ?? 16, '2F': floorCapacity.value['2F'] ?? 10 })
const floors = computed(() => {
  const set = new Set([...Object.keys(floorCapacity.value), ...store.jobs.map((job) => job.floor)])
  return [...set].sort()
})

function statusColor(status: string) {
  if (status === '超额启动') return 'error'
  if (status === '排队中') return 'warning'
  if (status === '已完成') return 'success'
  return 'primary'
}

function statusIcon(status: string) {
  if (status === '超额启动') return 'mdi-alert-octagon-outline'
  if (status === '排队中') return 'mdi-clock-outline'
  if (status === '已完成') return 'mdi-check-circle-outline'
  return 'mdi-play-circle-outline'
}

function submitFloor(floor: string) {
  const value = Number(capDrafts.value[floor])
  if (!Number.isFinite(value) || value <= 0) return
  store.submitCapacity(floor, value, executor.value)
}

function simulatePeer(floor: string) {
  store.simulatePeerSubmission(floor)
}

function allTriggers() {
  store.selectedTriggerIds = store.triggers.map((trigger) => trigger.id)
}

function clearTriggers() {
  store.selectedTriggerIds = []
}

const executedCount = computed(() => Object.keys(executions.value).length)
const totalCount = computed(() => orderedJobs.value.length)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">LINKAGE BATCH / 联动批次核算</p>
        <h1>同时动作供电余量与批次排队</h1>
        <p class="muted">选定报警点与楼层容量后，按延时、优先级和互锁排出动作队列；容量不足时低优先级顺延，排烟、卷帘、疏散广播照常启动并标出超额。</p>
      </div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-account-multiple-plus-outline" @click="allTriggers">全选报警点</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-close" @click="clearTriggers">清空</v-btn>
      </div>
    </div>

    <v-alert v-if="!hasBatch" type="info" variant="tonal" class="mb-3">请先选择至少一个报警点，系统将按启用规则排出联动动作队列。</v-alert>
    <v-alert v-else-if="satisfied" type="success" variant="tonal" class="mb-3" prepend-icon="mdi-check-decagram">
      供电余量满足：各楼层同时动作峰值均在容量以内，无排队动作。
    </v-alert>
    <v-alert v-else type="error" variant="tonal" class="mb-3" prepend-icon="mdi-alert-octagon">
      供电余量不满足：存在 {{ overloadedJobs.length }} 项超额启动、{{ queuedJobs.length }} 项排队动作。排烟 / 卷帘 / 疏散广播为必须启动的保安负荷，超额部分已如实标出，不得假报满足。
    </v-alert>
    <v-alert v-if="conflictNotice" type="warning" variant="tonal" class="mb-3" prepend-icon="mdi-source-branch">
      {{ conflictNotice }}
    </v-alert>

    <div class="panel mb-3">
      <div class="panel-head"><h3>报警点选择</h3><span class="muted">可多选模拟同时报警</span></div>
      <div class="chips">
        <v-chip
          v-for="trigger in store.triggers"
          :key="trigger.id"
          :color="selectedTriggerIds.includes(trigger.id) ? 'primary' : 'default'"
          :variant="selectedTriggerIds.includes(trigger.id) ? 'flat' : 'outlined'"
          :prepend-icon="trigger.type === '手动报警按钮' ? 'mdi-hand-back-right-outline' : 'mdi-smoke-detector-outline'"
          @click="selectedTriggerIds = selectedTriggerIds.includes(trigger.id) ? selectedTriggerIds.filter((id) => id !== trigger.id) : [...selectedTriggerIds, trigger.id]"
        >
          {{ trigger.name }}
        </v-chip>
      </div>
    </div>

    <div class="panel mb-3">
      <div class="panel-head"><h3>楼层容量与并发提交</h3><span class="muted">容量变更后队列立即失效重算；几乎同时提交只采用更早一份</span></div>
      <v-row>
        <v-col v-for="floor in floors" :key="floor" cols="12" md="6">
          <div class="cap-card">
            <div class="cap-head">
              <strong>{{ floor }}</strong>
              <v-chip size="small" variant="tonal" color="secondary">当前容量 {{ floorCapacity[floor] ?? 0 }} kW</v-chip>
            </div>
            <div class="cap-form">
              <v-text-field v-model.number="capDrafts[floor]" type="number" label="容量 (kW)" density="compact" hide-details style="max-width:130px" />
              <v-btn size="small" color="primary" variant="tonal" @click="submitFloor(floor)">提交容量</v-btn>
              <v-btn size="small" variant="outlined" prepend-icon="mdi-account-multiple-outline" @click="simulatePeer(floor)">模拟同事同时提交</v-btn>
            </div>
            <div class="cap-history">
              <div v-for="sub in capacitySubmissions.filter((item) => item.floor === floor).slice(-3).reverse()" :key="sub.id" class="cap-row" :class="{ conflict: sub.status === '冲突未采用' }">
                <v-chip size="x-small" :color="sub.status === '已采用' ? 'success' : sub.status === '冲突未采用' ? 'error' : 'default'" variant="tonal">{{ sub.status }}</v-chip>
                <span>{{ sub.by }} · {{ sub.capacity }}kW</span>
                <span class="muted">{{ new Date(sub.at).toLocaleTimeString('zh-CN') }}</span>
              </div>
            </div>
          </div>
        </v-col>
      </v-row>
    </div>

    <div class="panel mb-3">
      <div class="panel-head"><h3>各楼层供电余量</h3><span class="muted">按同时动作峰值核算</span></div>
      <v-row>
        <v-col v-for="fl in floorLoads" :key="fl.floor" cols="12" md="4">
          <div class="load-card" :class="{ over: fl.overloaded }">
            <div class="load-floor">{{ fl.floor }}</div>
            <div class="load-row"><span>容量</span><strong>{{ fl.capacity }} kW</strong></div>
            <div class="load-row"><span>同时峰值</span><strong>{{ fl.peak }} kW</strong></div>
            <div class="load-row"><span>余量</span><strong :class="{ neg: fl.margin < 0 }">{{ fl.margin }} kW</strong></div>
            <div v-if="fl.overloaded" class="load-over">超额 {{ fl.overload }} kW · 保安负荷照常启动</div>
            <div v-else class="load-ok">余量充足</div>
          </div>
        </v-col>
      </v-row>
    </div>

    <div class="panel table-wrap mb-3">
      <div class="panel-head"><h3>联动动作队列</h3><span class="muted">按实际启动时间排序 · 互锁与延时共同决定先后</span></div>
      <v-table hover>
        <thead>
          <tr><th>次序</th><th>规则</th><th>动作设备</th><th>楼层</th><th>功率</th><th>延时</th><th>优先级</th><th>互锁</th><th>计划启动</th><th>实际启动</th><th>状态</th><th>备注</th></tr>
        </thead>
        <tbody>
          <tr v-for="(job, index) in orderedJobs" :key="job.actionId" :class="{ 'row-over': job.status === '超额启动', 'row-queue': job.status === '排队中' }">
            <td class="mono">{{ index + 1 }}</td>
            <td class="mono">{{ job.ruleIds.join('、') }}</td>
            <td>
              <strong>{{ job.actionName }}</strong>
              <v-chip v-if="job.essential" size="x-small" color="error" variant="tonal" class="ml-1">保安负荷</v-chip>
            </td>
            <td>
              <v-select :model-value="job.floor" :items="['1F','2F','3F']" density="compact" hide-details style="max-width:86px" @update:model-value="(value) => store.changeDeviceFloor(job.actionId, String(value))" />
            </td>
            <td>{{ job.power }} kW</td>
            <td>{{ job.baseEarliest }} s</td>
            <td><v-chip size="x-small" :color="job.priority === 1 ? 'error' : job.priority === 2 ? 'warning' : 'default'" variant="tonal">{{ job.priority }}</v-chip></td>
            <td class="interlock">{{ job.interlocks.join('；') }}</td>
            <td class="mono">+{{ job.baseEarliest }}s</td>
            <td class="mono">{{ job.status === '排队中' ? '—' : `+${job.start}s` }}</td>
            <td>
              <v-chip size="small" :color="statusColor(job.status)" variant="tonal" :prepend-icon="statusIcon(job.status)">{{ job.status }}</v-chip>
            </td>
            <td>
              <span v-if="job.status === '超额启动'" class="over-text">超额 {{ job.overload }}kW 已计入</span>
              <span v-else-if="job.status === '排队中'" class="queue-text">{{ job.waitReason }}</span>
              <span v-else-if="job.start > job.baseEarliest" class="queue-text">排队推迟 {{ job.start - job.baseEarliest }}s 后启动</span>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </v-table>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>批次写盘与断点恢复</h3><span class="muted">已完成动作不重做</span></div>
      <div class="exec-bar">
        <v-switch v-model="failNextWrite" label="模拟下次写盘失败" color="warning" hide-details density="compact" />
        <v-btn color="primary" prepend-icon="mdi-content-save-outline" :disabled="!hasBatch || executedCount === totalCount" @click="store.executeBatch">执行批次写盘</v-btn>
        <v-btn color="success" variant="tonal" prepend-icon="mdi-play-box-outline" :disabled="!writeError" @click="store.resumeBatch">从断点恢复</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-restore" :disabled="executedCount === 0" @click="store.resetExecution">重置执行</v-btn>
        <v-spacer />
        <v-chip variant="tonal">已完成 {{ executedCount }} / {{ totalCount }}</v-chip>
        <v-chip v-if="writeError" color="error" variant="tonal" prepend-icon="mdi-alert-outline">断点 {{ checkpoint }}</v-chip>
      </div>
      <v-alert v-if="writeError" type="error" variant="tonal" density="compact" class="mt-3">{{ writeError }}</v-alert>
      <div class="exec-list">
        <div v-for="(job, index) in orderedJobs" :key="job.actionId" class="exec-row" :class="{ done: executions[job.actionId] === '已完成' }">
          <v-icon :icon="executions[job.actionId] === '已完成' ? 'mdi-check-circle' : 'mdi-circle-outline'" :color="executions[job.actionId] === '已完成' ? 'success' : 'default'" />
          <span class="mono">{{ index + 1 }}</span>
          <span>{{ job.actionName }}</span>
          <span class="muted">{{ job.floor }} · {{ job.power }}kW</span>
          <v-chip v-if="executions[job.actionId] === '已完成'" size="x-small" color="success" variant="tonal">已完成</v-chip>
          <v-chip v-else-if="writeError && index === checkpoint" size="x-small" color="error" variant="tonal">断点</v-chip>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0; }
.mb-3 { margin-bottom: 14px; }
.cap-card { padding: 14px; border: 1px solid #dde3e3; border-radius: 10px; background: #fbfcfc; }
.cap-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.cap-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cap-history { margin-top: 10px; display: grid; gap: 4px; }
.cap-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #59676d; }
.cap-row.conflict { color: #b23e2a; }
.load-card { padding: 14px; border: 1px solid #dde3e3; border-radius: 10px; background: white; }
.load-card.over { border-color: #d36b55; background: #fdf3f0; }
.load-floor { font-size: 13px; font-weight: 800; color: #293e45; margin-bottom: 8px; }
.load-row { display: flex; justify-content: space-between; font-size: 12px; color: #59676d; padding: 3px 0; }
.load-row strong { color: #293e45; }
.load-row strong.neg { color: #b23e2a; }
.load-over { margin-top: 8px; font-size: 11px; color: #b23e2a; font-weight: 700; }
.load-ok { margin-top: 8px; font-size: 11px; color: #3d7b63; font-weight: 700; }
.table-wrap { overflow-x: auto; }
.table-wrap :deep(table) { min-width: 1180px; }
.row-over { background: #fdf3f0; }
.row-queue { background: #fdf8ec; }
.mono { font-family: ui-monospace, monospace; color: #267078; font-weight: 700; }
.interlock { font-size: 12px; color: #59676d; max-width: 180px; }
.over-text { color: #b23e2a; font-size: 12px; font-weight: 700; }
.queue-text { color: #b87b22; font-size: 12px; }
.exec-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.exec-list { margin-top: 12px; display: grid; gap: 4px; }
.exec-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border: 1px solid #edf0f0; border-radius: 8px; font-size: 13px; }
.exec-row.done { background: #f3f9f6; }
.ml-1 { margin-left: 4px; }
</style>
