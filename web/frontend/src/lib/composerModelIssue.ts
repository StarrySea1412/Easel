import type { OfficeModelCapability, OfficeModelOption } from './officeControls';

/** Explains a local send guard; it does not claim an inference has failed. */
export function composerModelIssue(models: { loading: boolean; error: string; modelRef: string; options: OfficeModelOption[]; capability: OfficeModelCapability | null }): string {
  let reason: string;
  const option = models.options.find(item => item.id === (models.modelRef || models.capability?.currentModelRef || models.capability?.defaultModelRef));
  const label = option ? `${option.channelName || option.provider} · ${option.model}` : models.modelRef;
  if (models.loading) reason = '正在读取模型配置，请稍候再发送。';
  else if (models.error) reason = `模型配置读取失败：${models.error}`;
  else if (option?.enabled === false) reason = `“${label}”已停用，请在模型设置启用或选择其他模型。`;
  else if (models.modelRef && !option) reason = `已选模型“${label}”已移除或尚未配置，请重新选择模型。`;
  else if (models.capability?.available === false) {
    const detail = models.capability.reason || '';
    reason = /无法只读核验|尚未核验.*指定模型|连接验证失败/.test(detail)
      ? 'OpenClaw 连接检查未通过。'
      : /未连接|离线/.test(detail) ? 'OpenClaw 未连接，正在尝试恢复。'
      : detail || '当前引擎暂时无法使用所选模型，请打开模型设置。';
  }
  else reason = '模型配置尚未确认，请刷新模型状态或打开模型设置。';
  return `${reason} 草稿已保留，消息尚未发送。`;
}

/** Older versions saved model guards in the upload-error field. */
export function isLegacyComposerModelIssue(error: string): boolean {
  return /无法只读核验当前网关|所选模型暂不可用，草稿已保留|草稿已保留，消息尚未发送/.test(error);
}
