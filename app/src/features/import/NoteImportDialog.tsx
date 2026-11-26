/**
 * 「导入笔记」弹层（ZX-IO-04）。
 *
 * 预检阶段逐文件读取/解析并在列表中展示标题、块数与警告；点「开始导入」
 * 后逐文件调用 `importNote`（Rust 单事务），任何一篇失败只影响该篇。
 * 本组件不直接访问 SQLite，也不把文件内容写进 DOM。
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { ImportNoteInput, Note } from '../../data/db/types';
import type { NoteFolder } from '../../data/repositories/notes';
import { Modal } from '../../app/a11y';
import { formatBytes } from '../export/utils';
import {
  createNoteImportBundle,
  NOTE_IMPORT_ACCEPT,
  NOTE_IMPORT_MAX_FILES,
  NOTE_IMPORT_MAX_TOTAL_BYTES,
  NoteImportError,
  noteImportFormatLabel,
  parseNoteImportFile,
  type ParsedNoteFile,
} from './noteImport';
import { NOTE_PACKAGE_MAX_BYTES } from '../export/note/package';
import {
  isNotePackageFile,
  NotePackageImportError,
  parseNotePackageFile,
  type ParsedNotePackage,
} from './notePackage';

export type NotePackageImportInput = {
  parsed: ParsedNotePackage;
  folderId: string | null;
};

export type NoteImportDialogProps = {
  folders: ReadonlyArray<NoteFolder>;
  defaultFolderId: string | null;
  /** 目标目录内已有标题（trim 后），用于同名提示与「跳过同名」。 */
  existingTitles: (folderId: string | null) => ReadonlySet<string>;
  /** 单文件原子写入；失败抛错即视为该文件失败，其他文件继续。 */
  importNote: (input: ImportNoteInput) => Promise<Note>;
  /** `.zxnote` 笔记包写入；不传时包文件会明确失败而不会退化。 */
  importPackage?: (input: NotePackageImportInput) => Promise<Note>;
  onClose: () => void;
  onOpenNote: (note: Note) => void;
};

type DuplicateStrategy = 'keep' | 'skip';

type ItemStatus =
  | 'pending'
  | 'ready'
  | 'warning'
  | 'importing'
  | 'imported'
  | 'skipped'
  | 'failed';

type ImportItem = {
  key: string;
  file: File;
  fileName: string;
  byteSize: number;
  status: ItemStatus;
  parsed?: ParsedNoteFile;
  package?: ParsedNotePackage;
  warnings: string[];
  errorCode?: string;
  errorMessage?: string;
  note?: Note;
};

type ImportSummary = {
  success: number;
  skipped: number;
  failed: number;
};

function messageOf(reason: unknown): { code: string; message: string } {
  if (reason instanceof NotePackageImportError) {
    return { code: reason.code, message: reason.message };
  }
  if (reason instanceof NoteImportError) {
    return { code: reason.code, message: reason.message };
  }
  if (reason instanceof Error) {
    return { code: 'IMPORT_WRITE_FAILED', message: reason.message };
  }
  return {
    code: 'IMPORT_WRITE_FAILED',
    message: typeof reason === 'string' ? reason : '导入失败',
  };
}

function statusLabel(status: ItemStatus): string {
  switch (status) {
    case 'pending':
      return '读取中…';
    case 'ready':
      return '待导入';
    case 'warning':
      return '待导入 · 有警告';
    case 'importing':
      return '导入中…';
    case 'imported':
      return '已导入';
    case 'skipped':
      return '已跳过';
    case 'failed':
      return '失败';
    default:
      return status;
  }
}

type PreparedUpload =
  | { kind: 'document'; parsed: ParsedNoteFile }
  | { kind: 'package'; package: ParsedNotePackage };

async function readFile(file: File): Promise<PreparedUpload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isNotePackageFile(file.name)) {
    return {
      kind: 'package',
      package: await parseNotePackageFile({ fileName: file.name, bytes }),
    };
  }
  return {
    kind: 'document',
    parsed: parseNoteImportFile({ fileName: file.name, bytes }),
  };
}

function uploadWarnings(upload: PreparedUpload): string[] {
  return upload.kind === 'package'
    ? upload.package.warnings
    : upload.parsed.warnings;
}

function uploadTitle(item: ImportItem): string {
  return (item.parsed?.title ?? item.package?.preview.title ?? '').trim();
}

function packageSummary(parsed: ParsedNotePackage): string {
  const preview = parsed.preview;
  return `知行笔记包 v${preview.formatVersion} · ${preview.blockCount} 个块 · ${
    preview.boardCount
  } 张画板（${preview.boardNodeCount} 节点 / ${
    preview.boardEdgeCount
  } 连线）· ${preview.attachmentCount} 个附件 · ${preview.todoCount} 个待办`;
}

export function NoteImportDialog({
  folders,
  defaultFolderId,
  existingTitles,
  importNote,
  importPackage,
  onClose,
  onOpenNote,
}: NoteImportDialogProps) {
  const inputId = useId();
  const [items, setItems] = useState<ImportItem[]>([]);
  const [folderId, setFolderId] = useState<string | null>(defaultFolderId);
  const [strategy, setStrategy] = useState<DuplicateStrategy>('keep');
  const [batchError, setBatchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const alive = useRef(true);
  const tokens = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const currentTitles = useMemo(
    () => existingTitles(folderId),
    [existingTitles, folderId],
  );

  const patchItem = useCallback(
    (key: string, patch: Partial<ImportItem>) => {
      setItems((current) =>
        current.map((item) =>
          item.key === key ? { ...item, ...patch } : item,
        ),
      );
    },
    [],
  );

  const prepareFiles = useCallback(
    async (files: ReadonlyArray<File>) => {
      tokens.current += 1;
      const token = tokens.current;
      setSummary(null);
      setBatchError(null);

      if (files.length === 0) {
        setItems([]);
        return;
      }
      if (files.length > NOTE_IMPORT_MAX_FILES) {
        setItems([]);
        setBatchError(`一次最多导入 ${NOTE_IMPORT_MAX_FILES} 个文件`);
        return;
      }
      const total = files.reduce((sum, file) => sum + file.size, 0);
      const hasPackage = files.some((file) =>
        isNotePackageFile(file.name),
      );
      const totalLimit = hasPackage
        ? NOTE_PACKAGE_MAX_BYTES
        : NOTE_IMPORT_MAX_TOTAL_BYTES;
      if (total > totalLimit) {
        setItems([]);
        setBatchError(
          hasPackage
            ? '所选笔记包合计超过 1 GiB，请分批导入'
            : '所选文件合计超过 100 MB，请分批导入',
        );
        return;
      }

      const next: ImportItem[] = files.map((file, index) => ({
        key: `${index}-${file.name}-${file.size}-${file.lastModified}`,
        file,
        fileName: file.name,
        byteSize: file.size,
        status: 'pending',
        warnings: [],
      }));
      setItems(next);

      let prepared = 0;
      let failed = 0;
      for (let index = 0; index < next.length; index += 1) {
        const item = next[index];
        try {
          const upload = await readFile(item.file);
          if (!alive.current || token !== tokens.current) {
            return;
          }
          prepared += 1;
          const warnings = uploadWarnings(upload);
          patchItem(
            item.key,
            upload.kind === 'package'
              ? {
                  status: warnings.length > 0 ? 'warning' : 'ready',
                  package: upload.package,
                  warnings,
                }
              : {
                  status: warnings.length > 0 ? 'warning' : 'ready',
                  parsed: upload.parsed,
                  warnings,
                },
          );
        } catch (reason) {
          if (!alive.current || token !== tokens.current) {
            return;
          }
          failed += 1;
          const error = messageOf(reason);
          patchItem(item.key, {
            status: 'failed',
            errorCode: error.code,
            errorMessage: error.message,
          });
        }
      }
      if (prepared === 0 && failed > 0) {
        setBatchError('没有可导入的文件，请查看下方每个文件的失败原因');
      }
    },
    [patchItem],
  );

  const startImport = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setBatchError(null);
    setSummary(null);
    const titles = new Set(currentTitles);
    const next = items.map((item) => ({ ...item }));
    let success = 0;
    let skipped = 0;
    let failed = next.filter((item) => item.status === 'failed').length;

    for (let index = 0; index < next.length; index += 1) {
      const item = next[index];
      if (
        (item.status !== 'ready' && item.status !== 'warning') ||
        (!item.parsed && !item.package)
      ) {
        continue;
      }
      const title = uploadTitle(item);
      if (strategy === 'skip' && titles.has(title)) {
        next[index] = {
          ...item,
          status: 'skipped',
          errorCode: undefined,
          errorMessage: undefined,
        };
        skipped += 1;
        setItems([...next]);
        continue;
      }

      next[index] = { ...item, status: 'importing' };
      setItems([...next]);
      try {
        let note: Note;
        if (item.package) {
          if (!importPackage) {
            throw new NotePackageImportError(
              'ZXNOTE_WRITE_FAILED',
              '当前数据源不支持导入知行笔记包',
            );
          }
          note = await importPackage({
            parsed: item.package,
            folderId,
          });
        } else if (item.parsed) {
          const bundle = createNoteImportBundle(item.parsed, { folderId });
          note = await importNote(bundle);
        } else {
          throw new NoteImportError(
            'IMPORT_NO_CONTENT',
            '文件没有可导入的内容',
          );
        }
        titles.add(title);
        next[index] = {
          ...item,
          status: 'imported',
          note,
          errorCode: undefined,
          errorMessage: undefined,
        };
        success += 1;
      } catch (reason) {
        const error = messageOf(reason);
        next[index] = {
          ...item,
          status: 'failed',
          errorCode: error.code,
          errorMessage: error.message,
        };
        failed += 1;
      }
      setItems([...next]);
    }

    setSummary({ success, skipped, failed });
    setBusy(false);
  };

  const retryFailed = async () => {
    if (busy) {
      return;
    }
    const failedItems = items.filter((item) => item.status === 'failed');
    if (failedItems.length === 0) {
      return;
    }
    setBusy(true);
    setSummary(null);
    setBatchError(null);
    const keys = new Set(failedItems.map((item) => item.key));
    setItems((current) =>
      current.map((item) =>
        keys.has(item.key)
          ? {
              ...item,
              status: 'pending',
              errorCode: undefined,
              errorMessage: undefined,
            }
          : item,
      ),
    );

    for (const item of failedItems) {
      try {
        const upload = await readFile(item.file);
        const warnings = uploadWarnings(upload);
        patchItem(
          item.key,
          upload.kind === 'package'
            ? {
                status: warnings.length > 0 ? 'warning' : 'ready',
                package: upload.package,
                warnings,
                errorCode: undefined,
                errorMessage: undefined,
              }
            : {
                status: warnings.length > 0 ? 'warning' : 'ready',
                parsed: upload.parsed,
                warnings,
                errorCode: undefined,
                errorMessage: undefined,
              },
        );
      } catch (reason) {
        const error = messageOf(reason);
        patchItem(item.key, {
          status: 'failed',
          errorCode: error.code,
          errorMessage: error.message,
        });
      }
    }
    setBusy(false);
  };

  const readyCount = items.filter(
    (item) => item.status === 'ready' || item.status === 'warning',
  ).length;
  const importedItems = items.filter(
    (item) => item.status === 'imported' && item.note,
  );

  const summaryText = summary
    ? summary.failed === 0 && summary.success > 0
      ? `全部导入成功：成功 ${summary.success} 篇${
          summary.skipped ? `，跳过 ${summary.skipped} 篇` : ''
        }`
      : summary.failed === 0
        ? `没有导入新笔记：跳过 ${summary.skipped} 篇`
        : summary.success === 0
          ? `导入失败：失败 ${summary.failed} 篇${
              summary.skipped ? `，跳过 ${summary.skipped} 篇` : ''
            }`
          : `部分成功：成功 ${summary.success} 篇 / 跳过 ${summary.skipped} 篇 / 失败 ${summary.failed} 篇`
    : '';

  return (
    <Modal
      open
      title="导入笔记"
      description="支持 Markdown（.md/.markdown）、HTML（.html/.htm）、纯文本（.txt），以及知行笔记包（.zxnote，包含块、画板与附件）。每篇笔记在独立事务中写入；解析或写库失败不会留下半成品。脚本、样式和外部资源不会导入。"
      onClose={onClose}
      busy={busy}
      className="kn-import-modal"
      footer={
        <div className="kn-modal-actions">
          {summary && summary.failed > 0 ? (
            <button
              type="button"
              className="kn-secondary-button"
              disabled={busy}
              onClick={() => void retryFailed()}
            >
              重试失败项
            </button>
          ) : null}
          <button
            type="button"
            className="kn-secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            关闭
          </button>
          <button
            type="button"
            className="kn-primary-button"
            disabled={busy || readyCount === 0}
            onClick={() => void startImport()}
          >
            {busy ? '正在导入…' : `开始导入${readyCount ? `（${readyCount}）` : ''}`}
          </button>
        </div>
      }
    >
      <div className="kn-import-picker">
          <input
            id={inputId}
            className="kn-import-file-input"
            type="file"
            multiple
            accept={NOTE_IMPORT_ACCEPT}
            aria-label="选择要导入的文件"
            disabled={busy}
            onChange={(event) => {
              const files = event.target.files
                ? Array.from(event.target.files)
                : [];
              event.target.value = '';
              void prepareFiles(files);
            }}
          />
          <label htmlFor={inputId} className="kn-secondary-button">
            选择文件
          </label>
          <span className="kn-import-hint">
            已选 {items.length} 个 · 最多 {NOTE_IMPORT_MAX_FILES} 个；
            Markdown/HTML/TXT ≤10 MB，.zxnote ≤1 GiB
          </span>
        </div>

        {batchError ? (
          <p className="kn-field-error" role="alert">
            {batchError}
          </p>
        ) : null}

        {items.length > 0 ? (
          <>
            <div className="kn-import-controls">
              <label className="kn-field">
                <span>目标目录</span>
                <select
                  aria-label="目标目录"
                  value={folderId ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setFolderId(event.target.value || null)
                  }
                >
                  <option value="">未分类</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="kn-import-fieldset" disabled={busy}>
                <legend>同名笔记</legend>
                <label>
                  <input
                    type="radio"
                    name="kn-import-duplicate"
                    checked={strategy === 'keep'}
                    onChange={() => setStrategy('keep')}
                  />
                  保留两者（默认）
                </label>
                <label>
                  <input
                    type="radio"
                    name="kn-import-duplicate"
                    checked={strategy === 'skip'}
                    onChange={() => setStrategy('skip')}
                  />
                  跳过同名
                </label>
              </fieldset>
            </div>

            <ul className="kn-import-list" aria-label="待导入文件">
              {items.map((item) => {
                const duplicate =
                  uploadTitle(item) !== '' &&
                  currentTitles.has(uploadTitle(item));
                return (
                  <li
                    key={item.key}
                    className={`kn-import-item is-${item.status}`}
                    data-import-status={item.status}
                  >
                    <div className="kn-import-item-head">
                      <strong title={item.fileName}>{item.fileName}</strong>
                      <span>{statusLabel(item.status)}</span>
                    </div>
                    <div className="kn-import-item-meta">
                      {formatBytes(item.byteSize)}
                      {item.parsed
                        ? ` · ${noteImportFormatLabel(item.parsed.format)} · ${
                            item.parsed.blocks.length
                          } 个块`
                        : item.package
                          ? ` · 知行笔记包 .zxnote · ${item.package.preview.blockCount} 个块`
                          : ''}
                    </div>
                    {item.parsed ? (
                      <div className="kn-import-item-title">
                        标题：{item.parsed.title}
                      </div>
                    ) : null}
                    {item.package ? (
                      <>
                        <div className="kn-import-item-title">
                          标题：{item.package.preview.title}
                        </div>
                        <div className="kn-import-item-meta">
                          {packageSummary(item.package)}
                        </div>
                        <div className="kn-import-item-meta">
                          导出时间：{item.package.preview.exportedAt || '—'}
                          {item.package.preview.folderName
                            ? ` · 原目录：${item.package.preview.folderName}`
                            : ' · 原目录：未分类'}
                        </div>
                        {item.package.preview.tags.length > 0 ? (
                          <div className="kn-import-item-meta">
                            标签：{item.package.preview.tags.join('、')}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                    {duplicate ? (
                      <p className="kn-import-item-warning" role="status">
                        {strategy === 'skip'
                          ? '目标目录已有同名笔记，导入时将跳过'
                          : '目标目录已有同名笔记，将保留两者'}
                      </p>
                    ) : null}
                    {item.warnings.length > 0 ? (
                      <ul className="kn-import-warnings">
                        {item.warnings.map((warning, index) => (
                          <li key={`${item.key}-w-${index}`}>{warning}</li>
                        ))}
                      </ul>
                    ) : null}
                    {item.status === 'failed' ? (
                      <p className="kn-field-error" role="alert">
                        {item.errorCode ? `${item.errorCode}：` : ''}
                        {item.errorMessage ?? '导入失败'}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        {summary ? (
          <section className="kn-import-summary" role="status">
            <h3>导入结果</h3>
            <p>{summaryText}</p>
            {importedItems.length > 0 ? (
              <ul className="kn-import-opened">
                {importedItems.map((item) => (
                  <li key={`open-${item.key}`}>
                    <span>{item.note?.title}</span>
                    <button
                      type="button"
                      className="kn-secondary-button"
                      onClick={() => {
                        if (item.note) {
                          onOpenNote(item.note);
                        }
                      }}
                    >
                      打开
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
    </Modal>
  );
}
