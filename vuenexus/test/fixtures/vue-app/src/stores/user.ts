import { defineStore } from 'pinia';

export const useUserStore = defineStore('user', {
  state: () => ({
    currentUser: { name: 'Ada' },
  }),
  actions: {
    fetchUser() {
      return { name: 'Ada' };
    },
  },
});
