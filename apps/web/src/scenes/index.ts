import type { SceneId } from '@app/shared';
import type { Component } from 'vue';
import DateScene from './DateScene.vue';
import ExerciseScene from './ExerciseScene.vue';
import GameScene from './GameScene.vue';
import MealScene from './MealScene.vue';
import MusicScene from './MusicScene.vue';
import PokeScene from './PokeScene.vue';
import ReadScene from './ReadScene.vue';
import SleepScene from './SleepScene.vue';
import StudyScene from './StudyScene.vue';
import WatchScene from './WatchScene.vue';

/** 场景 id → 面板组件。场景的数据（名字、背景、提示词片段……）在 @app/shared 的 SCENES 里 */
export const SCENE_COMPONENTS: Partial<Record<SceneId, Component>> = {
  exercise: ExerciseScene,
  meal: MealScene,
  study: StudyScene,
  sleep: SleepScene,
  music: MusicScene,
  date: DateScene,
  poke: PokeScene,
  watch: WatchScene,
  game: GameScene,
  read: ReadScene,
};
