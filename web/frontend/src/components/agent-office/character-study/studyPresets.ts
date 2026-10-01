export type StudyPresetId = 'research' | 'writing' | 'design';
export type StudyView = 'work' | 'front' | 'side' | 'back' | 'hands';
export type StudyFur = 'amber' | 'oat' | 'slate';
export type StudySweater = 'sage' | 'ink' | 'clay';

export interface StudyAppearance { fur: StudyFur; sweater: StudySweater }

export const STUDY_PRESETS: { id: StudyPresetId; title: string; subtitle: string; details: string; stages: string[] }[] = [
  { id: 'research', title: '研究', subtitle: '资料放在手边', details: '侧置资料屏、打开的书本和索引架。双手围绕书页与资料移动。', stages: ['翻阅材料', '对照来源', '整理线索', '回看笔记'] },
  { id: 'writing', title: '文案', subtitle: '留出思考的空间', details: '宽桌面、独立键盘、稿件与靠右的显示器。输入和回读之间有停顿。', stages: ['阅读简报', '键入文稿', '停下来回读', '完成这一段'] },
  { id: 'design', title: '设计', subtitle: '围绕画面展开', details: '倾斜数位板、色卡和样张架。右爪握笔，左爪扶住画板。', stages: ['观察样张', '调整画面', '抬笔检查', '回到全图'] },
];

export const STUDY_FURS: { id: StudyFur; label: string; color: string; cream: string; marking: string }[] = [
  { id: 'amber', label: '焦糖', color: '#c48a54', cream: '#f4e5cc', marking: '#9c693e' },
  { id: 'oat', label: '燕麦', color: '#c2b59b', cream: '#f2eadb', marking: '#908572' },
  { id: 'slate', label: '雾灰', color: '#83959c', cream: '#e1e8e5', marking: '#526974' },
];

export const STUDY_SWEATERS: { id: StudySweater; label: string; color: string; trim: string }[] = [
  { id: 'sage', label: '鼠尾草', color: '#66847a', trim: '#d8dcca' },
  { id: 'ink', label: '午夜蓝', color: '#475b70', trim: '#b5c6c9' },
  { id: 'clay', label: '陶土', color: '#ae7560', trim: '#e1c5ac' },
];

export const STUDY_VIEWS: { id: StudyView; label: string }[] = [
  { id: 'work', label: '工作近景' }, { id: 'front', label: '正面' },
  { id: 'side', label: '侧面' }, { id: 'back', label: '背面' }, { id: 'hands', label: '手部' },
];
