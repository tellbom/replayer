<script setup lang="ts">
import { permissionMessage } from './api';
</script>

<template>
  <el-alert
    v-if="permissionMessage"
    :title="permissionMessage"
    type="error"
    show-icon
    closable
    @close="permissionMessage = ''"
  />
  <router-view />
</template>
