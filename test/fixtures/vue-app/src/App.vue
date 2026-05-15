<template>
  <UserCard :user="currentUser" @refresh="refreshUser" />
  <RouterView />
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router';
import UserCard from './components/UserCard.vue';
import { useUser } from './composables/useUser';

const { currentUser, refreshUser } = useUser();
</script>
