import { reactive } from 'vue';

/** 所有本机数据并发读取完成前，不开放编辑，也不启动后台任务。 */
export const startup = reactive({ ready: false, error: false });
