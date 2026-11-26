import { ListsIcon } from '../app/shell/icons';
import { PagePlaceholder } from './PagePlaceholder';

export function ListsPage() {
  return (
    <PagePlaceholder
      eyebrow="清单 · 分组"
      title="我的清单"
      description="用清单组织不同领域的任务，可设置颜色并按逾期、今天、以后、未安排和已完成分组查看。"
      pending="清单增删改、颜色与任务分组将在 P0-04 后续卡实现。"
      features={['新建 / 编辑 / 删除', '颜色与排序', '按状态分组']}
      icon={<ListsIcon />}
    />
  );
}
