<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';

import { api } from '../api';

interface Option {
  value: string;
  label: string;
}

interface Balance {
  balanceId: number;
  balanceDays: number;
  balanceToken: string;
}

const types = ref<Option[]>([]);
const balance = ref<Balance | null>(null);
const confirmVisible = ref(false);
const form = reactive({ type: '', startTime: '', endTime: '', reason: '' });

onMounted(async () => {
  types.value = (await api.get<Option[]>('/leave/types')).data;
});

async function loadBalance() {
  balance.value = null;
  await sleep(500);
  balance.value = (await api.post<Balance>('/leave/balance', { type: form.type })).data;
}

async function submit() {
  const currentBalance = balance.value;
  if (!currentBalance) {
    ElMessage.error('请先选择请假类型并等待余额加载');
    return;
  }
  const response = await api.post<{ no: string }>('/leave/submit', {
    ...form,
    balanceId: currentBalance.balanceId,
    balanceToken: currentBalance.balanceToken,
  });
  confirmVisible.value = false;
  ElMessage.success(`提交成功：${response.data.no}`);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
</script>

<template>
  <main class="page">
    <h1>请假申请</h1>
    <el-form label-width="100px">
      <el-form-item label="请假类型">
        <el-select v-model="form.type" placeholder="请选择" @change="loadBalance">
          <el-option
            v-for="item in types"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="开始时间">
        <el-date-picker
          v-model="form.startTime"
          type="datetime"
          value-format="YYYY-MM-DD HH:mm:ss"
          :editable="false"
        />
      </el-form-item>
      <el-form-item label="结束时间">
        <el-date-picker
          v-model="form.endTime"
          type="datetime"
          value-format="YYYY-MM-DD HH:mm:ss"
          :editable="false"
        />
      </el-form-item>
      <el-form-item label="事由">
        <el-input v-model="form.reason" type="textarea" />
      </el-form-item>
      <el-form-item label="可用余额">
        <el-input :model-value="balance ? `${balance.balanceDays} 天` : '—'" readonly />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" role="button" @click="confirmVisible = true">提交</el-button>
      </el-form-item>
    </el-form>

    <el-dialog v-model="confirmVisible" title="确认提交" width="420px">
      <p>确认提交当前请假申请吗？</p>
      <template #footer>
        <el-button @click="confirmVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">确认提交</el-button>
      </template>
    </el-dialog>
  </main>
</template>
