import type { HHMM, ISODate, SyncMeta } from './common.ts';

export type ProactiveTriggerId =
  | 'morning'
  | 'wake-call'
  | 'breakfast'
  | 'lunch'
  | 'dinner'
  | 'sedentary'
  | 'weather'
  | 'followup'
  | 'miss-you'
  | 'bedtime'
  | 'workout-praise'
  | 'study-checkin'
  | 'anniversary';

export interface ProactiveRule {
  id: ProactiveTriggerId;
  label: string;
  desc: string;
  enabled: boolean;
  /** 只在这个时段内触发 */
  window?: { start: HHMM; end: HHMM };
  cooldownMin: number;
  /** 命中后真正发送的概率 0-1，让主动消息不那么机械 */
  probability: number;
  /** 这个触发器可以升级成来电 */
  canCall: boolean;
}

/** 默认规则表（Worker 的 Cron 每 5 分钟按它判定） */
export const DEFAULT_PROACTIVE_RULES: ProactiveRule[] = [
  { id: 'morning', label: '早安', desc: '起床时间后说早安，顺带天气', enabled: true, window: { start: '07:00', end: '09:30' }, cooldownMin: 720, probability: 1, canCall: false },
  { id: 'wake-call', label: '叫醒来电', desc: '在你设的起床时间打电话叫醒你', enabled: true, cooldownMin: 720, probability: 1, canCall: true },
  { id: 'breakfast', label: '早饭', desc: '早饭时段还没记录就暗示一下', enabled: true, window: { start: '07:30', end: '09:30' }, cooldownMin: 180, probability: 0.8, canCall: false },
  { id: 'lunch', label: '午饭', desc: '午饭时段还没吃先暗示，超时再邀约', enabled: true, window: { start: '11:30', end: '13:30' }, cooldownMin: 120, probability: 0.9, canCall: false },
  { id: 'dinner', label: '晚饭', desc: '"我有点饿了…你吃了吗？"', enabled: true, window: { start: '17:30', end: '19:30' }, cooldownMin: 120, probability: 0.9, canCall: false },
  { id: 'sedentary', label: '久坐提醒', desc: '两小时没动就拉你起来走走', enabled: true, window: { start: '09:30', end: '21:00' }, cooldownMin: 150, probability: 0.6, canCall: false },
  { id: 'weather', label: '天气变化', desc: '要下雨、降温、预警时提醒', enabled: true, cooldownMin: 360, probability: 1, canCall: false },
  { id: 'followup', label: '待跟进', desc: '你提过的事到期了会来问结果', enabled: true, cooldownMin: 60, probability: 1, canCall: false },
  { id: 'miss-you', label: '想你了', desc: '太久没聊就主动找你', enabled: true, cooldownMin: 240, probability: 0.5, canCall: true },
  { id: 'bedtime', label: '催睡 / 晚安', desc: '过了睡觉时间还在玩手机就催你', enabled: true, window: { start: '23:00', end: '02:00' }, cooldownMin: 60, probability: 0.9, canCall: true },
  { id: 'workout-praise', label: '运动夸夸', desc: '发现新的运动记录就夸你', enabled: true, cooldownMin: 60, probability: 1, canCall: false },
  { id: 'study-checkin', label: '学习打卡', desc: '连续学习的日子会记得夸你', enabled: false, cooldownMin: 720, probability: 0.7, canCall: false },
  { id: 'anniversary', label: '纪念日', desc: '相识 N 天、生日、约定的日子', enabled: true, cooldownMin: 1440, probability: 1, canCall: true },
];

/**
 * 一天的主动消息计划（"先规划、再触发"）：
 * 云端规划器按规则持续维护当天及跨午夜的 Touchpoint，Cron 每 5 分钟触发到点的那些，
 * 消息内容在触发时才生成（用最新的上下文）。id = `${date}:${characterId}:${ruleId}`，Worker 触发和打开 App 补发都是幂等的。
 * 安卓壳把 planned 的 dueAt 设成精确闹钟，不依赖推送也能准点。
 */
export interface Touchpoint extends SyncMeta {
  characterId: string;
  ruleId: ProactiveTriggerId;
  date: ISODate;
  /** 排期使用的用户时区；旧版已保存的计划可能没有此字段。 */
  timezone?: string;
  dueAt: number;
  action: 'message' | 'voice' | 'call' | 'image';
  /** 给主动消息智能体的提示，例如"暗示该吃晚饭了，别直接说" */
  hint: string;
  status: 'planned' | 'fired' | 'skipped' | 'delivered' | 'opened';
  messageId?: string;
  /** 例如"你 20 分钟内刚聊过"、"勿扰时段"、"今天已达上限" */
  skipReason?: string;
}

/**
 * 推送通道。不用 FCM（要谷歌服务，国内不稳定）：
 * - webpush：iPhone 主屏 PWA（走 APNs，国内可用）和电脑浏览器
 * - android：安卓壳自己轮询 + 精确闹钟，出本地通知 / 全屏来电
 * - webhook：Bark、ntfy、PushPlus、Server酱、企业微信、钉钉……都是"按模板发一个 HTTP 请求"
 */
export type PushChannelKind = 'webpush' | 'android' | 'webhook';

export type WebhookPreset = 'bark' | 'ntfy' | 'pushplus' | 'serverchan' | 'wecom' | 'dingtalk' | 'custom';

export interface PushChannel extends SyncMeta {
  kind: PushChannelKind;
  preset?: WebhookPreset;
  label: string;
  enabled: boolean;
  deviceName?: string;
  /** webhook 的地址模板等；密钥类配置只存在 Worker */
  config: Record<string, string>;
  lastOkAt?: number | null;
}

export const WEBHOOK_PRESETS: Record<WebhookPreset, { label: string; desc: string }> = {
  bark: { label: 'Bark', desc: 'iPhone 推送 App，国内稳定' },
  ntfy: { label: 'ntfy', desc: '开源推送，可自建服务器' },
  pushplus: { label: 'PushPlus', desc: '推送到微信' },
  serverchan: { label: 'Server酱', desc: '推送到微信' },
  wecom: { label: '企业微信', desc: '群机器人 webhook' },
  dingtalk: { label: '钉钉', desc: '群机器人 webhook' },
  custom: { label: '自定义', desc: '任意 HTTP 请求模板' },
};

/** 通知在锁屏上显示什么 */
export type NotificationPreview = 'full' | 'name-only' | 'hidden';
