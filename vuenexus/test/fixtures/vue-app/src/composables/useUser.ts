import { useUserStore } from '../stores/user';

export function useUser() {
  const config = { path: '/not-a-route', component: 'Nope' };
  const userStore = useUserStore();

  function refreshUser() {
    void config;
    userStore.fetchUser();
  }

  return {
    currentUser: userStore.currentUser,
    refreshUser,
  };
}
