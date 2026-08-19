import { createRouter, createWebHistory } from 'vue-router';

import History from './views/History.vue';
import Home from './views/Home.vue';
import LeaveApply from './views/LeaveApply.vue';
import Login from './views/Login.vue';
import OvertimeApply from './views/OvertimeApply.vue';
import Portal from './views/Portal.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/portal' },
    { path: '/portal', component: Portal },
    { path: '/login', component: Login },
    { path: '/home', component: Home },
    { path: '/leave/apply', component: LeaveApply },
    { path: '/overtime/apply', component: OvertimeApply },
    { path: '/history', component: History },
  ],
});
