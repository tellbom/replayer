<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api } from '../api';

interface HistoryItem {
  no: string;
  type: string;
  reason: string;
  createdAt: string;
}

const items = ref<HistoryItem[]>([]);

onMounted(async () => {
  const response = await api.get<{ list: HistoryItem[] }>('/overtime/history?page=1&size=20');
  items.value = response.data.list;
});
</script>

<template>
  <main class="page">
    <h1>历史记录</h1>
    <el-table :data="items" height="480">
      <el-table-column prop="no" label="单号" />
      <el-table-column prop="type" label="类型" />
      <el-table-column prop="reason" label="事由" />
      <el-table-column prop="createdAt" label="创建时间" />
      <el-table-column label="操作">
        <template #default><el-button>查看</el-button></template>
      </el-table-column>
    </el-table>
  </main>
</template>
