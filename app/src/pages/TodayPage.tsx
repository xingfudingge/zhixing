import { TodayIcon } from '../app/shell/icons';
import { PagePlaceholder } from './PagePlaceholder';

export function TodayPage() {
  return (
    <PagePlaceholder
      eyebrow="工作台 · 今天"
      title="今天"
      description="聚合今天到期的任务，并在列表、四象限与看板之间切换；逾期任务会顺延到今天处理。"
      pending="任务列表、四象限拖拽、看板状态与完成/撤销将在 P0-04 后续卡实现。"
      features={['列表 / 四象限 / 看板', '逾期顺延', '范围：今天 / 全部']}
      icon={<TodayIcon />}
    />
  );
}
