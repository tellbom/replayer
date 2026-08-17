import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import { createApp } from 'vue';

import App from './App.vue';
import { api, refreshCsrfToken } from './api';
import { router } from './router';
import './style.css';

async function bootstrap() {
  const session = await api.get<{ loggedIn: boolean }>('/session');
  if (session.data.loggedIn) await refreshCsrfToken();

  createApp(App).use(ElementPlus).use(router).mount('#app');
}

void bootstrap();
