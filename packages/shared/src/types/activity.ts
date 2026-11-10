import type { ISODate, SyncMeta } from './common.ts';

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** 活动数据从哪里来 */
export type ActivitySource =
  | 'app' // App 内（实时运动、番茄钟、哄睡计时）
  | 'step-sensor' // 安卓计步传感器
  | 'health-connect' // 安卓 Health Connect
  | 'ios-shortcut' // iPhone 快捷指令推送的健康数据
  | 'screenshot' // 运动截图交给视觉模型识别
  | 'manual';

interface ActivityBase extends SyncMeta {
  characterId: string | null;
  date: ISODate;
  source: ActivitySource;
  note?: string;
}

export interface WorkoutLog extends ActivityBase {
  kind: 'workout';
  sport: 'run' | 'walk' | 'ride' | 'swim' | 'gym' | 'other';
  startedAt: number;
  durationSec: number;
  distanceKm?: number;
  steps?: number;
  /** 例如 6'01" */
  avgPace?: string;
  heartRate?: number;
}

export interface StepsLog extends ActivityBase {
  kind: 'steps';
  steps: number;
}

export interface MealLog extends ActivityBase {
  kind: 'meal';
  meal: MealSlot;
  at: number;
  food: string;
  photo?: string | null;
  /** 是否在"一起吃饭"场景里吃的 */
  together: boolean;
}

export interface StudyLog extends ActivityBase {
  kind: 'study';
  startedAt: number;
  minutes: number;
  pomodoros: number;
  tasks: { text: string; done: boolean }[];
  /** 专注时离开 App 的次数 */
  distractions: number;
}

export interface SleepLog extends ActivityBase {
  kind: 'sleep';
  bedtime: number;
  wakeAt: number | null;
  mode: 'chat' | 'story' | 'noise' | 'breath';
  wokeByCall: boolean;
}

export interface MusicLog extends ActivityBase {
  kind: 'music';
  songId: string;
  title: string;
  artist: string;
  at: number;
  together: boolean;
}

export interface DateLog extends ActivityBase {
  kind: 'date';
  place: string;
  startedAt: number;
  endedAt: number | null;
  cgAssetKeys: string[];
  summary: string;
}

export type ActivityLog = WorkoutLog | StepsLog | MealLog | StudyLog | SleepLog | MusicLog | DateLog;

/** "今日活动"汇总：注入【当前环境】、驱动主动消息规则、展示在"一起"页 */
export interface TodaySummary {
  date: ISODate;
  steps: number;
  workouts: WorkoutLog[];
  meals: Partial<Record<MealSlot, MealLog>>;
  studyMinutes: number;
  pomodoros: number;
  lastSleep: SleepLog | null;
  lastSong: MusicLog | null;
}
