import type { EnvironmentSettings } from '@app/shared';
import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { envSettings } from '@/mock/settings';

export const useEnvironmentStore = defineStore('environment', () => {
  const settings = reactive<EnvironmentSettings>(JSON.parse(JSON.stringify(envSettings)));
  const saver = autoSave('settings', () => [{ key: 'environment', value: settings }], () => settings);
  async function hydrate() {
    const saved = await getOne<EnvironmentSettings>('settings', 'environment');
    if (saved) Object.assign(settings, saved);
    saver.start();
  }
  return { settings, hydrate };
});
