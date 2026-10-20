declare const __EASEL_UI_VERSION__: string;
export type PageFailureStage = 'module_load' | 'render';
const pages: Record<string, string> = {
  '账号': 'accounts', '对话': 'chat', '设置': 'settings', '发布中心': 'publish',
  '生图工坊': 'images', '目标与定时任务': 'automations', '技能库': 'skills',
  '内容库': 'outputs', '运行记录': 'activity', 'Agent 办公室': 'office',
  '内容分析': 'analysis', '画像': 'profile', '热点雷达': 'trends',
  '内容日历': 'calendar', '选题库': 'ideas', '爆款拆解': 'breakdown',
};

/** Only fixed codes and compiled asset positions leave the browser; never error text or storage. */
export function pageFailureDetails(label: string, stage: PageFailureStage, error: unknown) {
  const name = error instanceof Error ? error.name : '';
  const exceptionType = ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'Error'].includes(name) ? name : 'Error';
  const code = stage === 'module_load' ? 'module_load_failed' : 'render_failed';
  const asset = error instanceof Error ? error.stack?.match(/\/assets\/([A-Za-z0-9_-]+\.js:\d{1,7}:\d{1,7})(?:\s|\)|$)/)?.[1] : undefined;
  return { operation: 'page_load', page: pages[label] || 'other', stage, code, exceptionType,
    ...(asset ? { asset: `assets/${asset}` } : {}),
    uiVersion: typeof __EASEL_UI_VERSION__ === 'string' ? __EASEL_UI_VERSION__ : 'development' };
}
export type PageFailureDetails = ReturnType<typeof pageFailureDetails>;
