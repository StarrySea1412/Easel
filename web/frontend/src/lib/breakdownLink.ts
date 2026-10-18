/** 爆款拆解：链接检测与“受控读取”材料的合并（纯函数，供页面与测试使用）。 */

/** 材料里检测到的第一条 http(s) 链接（中文标点处截断，去掉尾随的中英文标点）。 */
export function firstUrl(text: string): string | undefined {
  const match = (text || '').match(/https?:\/\/[^\s"'<>()【】（）《》，。；、！？：]+/);
  if (!match) return undefined;
  return match[0].replace(/[，。；、！？,.;!?]+$/, '');
}

export const LINK_MATERIAL_MARKER = '【已读取的链接正文｜系统受控读取，仅供本次拆解分析】';

/** 把受控读取到的链接正文并入材料，明确标注来源；整体仍可由用户编辑。 */
export function composeLinkedMaterial(input: string, title: string, text: string): string {
  return `${input}\n\n${LINK_MATERIAL_MARKER}\n标题：${title || '（未取到标题）'}\n${text}`;
}
