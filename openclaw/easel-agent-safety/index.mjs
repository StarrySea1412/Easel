import { registerPresent } from './present.mjs';
import { registerImage } from './image.mjs';
import { registerTasks } from './tasks.mjs';
import { registerPlan } from './plan.mjs';
import { runtimeToolParams } from './runtime.mjs';

function readModel(config) {
  const value = config?.agents?.defaults?.subagents?.model;
  if (typeof value === 'string') return value.trim();
  if (value && typeof value.primary === 'string') return value.primary.trim();
  return '';
}

function readLimit(config, key, fallback) {
  const value = Number(config?.agents?.defaults?.subagents?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export default {
  id: 'easel-agent-safety',
  name: 'Easel Agent Safety',
  description: 'Require the configured Agent startup model and bound delegation limits.',
  register(api) {
    registerPresent(api);
    registerImage(api);
    registerTasks(api);
    registerPlan(api);
    api.on('before_tool_call', (event, ctx) => runtimeToolParams(event, ctx, api.config),
      { matcher: ['exec', 'view_image'], priority: 110, timeoutMs: 15000 });
    api.on('before_tool_call', (event) => {
      if (event.toolName !== 'sessions_spawn' && event.toolName !== 'spawn_agent') return;
      const startupModel = readModel(api.config);
      if (!startupModel) {
        return { block: true, blockReason: 'Easel 未配置 Agent 启动模型，已阻止子 Agent 调用。请先在设置中选择启动模型。' };
      }
      const params = event.params && typeof event.params === 'object' ? event.params : {};
      const requested = typeof params.model === 'string' ? params.model.trim() : '';
      if (requested && requested !== startupModel) {
        return { block: true, blockReason: `Agent 启动模型已锁定为 ${startupModel}，拒绝改用其他模型，避免产生未确认费用。` };
      }
      const timeout = Number(params.runTimeoutSeconds);
      const limit = readLimit(api.config, 'runTimeoutSeconds', 900);
      if (Number.isFinite(timeout) && timeout > limit) {
        return { block: true, blockReason: `Agent 单任务上限为 ${limit} 秒，拒绝更长的未确认任务。` };
      }
      return undefined;
    }, { matcher: ['sessions_spawn', 'spawn_agent'], priority: 100, timeoutMs: 15000 });
  },
};
