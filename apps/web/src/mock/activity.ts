import type { WeatherSnapshot } from '@app/shared';
import { at } from '@/utils/time';

export const weather: WeatherSnapshot & { icon: string; tomorrowC: number; aqi: number } = {
  city: '上海',
  text: '小雨',
  tempC: 12,
  outlook: '明天降到 6°C',
  icon: 'i-lucide-cloud-rain',
  tomorrowC: 6,
  aqi: 42,
};

export interface TodayView {
  steps: number;
  stepGoal: number;
  workout: { sport: string; distanceKm: number; durationSec: number; pace: string; at: string } | null;
  meals: Record<'breakfast' | 'lunch' | 'dinner', { food: string; at: string } | null>;
  studyMin: number;
  pomodoros: number;
  lastSleep: { bed: string; wake: string; hours: number };
  lastSong: string;
}

/** 按当前时刻合成"今天"的活动，保证任何时候打开预览都不会出现未来的记录 */
export function mockToday(now = new Date()): TodayView {
  const h = now.getHours() + now.getMinutes() / 60;
  const ratio = Math.max(0, Math.min(1, (h - 7) / 15));
  return {
    steps: Math.round(ratio * 9300),
    stepGoal: 8000,
    workout: h >= 8.7 ? { sport: '跑步', distanceKm: 5.2, durationSec: 1880, pace: `6'01"`, at: '08:05' } : null,
    meals: {
      breakfast: h >= 8.4 ? { food: '豆浆油条', at: '08:10' } : null,
      lunch: h >= 12.8 ? { food: '牛肉拉面', at: '12:30' } : null,
      dinner: null,
    },
    studyMin: h >= 17 ? 50 : h >= 11 ? 25 : 0,
    pomodoros: h >= 17 ? 2 : h >= 11 ? 1 : 0,
    lastSleep: { bed: '00:20', wake: '07:20', hours: 7 },
    lastSong: '雨停之前',
  };
}

/** 一句话描述今天，注入【当前环境】 */
export function todayLine(t: TodayView): string {
  const parts = [`你今天走了 ${t.steps.toLocaleString('zh-CN')} 步`];
  if (t.workout) parts.push(`早上跑了 ${t.workout.distanceKm} 公里`);
  if (t.meals.lunch) parts.push(`午饭吃了${t.meals.lunch.food}`);
  else if (t.meals.breakfast) parts.push(`早饭吃了${t.meals.breakfast.food}`);
  parts.push(t.meals.dinner ? '晚饭吃过了' : '晚饭还没记录');
  return parts.join('，');
}

/** 最近 7 天（含今天），用于运动和学习的小柱状图 */
export const week = {
  labels: ['一', '二', '三', '四', '五', '六', '日'],
  steps: [6120, 9840, 4310, 11200, 7650, 3020, 8430],
  studyMin: [90, 120, 45, 150, 60, 0, 50],
  sleepHours: [6.2, 7.5, 5.8, 7.0, 6.6, 8.4, 7.0],
};

export const workouts = [
  { id: 'w1', sport: '跑步', distanceKm: 5.2, durationSec: 1880, pace: `6'01"`, when: at(-1, '08:05'), source: 'App 内记录' },
  { id: 'w2', sport: '步行', distanceKm: 3.4, durationSec: 2580, pace: `12'39"`, when: at(-2, '19:40'), source: 'Health Connect' },
  { id: 'w3', sport: '游泳', distanceKm: 1.0, durationSec: 1500, pace: '2\'30"/100m', when: at(-4, '17:10'), source: '快捷指令' },
];

