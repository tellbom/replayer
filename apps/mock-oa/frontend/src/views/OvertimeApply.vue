<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';

import { api } from '../api';

interface Option {
  value: string;
  label: string;
}

interface Approval {
  approverId: number;
  approverName: string;
  approvalToken: string;
}

const types = ref<Option[]>([]);
const approval = ref<Approval | null>(null);
const confirmVisible = ref(false);
const form = reactive({ type: '', startTime: '', endTime: '', reason: '' });

onMounted(async () => {
  types.value = (await api.get<Option[]>('/overtime/types')).data;
});

async function loadApprover() {
  approval.value = null;
  await sleep(500);
  approval.value = (await api.post<Approval>('/overtime/approver', { type: form.type })).data;
}

function openConfirm() {
  confirmVisible.value = true;
}

async function submit() {
  const currentApproval = approval.value;
  if (!currentApproval) {
    ElMessage.error('请先选择加班类型并等待审批人加载');
    return;
  }
  const response = await api.post<{ code: number; no: string }>('/overtime/submit', {
    ...form,
    approverId: currentApproval.approverId,
    approvalToken: currentApproval.approvalToken,
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
    <h1>加班申请</h1>
    <el-form label-width="100px">
      <el-form-item label="加班类型">
        <el-select v-model="form.type" placeholder="请选择" @change="loadApprover">
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
      <el-form-item label="审批人">
        <el-input :model-value="approval?.approverName ?? '—'" readonly />
      </el-form-item>
      <el-form-item>
        <el-button :class="$style.submitBtn" type="primary" role="button" @click="openConfirm">
          提交
        </el-button>
      </el-form-item>
    </el-form>

    <el-dialog v-model="confirmVisible" title="确认提交" width="420px">
      <p>确认提交当前加班申请吗？</p>
      <template #footer>
        <el-button @click="confirmVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">确认提交</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style module>
.submitBtn {
  min-width: 120px;
}
</style>
