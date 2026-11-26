/** 路由入口：画板只作为笔记内全屏编辑深链；无 boardId 时回到知识页。 */

import { Navigate, useParams, useSearchParams } from 'react-router-dom';

import { BoardWorkspace } from '../features/board';

export function BoardPage() {
  const { boardId } = useParams<{ boardId?: string }>();
  const [searchParams] = useSearchParams();
  if (!boardId) {
    return <Navigate to="/knowledge" replace />;
  }
  return (
    <BoardWorkspace
      boardId={boardId}
      noteId={searchParams.get('note')}
    />
  );
}
