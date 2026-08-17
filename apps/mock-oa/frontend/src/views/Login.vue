<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { api, refreshCsrfToken } from '../api';

const router = useRouter();
const form = reactive({ username: '', password: '' });
const error = ref('');

async function login() {
  error.value = '';
  try {
    await api.post('/login', form);
    await refreshCsrfToken();
    await router.push('/home');
  } catch {
    error.value = '登录失败';
  }
}
</script>

<template>
  <main class="page">
    <h1>Mock OA 登录</h1>
    <el-form label-width="80px" @submit.prevent="login">
      <el-form-item label="用户名">
        <el-input v-model="form.username" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input v-model="form.password" type="password" show-password />
      </el-form-item>
      <el-alert v-if="error" :title="error" type="error" />
      <el-button type="primary" native-type="submit">登录</el-button>
    </el-form>
  </main>
</template>
