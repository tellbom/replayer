<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { api } from '../api';

const loggedIn = ref(false);

onMounted(async () => {
  const response = await api.get<{ loggedIn: boolean }>('/session');
  loggedIn.value = response.data.loggedIn;
});

/** 模拟门户跳转：先取一次性 token，经 /sso/redirect 进入 OA（C19 场景）。 */
async function enterOa() {
  const response = await fetch('/sso/issue', { credentials: 'include' });
  if (!response.ok) return;
  const token = (await response.json()).token as string;
  location.href = `/sso/redirect?token=${encodeURIComponent(token)}`;
}
</script>

<template>
  <main class="page">
    <h1>企业门户</h1>
    <p v-if="!loggedIn">请先完成门户认证</p>
    <a v-else href="#" data-entry="oa" @click.prevent="enterOa">OA办公系统</a>
  </main>
</template>

<style scoped>
.page {
  padding: 24px;
}
</style>
