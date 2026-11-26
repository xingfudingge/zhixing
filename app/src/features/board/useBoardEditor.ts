/**
 * 画板文档 + 撤销栈。
 *
 * 拖动/缩放属于一次操作：pointerdown 调用 beginTransaction()，移动过程
 * 只更新瞬时文档，pointerup 时再决定是否压入撤销栈，避免每个 pointermove
 * 都产生一步历史。
 */

import { useCallback, useRef, useState } from 'react';

import { cloneJson, snapshotOf } from './model';
import { HISTORY_LIMIT, type BoardDocument, type BoardSnapshot } from './types';

type Transaction = {
  base: BoardSnapshot;
};

function restoreSnapshot(
  document: BoardDocument,
  snapshot: BoardSnapshot,
): BoardDocument {
  return {
    ...document,
    title: snapshot.title,
    nodes: cloneJson(snapshot.nodes),
    edges: cloneJson(snapshot.edges),
  };
}

function sameSnapshot(document: BoardDocument, snapshot: BoardSnapshot): boolean {
  return (
    document.title === snapshot.title &&
    JSON.stringify(document.nodes) === JSON.stringify(snapshot.nodes) &&
    JSON.stringify(document.edges) === JSON.stringify(snapshot.edges)
  );
}

export type BoardEditorController = {
  document: BoardDocument;
  apply: (mutator: (document: BoardDocument) => BoardDocument) => BoardDocument;
  beginTransaction: () => void;
  updateTransient: (
    mutator: (document: BoardDocument) => BoardDocument,
  ) => BoardDocument;
  endTransaction: (commit: boolean) => void;
  undo: () => void;
  redo: () => void;
  reset: (document: BoardDocument) => void;
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
};

export function useBoardEditor(initial: BoardDocument): BoardEditorController {
  const [document, setDocument] = useState<BoardDocument>(initial);
  const [past, setPast] = useState<BoardSnapshot[]>([]);
  const [future, setFuture] = useState<BoardSnapshot[]>([]);
  const documentRef = useRef(document);
  const transactionRef = useRef<Transaction | null>(null);

  const updateDocument = useCallback((next: BoardDocument) => {
    documentRef.current = next;
    setDocument(next);
  }, []);

  const pushPast = useCallback((snapshot: BoardSnapshot) => {
    setPast((previous) => [
      ...previous.slice(-(HISTORY_LIMIT - 1)),
      snapshot,
    ]);
    setFuture([]);
  }, []);

  const apply = useCallback(
    (mutator: (current: BoardDocument) => BoardDocument) => {
      const current = documentRef.current;
      const next = mutator(current);
      if (next === current) {
        return current;
      }
      pushPast(snapshotOf(current));
      updateDocument(next);
      return next;
    },
    [pushPast, updateDocument],
  );

  const beginTransaction = useCallback(() => {
    transactionRef.current = { base: snapshotOf(documentRef.current) };
  }, []);

  const updateTransient = useCallback(
    (mutator: (current: BoardDocument) => BoardDocument) => {
      const current = documentRef.current;
      const next = mutator(current);
      if (next !== current) {
        updateDocument(next);
      }
      return next;
    },
    [updateDocument],
  );

  const endTransaction = useCallback(
    (commit: boolean) => {
      const transaction = transactionRef.current;
      transactionRef.current = null;
      if (!commit || !transaction) {
        return;
      }
      if (sameSnapshot(documentRef.current, transaction.base)) {
        return;
      }
      pushPast(transaction.base);
    },
    [pushPast],
  );

  const undo = useCallback(() => {
    if (past.length === 0) {
      return;
    }
    const previous = past[past.length - 1];
    const current = documentRef.current;
    setPast(past.slice(0, -1));
    setFuture((next) => [snapshotOf(current), ...next].slice(0, HISTORY_LIMIT));
    updateDocument(restoreSnapshot(current, previous));
  }, [past, updateDocument]);

  const redo = useCallback(() => {
    if (future.length === 0) {
      return;
    }
    const nextSnapshot = future[0];
    const current = documentRef.current;
    setFuture(future.slice(1));
    setPast((previous) => [
      ...previous.slice(-(HISTORY_LIMIT - 1)),
      snapshotOf(current),
    ]);
    updateDocument(restoreSnapshot(current, nextSnapshot));
  }, [future, updateDocument]);

  const reset = useCallback(
    (next: BoardDocument) => {
      transactionRef.current = null;
      setPast([]);
      setFuture([]);
      updateDocument(next);
    },
    [updateDocument],
  );

  return {
    document,
    apply,
    beginTransaction,
    updateTransient,
    endTransaction,
    undo,
    redo,
    reset,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoDepth: past.length,
    redoDepth: future.length,
  };
}
