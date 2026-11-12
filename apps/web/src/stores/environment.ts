import type { EnvironmentSettings } from '@app/shared';
import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { autoSave, getOne, write } from '@/db/idb';
import { envSettings } from '@/mock/settings';

/** 国内的时区：判断"上海"是不是以前的演示默认值时用 */
const CHINA_ZONES = new Set(['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Urumqi', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei', 'PRC']);

/** 这台设备的时区 */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export const useEnvironmentStore = defineStore('environment', () => {
  const settings = reactive<EnvironmentSettings>(JSON.parse(JSON.stringify(envSettings)));
  const saver = autoSave('settings', () => [{ key: 'environment', value: settings }], () => settings);
  async function hydrate() {
    const [saved, migrated] = await Promise.all([getOne<EnvironmentSettings>('settings', 'environment'), getOne<boolean>('settings', 'envWeatherV2')]);
    if (saved) Object.assign(settings, saved);
    if (saved && !migrated) {
      // 天气接上真实数据之前，"和风天气"和"上海"只是演示用的默认值，没有真的用过：
      // 来源改成自动（国内用和风、其他地方用 Open-Meteo）；设备不在国内时清掉"上海"，免得在美国看到上海的天气
      if ((settings.weatherProvider as string) === 'qweather') settings.weatherProvider = 'auto';
      if (settings.city === '上海' && !CHINA_ZONES.has(deviceTimezone())) settings.city = '';
      await write('settings', [
        { key: 'environment', value: JSON.parse(JSON.stringify(settings)) },
        { key: 'envWeatherV2', value: true },
      ]);
    } else if (!saved) {
      await write('settings', [{ key: 'envWeatherV2', value: true }]);
    }
    saver.start();
  }
  return { settings, hydrate };
});
