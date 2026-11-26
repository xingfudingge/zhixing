import type { EditorBlock } from '../../../data/repositories/blocks';
import { blockLabel } from './registry';

type UnknownBlockProps = {
  block: EditorBlock;
};

/** 未知块必须保留原 payload；这里只读展示，避免旧客户端丢数据。 */
export function UnknownBlock({ block }: UnknownBlockProps) {
  const json = (() => {
    try {
      return JSON.stringify(block.payload, null, 2);
    } catch {
      return '{}';
    }
  })();
  return (
    <div className="zxe-unknown" role="group" aria-label="未知块">
      <div className="zxe-unknown-head">
        <span aria-hidden="true">?</span>
        <strong>{blockLabel(block.type)}</strong>
        <span>payload 已原样保留</span>
      </div>
      <pre className="zxe-unknown-json">{json}</pre>
    </div>
  );
}
