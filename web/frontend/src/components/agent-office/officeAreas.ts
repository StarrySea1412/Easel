export const OFFICE_AREAS = [
  { id: 'work', label: '工作区', description: '工位中的任务、状态和工具回执来自当前所选会话。点击员工可查看工作过程。' },
  { id: 'coffee', label: '茶水区', description: '咖啡机、杯架与高脚凳，工作室里的茶水角。' },
  { id: 'lounge', label: '休闲区', description: '靠窗的沙发与会客角。' },
  { id: 'fitness', label: '健身区', description: '瑜伽垫与哑铃架，留出舒展和活动的空间。' },
  { id: 'washroom', label: '卫生间', description: '独立隔间、洗手台与镜面。' },
] as const;

export type OfficeAreaId = typeof OFFICE_AREAS[number]['id'];
export type OfficeAreaView = OfficeAreaId | 'all';

export function officeAreaCenter(id: OfficeAreaId, width: number, depth: number): [number, number, number] {
  switch (id) {
    case 'work': return [0, .65, .4];
    case 'coffee': return [-width / 2 + 2.05, .7, -depth / 2 + 1.2];
    case 'lounge': return [width / 2 - 2.1, .65, -depth / 2 + 1.1];
    case 'fitness': return [width / 2 - 2.05, .5, depth / 2 - 1.15];
    case 'washroom': return [-width / 2 + .9, .75, depth / 2 - 1.6];
  }
}
