import { createRouter, createWebHistory } from 'vue-router';
import UserCard from './components/UserCard.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/users/:id',
      name: 'user-detail',
      component: UserCard,
    },
  ],
});
