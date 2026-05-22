<template>
  <button @click="emitRefresh">{{ label }}</button>
</template>

<script setup lang="ts">
const props = defineProps<{ user: { name: string } }>();
const emit = defineEmits<{ refresh: [] }>();
const label = `Refresh ${props.user.name}`;

function emitRefresh() {
  emit('refresh');
}
</script>
