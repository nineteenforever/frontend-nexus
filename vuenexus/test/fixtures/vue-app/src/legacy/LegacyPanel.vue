<template>
  <section>
    <p>{{ title }}</p>
    <button @click="loadUser">Load</button>
    <button @click="saveUser">Save</button>
    <p>{{ displayName }}</p>
    <p>{{ localCount }}</p>
    <missing-widget />
  </section>
</template>

<script>
import { mapActions } from 'vuex';
import { legacyMixin } from './mixin';
import MissingMixin from './missing-mixin';

export default {
  name: 'LegacyPanel',
  mixins: [legacyMixin, MissingMixin],
  props: {
    title: String,
  },
  data() {
    return {
      localCount: 0,
    };
  },
  computed: {
    displayName() {
      return this.title.toUpperCase();
    },
  },
  methods: {
    ...mapActions(['loadUser']),
    saveUser() {
      this.$store.dispatch('saveUser');
      this.loadUser();
    },
  },
};
</script>
