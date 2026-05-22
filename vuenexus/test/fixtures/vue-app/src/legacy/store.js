import Vuex from 'vuex';

export default new Vuex.Store({
  state: {
    user: null,
  },
  actions: {
    loadUser() {
      return Promise.resolve();
    },
    saveUser() {
      return Promise.resolve();
    },
  },
  mutations: {
    setUser(state, user) {
      state.user = user;
    },
  },
});
