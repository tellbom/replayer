import axios from 'axios';
import { ref } from 'vue';

export const permissionMessage = ref('');

export type ApiErrorAction = 'login' | 'forbidden' | 'propagate';

export function classifyApiError(status: number | undefined): ApiErrorAction {
  if (status === 401) return 'login';
  if (status === 403) return 'forbidden';
  return 'propagate';
}

export const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((config) => {
  const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
  if (csrf) config.headers.set('X-CSRF-TOKEN', csrf);
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (!axios.isAxiosError(error)) throw error;
    const action = classifyApiError(error.response?.status);
    if (action === 'login') window.location.assign('/login');
    if (action === 'forbidden') permissionMessage.value = '无权限';
    return Promise.reject(error);
  },
);

export async function refreshCsrfToken(): Promise<void> {
  const response = await api.get<{ token: string }>('/csrf');
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]');
  if (meta) meta.content = response.data.token;
}
