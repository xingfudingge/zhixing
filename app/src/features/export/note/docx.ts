/**
 * 单篇笔记 → 真 OOXML `.docx`（规范 §5.5）。
 *
 * 不引入第三方 docx 库：复用 `export/zip.ts` 的 STORE ZIP 写入器，手工生成
 * WordprocessingML。最小包结构包含 document/styles/numbering/settings/
 * header/footer/docProps 与 `word/media/*`：
 * - 标题使用 `Title` 样式，标题 1–5 使用 `Heading1–5` + outlineLvl；
 * - 表格保留表头、对齐、gridSpan/vMerge 与列宽比例；
 * - 列表使用真正的 numbering.xml（不是文字冒充）；
 * - 图片按 96 dpi 换算 EMU，最大宽 16 cm，等比缩放；
 * - 外链使用真实 `w:hyperlink` + relationship；内链只输出“《标题》”。
 *
 * 生成后立刻用 `readZip` 回读并解析 `word/document.xml`；任何结构错误都
 * 抛 `GENERATE_FAILED`，不把损坏文件交给保存面板。
 */

import {
  codeFenceLanguage,
  tableAnchorAt,
  type TableCell,
  type TableModel,
} from '../../editor/types';
import { createZip, readZip, type ZipWriteEntry } from '../zip';
import { formatBytes, formatDateTime } from '../utils';
import type {
  NoteExportBlock,
  NoteExportBoardAsset,
  NoteExportDocument,
  NoteExportRenderResult,
  NoteExportRun,
} from './types';
import { NoteExportError } from './types';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8');

const CONTENT_WIDTH_TWIPS = 9638;
const MAX_IMAGE_WIDTH_EMU = Math.round((16 / 2.54) * 96 * 9525);
const MAX_IMAGE_HEIGHT_EMU = Math.round((22 / 2.54) * 96 * 9525);
/** 正文可用宽度（A4 + 20 mm 页边距 = 170 mm）；画板不得超宽。 */
const BOARD_MAX_WIDTH_EMU = Math.min(
  MAX_IMAGE_WIDTH_EMU,
  CONTENT_WIDTH_TWIPS * 635,
);
const EMU_PER_CSS_PX = 9525;

type Relationship = {
  id: string;
  type: string;
  target: string;
  targetMode?: 'External';
};

type Media = {
  path: string;
  bytes: Uint8Array;
  extension: string;
  mime: string;
};

type DocxContext = {
  relationships: Relationship[];
  nextRelId: number;
  media: Media[];
  imageCount: number;
  boardCount: number;
  /** 同一画板资源复用一个 relationship + media，避免重复写 PNG。 */
  boardEmbeds: Map<
    NoteExportBoardAsset,
    { id: string; width: number; height: number }
  >;
  docPrId: number;
  hyperlinkIds: Map<string, string>;
  orderedGroups: number[];
  currentOrderedGroup: number | null;
  orderedGroupCounter: number;
  headerRelId: string;
  footerRelId: string;
};

function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hexColor(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const raw = match[1]!;
  return (raw.length === 3
    ? raw
        .split('')
        .map((part) => `${part}${part}`)
        .join('')
    : raw
  ).toUpperCase();
}

function relId(context: DocxContext): string {
  const id = `rId${context.nextRelId}`;
  context.nextRelId += 1;
  return id;
}

function addRelationship(
  context: DocxContext,
  type: string,
  target: string,
  targetMode?: 'External',
): string {
  const id = relId(context);
  context.relationships.push({ id, type, target, ...(targetMode ? { targetMode } : {}) });
  return id;
}

function hyperlinkId(context: DocxContext, url: string): string {
  const existing = context.hyperlinkIds.get(url);
  if (existing) {
    return existing;
  }
  const id = addRelationship(
    context,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
    url,
    'External',
  );
  context.hyperlinkIds.set(url, id);
  return id;
}

function textXml(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  return lines
    .map(
      (line, index) =>
        `${index > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEscape(
          line,
        )}</w:t>`,
    )
    .join('');
}

type RunOptions = {
  hyperlink?: boolean;
  internal?: boolean;
  bold?: boolean;
  color?: string;
  size?: number;
  font?: string;
};

function runProperties(run: NoteExportRun, options: RunOptions = {}): string {
  const parts: string[] = [];
  if (options.hyperlink) {
    parts.push('<w:rStyle w:val="Hyperlink"/>');
  } else if (options.internal) {
    parts.push('<w:rStyle w:val="InternalLink"/>');
  }
  if (options.font || run.code) {
    const font = options.font ?? 'Consolas';
    parts.push(
      `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`,
    );
  }
  if (options.bold || run.bold) {
    parts.push('<w:b/>');
  }
  if (run.italic) {
    parts.push('<w:i/>');
  }
  if (run.strike) {
    parts.push('<w:strike/>');
  }
  const color = hexColor(options.color) ?? hexColor(run.color);
  if (color) {
    parts.push(`<w:color w:val="${color}"/>`);
  }
  if (options.size) {
    parts.push(`<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>`);
  }
  if (run.underline) {
    parts.push('<w:u w:val="single"/>');
  }
  const background = hexColor(run.background);
  if (background) {
    parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${background}"/>`);
  } else if (run.code) {
    parts.push('<w:shd w:val="clear" w:color="auto" w:fill="F4F6FA"/>');
  }
  return parts.length > 0 ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

function runXml(
  run: NoteExportRun,
  options: RunOptions = {},
): string {
  return `<w:r>${runProperties(run, options)}${textXml(run.text)}</w:r>`;
}

function plainRun(text: string, options: RunOptions = {}): string {
  return runXml({ text }, options);
}

function runsXml(
  runs: ReadonlyArray<NoteExportRun>,
  context: DocxContext,
  options: RunOptions = {},
): string {
  return runs
    .map((run) => {
      if (run.link && !run.link.internal) {
        const id = hyperlinkId(context, run.link.href);
        return `<w:hyperlink r:id="${id}" w:history="1">${runXml(run, {
          ...options,
          hyperlink: true,
        })}</w:hyperlink>`;
      }
      if (run.link?.internal) {
        const label = run.text.trim() || '站内笔记';
        const text = label.startsWith('《') ? label : `《${label}》`;
        return runXml({ ...run, text }, { ...options, internal: true });
      }
      return runXml(run, options);
    })
    .join('');
}

function paragraph(
  content: string,
  properties = '',
): string {
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${content}</w:p>`;
}

function styleParagraph(
  styleId: string,
  content: string,
  extra = '',
): string {
  return paragraph(content, `<w:pStyle w:val="${styleId}"/>${extra}`);
}

function alignment(align: 'left' | 'center' | 'right' | undefined): string {
  return align && align !== 'left' ? `<w:jc w:val="${align}"/>` : '';
}

function indentTwips(indent: number): number {
  return Math.max(0, Math.min(6, indent)) * 420;
}

function metaTable(document: NoteExportDocument): string {
  const rows: Array<[string, string]> = [
    ['创建', formatDateTime(document.meta.createdAt)],
    ['更新', formatDateTime(document.meta.updatedAt)],
    ['目录', document.meta.folderName || '未分类'],
    ['标签', document.meta.tags.length > 0 ? document.meta.tags.map((tag) => `#${tag}`).join('、') : '—'],
    ['字数', `约 ${document.meta.wordCount.toLocaleString('zh-Hans-CN')} 字`],
  ];
  if (document.meta.status === 'trashed') {
    rows.push(['状态', '回收站 · 只读快照']);
  }
  const cell = (text: string, width: number, bold = false): string =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${styleParagraph(
      'Meta',
      runsXml([{ text, ...(bold ? { bold: true } : {}) }], emptyContext()),
    )}</w:tc>`;
  const rowXml = rows
    .map(
      ([label, value]) =>
        `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(label, 1500, true)}${cell(
          value,
          8138,
        )}</w:tr>`,
    )
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="8138"/></w:tblGrid>${rowXml}</w:tbl>`;
}

/** 元信息表格的文本不产生图片/超链接关系，用空上下文即可。 */
function emptyContext(): DocxContext {
  return {
    relationships: [],
    nextRelId: 1,
    media: [],
    imageCount: 0,
    boardCount: 0,
    boardEmbeds: new Map(),
    docPrId: 1,
    hyperlinkIds: new Map(),
    orderedGroups: [],
    currentOrderedGroup: null,
    orderedGroupCounter: 0,
    headerRelId: '',
    footerRelId: '',
  };
}

function tocXml(document: NoteExportDocument): string {
  if (document.toc.length === 0) {
    return '';
  }
  return [
    styleParagraph('TOCHeading', plainRun('目录')),
    ...document.toc.map((heading) =>
      paragraph(
        plainRun(heading.text),
        `<w:pStyle w:val="TOC1"/><w:ind w:left="${(heading.level - 1) * 240}"/>`,
      ),
    ),
    paragraph(''),
  ].join('');
}

function tableColumnWidths(model: TableModel): number[] {
  const columns = Math.max(1, model.rows[0]?.length ?? model.widths.length);
  const widths = Array.from({ length: columns }, (_, index) => {
    const value = model.widths[index];
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : 140;
  });
  const total = widths.reduce((sum, width) => sum + width, 0) || columns;
  return widths.map((width) =>
    Math.max(600, Math.round((CONTENT_WIDTH_TWIPS * width) / total)),
  );
}

function cellParagraphs(
  text: string,
  align: 'left' | 'center' | 'right',
  bold: boolean,
): string {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length === 0) {
    return paragraph('');
  }
  return lines
    .map((line) =>
      paragraph(
        plainRun(line, {
          ...(bold ? { bold: true } : {}),
          ...(align !== 'left' ? { color: '252C38' } : {}),
        }),
        `<w:spacing w:before="40" w:after="40" w:line="280" w:lineRule="auto"/><w:jc w:val="${align}"/>`,
      ),
    )
    .join('');
}

function cellXml(
  cell: TableCell,
  width: number,
  options: {
    header: boolean;
    gridSpan?: number;
    vMerge?: 'restart' | 'continue';
  },
): string {
  const properties: string[] = [`<w:tcW w:w="${width}" w:type="dxa"/>`];
  if (options.gridSpan && options.gridSpan > 1) {
    properties.push(`<w:gridSpan w:val="${options.gridSpan}"/>`);
  }
  if (options.vMerge === 'restart') {
    properties.push('<w:vMerge w:val="restart"/>');
  } else if (options.vMerge === 'continue') {
    properties.push('<w:vMerge/>');
  }
  if (options.header) {
    properties.push('<w:shd w:val="clear" w:color="auto" w:fill="F1F4F8"/>');
  }
  properties.push('<w:vAlign w:val="center"/>');
  return `<w:tc><w:tcPr>${properties.join('')}</w:tcPr>${
    options.vMerge === 'continue'
      ? paragraph('')
      : cellParagraphs(cell.text, cell.align, options.header)
  }</w:tc>`;
}

function tableXml(model: TableModel): string {
  if (model.rows.length === 0 || (model.rows[0]?.length ?? 0) === 0) {
    return paragraph(plainRun('（空表格）'));
  }
  const widths = tableColumnWidths(model);
  const rows: string[] = [];
  for (let rowIndex = 0; rowIndex < model.rows.length; rowIndex += 1) {
    const row = model.rows[rowIndex] ?? [];
    const cells: string[] = [];
    for (let column = 0; column < widths.length; column += 1) {
      const cell = row[column];
      if (!cell) {
        continue;
      }
      if (cell.covered) {
        const anchor = tableAnchorAt(model, rowIndex, column);
        if (!anchor) {
          cells.push(cellXml({ text: '', align: 'left', rowSpan: 1, colSpan: 1, covered: false }, widths[column] ?? 600, { header: false }));
          continue;
        }
        if (anchor.row === rowIndex) {
          // 同一行的水平合并由锚点的 gridSpan 覆盖。
          continue;
        }
        if (column !== anchor.column) {
          continue;
        }
        const spanWidth = widths
          .slice(anchor.column, anchor.column + anchor.cell.colSpan)
          .reduce((sum, value) => sum + value, 0);
        cells.push(
          cellXml(
            { ...anchor.cell, text: '' },
            spanWidth,
            {
              header: model.header && rowIndex === 0,
              gridSpan: anchor.cell.colSpan,
              vMerge: 'continue',
            },
          ),
        );
        column += anchor.cell.colSpan - 1;
        continue;
      }
      const spanWidth = widths
        .slice(column, column + cell.colSpan)
        .reduce((sum, value) => sum + value, 0);
      cells.push(
        cellXml(cell, spanWidth, {
          header: model.header && rowIndex === 0,
          gridSpan: cell.colSpan,
          vMerge: cell.rowSpan > 1 ? 'restart' : undefined,
        }),
      );
      column += cell.colSpan - 1;
    }
    const rowProperties = [
      '<w:cantSplit/>',
      ...(model.header && rowIndex === 0 ? ['<w:tblHeader/>'] : []),
    ].join('');
    rows.push(`<w:tr><w:trPr>${rowProperties}</w:trPr>${cells.join('')}</w:tr>`);
  }
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D8DDE7"/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

function imageSize(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } {
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width > 0 && height > 0) return { width, height };
  }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const width = bytes[6]! | (bytes[7]! << 8);
    const height = bytes[8]! | (bytes[9]! << 8);
    if (width > 0 && height > 0) return { width, height };
  }
  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = Math.abs(view.getInt32(18, true));
    const height = Math.abs(view.getInt32(22, true));
    if (width > 0 && height > 0) return { width, height };
  }
  if (
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (length < 2) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
        if (width > 0 && height > 0) return { width, height };
      }
      offset += 2 + length;
    }
  }
  if (/webp/i.test(mime) && bytes.length > 30) {
    // VP8X: 24-bit little-endian canvas width/height minus one.
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    if (width > 0 && height > 0) return { width, height };
  }
  return { width: 600, height: 400 };
}

function imageExtension(asset: {
  mime: string;
  fileName: string;
}): { extension: string; contentType: string } | null {
  const mime = asset.mime.toLowerCase();
  if (mime === 'image/png') return { extension: 'png', contentType: 'image/png' };
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return { extension: 'jpg', contentType: 'image/jpeg' };
  }
  if (mime === 'image/gif') return { extension: 'gif', contentType: 'image/gif' };
  if (mime === 'image/bmp') return { extension: 'bmp', contentType: 'image/bmp' };
  if (mime === 'image/webp') return { extension: 'webp', contentType: 'image/webp' };
  if (mime === 'image/svg+xml') {
    return { extension: 'svg', contentType: 'image/svg+xml' };
  }
  const extension = asset.fileName.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(extension)) {
    return {
      extension: extension === 'jpeg' ? 'jpg' : extension,
      contentType:
        extension === 'jpg' || extension === 'jpeg'
          ? 'image/jpeg'
          : `image/${extension}`,
    };
  }
  return null;
}

function imageParagraph(
  block: Extract<NoteExportBlock, { kind: 'image' }>,
  context: DocxContext,
  warnings: string[],
): string {
  const asset = block.asset;
  if (
    !asset ||
    asset.status !== 'available' ||
    !asset.bytes ||
    asset.bytes.byteLength === 0
  ) {
    return styleParagraph(
      'Caption',
      runsXml(
        [
          {
            text: `［图片缺失：${block.fileName || asset?.fileName || '未命名图片'}］${
              block.missingReason ? `（${block.missingReason}）` : ''
            }`,
          },
        ],
        context,
      ),
    );
  }
  const format = imageExtension(asset);
  if (!format) {
    warnings.push(
      `图片「${asset.fileName}」格式 ${asset.mime || '未知'} 无法写入 Word，已改为占位符。`,
    );
    return styleParagraph(
      'Caption',
      runsXml([{ text: `［图片格式不支持：${asset.fileName}］` }], context),
    );
  }
  context.imageCount += 1;
  const mediaPath = `word/media/image${context.imageCount}.${format.extension}`;
  context.media.push({
    path: mediaPath,
    bytes: asset.bytes,
    extension: format.extension,
    mime: format.contentType,
  });
  const id = addRelationship(
    context,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    mediaPath.replace(/^word\//, ''),
  );
  const dimensions = imageSize(asset.bytes, asset.mime);
  let width = dimensions.width * 9525;
  let height = dimensions.height * 9525;
  if (width > MAX_IMAGE_WIDTH_EMU) {
    height = Math.round((height * MAX_IMAGE_WIDTH_EMU) / width);
    width = MAX_IMAGE_WIDTH_EMU;
  }
  if (height > MAX_IMAGE_HEIGHT_EMU) {
    width = Math.round((width * MAX_IMAGE_HEIGHT_EMU) / height);
    height = MAX_IMAGE_HEIGHT_EMU;
  }
  context.docPrId += 1;
  const docPrId = context.docPrId;
  const name = xmlEscape(asset.fileName || `图片${context.imageCount}`);
  const drawing = `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="80"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="${name}" descr="${name}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${name}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const caption = styleParagraph(
    'Caption',
    runsXml([{ text: `${asset.fileName} · ${formatBytes(asset.byteSize)}` }], context),
  );
  return `${drawing}${caption}`;
}

function boardDrawingXml(
  id: string,
  width: number,
  height: number,
  title: string,
  context: DocxContext,
): string {
  context.docPrId += 1;
  const docPrId = context.docPrId;
  const name = xmlEscape(title || '画板');
  // keepNext 保证图片段与图注段不跨页拆开（Word 会尽量把两段放同页）。
  const drawing = `<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/><w:spacing w:before="120" w:after="40"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="${name}" descr="${name}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${name}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const caption = styleParagraph(
    'Caption',
    runsXml([{ text: `画板：${title || '未命名画板'}` }], context),
  );
  return `${drawing}${caption}`;
}

/**
 * 画板块：有 PNG 资源时按正文宽度等比嵌入并复用 media relationship；
 * 空/缺/坏时输出明确的文字占位，绝不退化成普通段落。
 */
function boardImageParagraph(
  block: Extract<NoteExportBlock, { kind: 'board' }>,
  context: DocxContext,
  warnings: string[],
): string {
  const asset = block.asset;
  const title = block.title || '未命名画板';
  if (
    !asset ||
    asset.status !== 'available' ||
    !asset.bytes ||
    asset.bytes.byteLength === 0
  ) {
    const reason = block.missingReason || '数据缺失';
    return styleParagraph(
      'Caption',
      runsXml([{ text: `🖼 画板：${title}（${reason}）` }], context),
    );
  }

  const existing = context.boardEmbeds.get(asset);
  if (existing) {
    return boardDrawingXml(
      existing.id,
      existing.width,
      existing.height,
      title,
      context,
    );
  }

  const format = imageExtension(asset);
  if (!format) {
    warnings.push(
      `画板「${title}」图片格式 ${asset.mime || '未知'} 无法写入 Word，已改为占位符。`,
    );
    return styleParagraph(
      'Caption',
      runsXml([{ text: `🖼 画板：${title}（渲染格式不支持）` }], context),
    );
  }

  context.boardCount += 1;
  const mediaPath = `word/media/board-${context.boardCount}.${format.extension}`;
  context.media.push({
    path: mediaPath,
    bytes: asset.bytes,
    extension: format.extension,
    mime: format.contentType,
  });
  const id = addRelationship(
    context,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    mediaPath.replace(/^word\//, ''),
  );

  const naturalWidth = Math.max(1, block.width ?? asset.width);
  const naturalHeight = Math.max(1, block.height ?? asset.height);
  let width = Math.round(naturalWidth * EMU_PER_CSS_PX);
  let height = Math.round((width * naturalHeight) / naturalWidth);
  if (width > BOARD_MAX_WIDTH_EMU) {
    height = Math.round((height * BOARD_MAX_WIDTH_EMU) / width);
    width = BOARD_MAX_WIDTH_EMU;
  }
  if (height > MAX_IMAGE_HEIGHT_EMU) {
    width = Math.round((width * MAX_IMAGE_HEIGHT_EMU) / height);
    height = MAX_IMAGE_HEIGHT_EMU;
  }

  context.boardEmbeds.set(asset, { id, width, height });
  return boardDrawingXml(id, width, height, title, context);
}

function formulaXml(
  block: Extract<NoteExportBlock, { kind: 'formula' }>,
  context: DocxContext,
): string {
  if (!block.latex.trim()) {
    return styleParagraph('Caption', runsXml([{ text: '（空公式）' }], context));
  }
  if (block.display === 'inline') {
    return paragraph(
      runsXml(
        [
          { text: '$' },
          { text: block.latex, code: true },
          { text: '$' },
        ],
        context,
      ),
    );
  }
  return [
    styleParagraph('Caption', plainRun('公式（LaTeX 源）')),
    styleParagraph('Code', plainRun(block.latex, { font: 'Consolas' })),
    paragraph(''),
  ].join('');
}

function blockXml(
  block: NoteExportBlock,
  context: DocxContext,
  warnings: string[],
): string {
  switch (block.kind) {
    case 'paragraph':
      return paragraph(
        runsXml(block.runs, context),
        alignment(block.align),
      );
    case 'heading': {
      const level = Math.max(1, Math.min(5, block.level));
      return styleParagraph(
        `Heading${level}`,
        runsXml(block.runs, context),
        alignment(block.align),
      );
    }
    case 'todo':
      return paragraph(
        `${plainRun(block.checked ? '☑ ' : '☐ ')}${runsXml(block.runs, context)}`,
        `<w:ind w:left="${indentTwips(block.indent)}"/>`,
      );
    case 'bullet':
      return paragraph(
        runsXml(block.runs, context),
        `<w:numPr><w:ilvl w:val="${Math.min(6, block.indent)}"/><w:numId w:val="1"/></w:numPr>`,
      );
    case 'ordered': {
      const group = context.currentOrderedGroup ?? 1;
      return paragraph(
        runsXml(block.runs, context),
        `<w:numPr><w:ilvl w:val="${Math.min(6, block.indent)}"/><w:numId w:val="${group}"/></w:numPr>`,
      );
    }
    case 'quote': {
      const source = [
        block.source,
        block.noteTitle ? `关联笔记《${block.noteTitle}》` : '',
        block.sourceUrl,
      ]
        .filter(Boolean)
        .join(' · ');
      return [
        styleParagraph('Quote', runsXml(block.runs, context)),
        source
          ? styleParagraph('QuoteSource', plainRun(source))
          : '',
      ].join('');
    }
    case 'code': {
      const language = codeFenceLanguage(block.language);
      const lines = block.code.split(/\r\n|\r|\n/);
      return [
        language
          ? styleParagraph('Caption', plainRun(`代码 · ${language}`))
          : '',
        ...lines.map((line) =>
          styleParagraph('Code', line ? plainRun(line, { font: 'Consolas' }) : ''),
        ),
      ].join('');
    }
    case 'divider':
      return paragraph(
        '',
        '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D8DDE7"/></w:pBdr><w:spacing w:before="120" w:after="120"/>',
      );
    case 'table':
      return tableXml(block.model);
    case 'image':
      return imageParagraph(block, context, warnings);
    case 'file': {
      const file = block.file;
      const status =
        file.status === 'missing'
          ? ' · 文件缺失'
          : file.status === 'pending'
            ? ' · 待同步'
            : '';
      return styleParagraph(
        'Caption',
        runsXml(
          [
            {
              text: `📎 ${file.fileName || '未命名文件'}（${formatBytes(
                file.byteSize,
              )}）${status}`,
            },
          ],
          context,
        ),
      );
    }
    case 'board':
      return boardImageParagraph(block, context, warnings);
    case 'formula':
      return formulaXml(block, context);
    case 'link': {
      if (block.internal) {
        const label = block.title || '站内笔记';
        return paragraph(
          runsXml(
            [{ text: label.startsWith('《') ? label : `《${label}》`, link: { href: block.url, internal: true, noteId: null } }],
            context,
          ),
        );
      }
      if (!block.url) {
        return paragraph(plainRun(block.title));
      }
      return paragraph(
        runsXml(
          [
            {
              text: block.title || block.url,
              link: { href: block.url, internal: false, noteId: null },
            },
          ],
          context,
        ),
      );
    }
    case 'unknown':
      return paragraph(
        plainRun(
          block.text
            ? `［无法导出的块：${block.blockType}］ ${block.text}`
            : `［无法导出的块：${block.blockType}］`,
        ),
      );
  }
}

function stylesXml(): string {
  const headingStyle = (level: number, size: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="252C38"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="240"/><w:jc w:val="left"/></w:pPr><w:rPr><w:b/><w:color w:val="252C38"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
${headingStyle(1, 44)}
${headingStyle(2, 36)}
${headingStyle(3, 31)}
${headingStyle(4, 27)}
${headingStyle(5, 24)}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D8DDE7"/></w:pBdr><w:ind w:left="360"/><w:spacing w:before="80" w:after="80"/></w:pPr><w:rPr><w:color w:val="59636F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="QuoteSource"><w:name w:val="Quote Source"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:jc w:val="right"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:color w:val="7F8999"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F6FA"/><w:spacing w:before="0" w:after="0" w:line="260" w:lineRule="auto"/><w:ind w:left="120" w:right="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="20" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="59636F"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="40" w:after="120" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="7F8999"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:color w:val="252C38"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="20" w:line="280" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="59636F"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="7F8999"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="7F8999"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2F5D8A"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="InternalLink"><w:name w:val="Internal Link"/><w:rPr><w:color w:val="2F5D8A"/></w:rPr></w:style>
</w:styles>`;
}

function numberingXml(context: DocxContext): string {
  const bulletCharacters = ['•', '◦', '▪'];
  const bulletLevels = Array.from({ length: 7 }, (_, level) => {
    const character = bulletCharacters[level % bulletCharacters.length]!;
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${character}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + level * 420}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr></w:lvl>`;
  }).join('');
  const decimalLevels = Array.from({ length: 7 }, (_, level) => {
    const text = `%${level + 1}.`;
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + level * 420}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:lvl>`;
  }).join('');
  const nums = [
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
    ...context.orderedGroups.map(
      (numId) =>
        `<w:num w:numId="${numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
    ),
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bulletLevels}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimalLevels}</w:abstractNum>${nums}</w:numbering>`;
}

function relationshipsXml(relationships: ReadonlyArray<Relationship>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships
    .map(
      (relationship) =>
        `<Relationship Id="${relationship.id}" Type="${relationship.type}" Target="${xmlEscape(
          relationship.target,
        )}"${relationship.targetMode ? ` TargetMode="${relationship.targetMode}"` : ''}/>`,
    )
    .join('')}</Relationships>`;
}

function contentTypesXml(media: ReadonlyArray<Media>): string {
  const defaults = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']);
  media.forEach((item) => defaults.add(item.extension));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Array.from(
    defaults,
  )
    .map(
      (extension) =>
        `<Default Extension="${extension}" ContentType="${
          extension === 'jpg' || extension === 'jpeg'
            ? 'image/jpeg'
            : extension === 'svg'
              ? 'image/svg+xml'
              : `image/${extension}`
        }"/>`,
    )
    .join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

function coreXml(document: NoteExportDocument): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(
    document.title,
  )}</dc:title><dc:creator>知行</dc:creator><cp:lastModifiedBy>知行</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${xmlEscape(
    document.meta.createdAt,
  )}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${xmlEscape(
    document.meta.updatedAt,
  )}</dcterms:modified></cp:coreProperties>`;
}

function appXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>知行</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><Company>知行</Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>`;
}

function headerXml(document: NoteExportDocument): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(
    document.title,
  )}</w:t></w:r></w:p></w:hdr>`;
}

function footerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:r><w:t xml:space="preserve">第 </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> / </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> 页 · 知行</w:t></w:r></w:p></w:ftr>`;
}

function settingsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:defaultTabStop w:val="420"/><w:characterSpacingControl w:val="doNotCompress"/></w:settings>`;
}

function documentXml(
  document: NoteExportDocument,
  context: DocxContext,
  warnings: string[],
): string {
  const body: string[] = [];
  body.push(styleParagraph('Title', runsXml([{ text: document.title }], context)));
  if (document.options.includeMetadata) {
    body.push(metaTable(document));
  }
  body.push(tocXml(document));

  if (document.blocks.length === 0) {
    body.push(paragraph(plainRun('（空笔记）')));
  }

  for (const block of document.blocks) {
    if (block.kind === 'ordered') {
      if (context.currentOrderedGroup === null) {
        context.orderedGroupCounter += 1;
        context.currentOrderedGroup = 1 + context.orderedGroupCounter;
        context.orderedGroups.push(context.currentOrderedGroup);
      }
    } else {
      context.currentOrderedGroup = null;
    }
    body.push(blockXml(block, context, warnings));
  }

  const sectPr = `<w:sectPr><w:headerReference w:type="default" r:id="${context.headerRelId}"/><w:footerReference w:type="default" r:id="${context.footerRelId}"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="680" w:footer="680" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="312"/></w:sectPr>`;
  body.push(sectPr);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join(
    '',
  )}</w:body></w:document>`;
}

function createContext(): DocxContext {
  const context: DocxContext = {
    ...emptyContext(),
  };
  const stylesRel = addRelationship(
    context,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
    'styles.xml',
  );
  const numberingRel = addRelationship(
    context,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
    'numbering.xml',
  );
  const settingsRel = addRelationship(
    context,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
    'settings.xml',
  );
  context.headerRelId = addRelationship(
    context,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
    'header1.xml',
  );
  context.footerRelId = addRelationship(
    context,
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
    'footer1.xml',
  );
  // 前五个关系固定为样式/编号/设置/页眉/页脚；记录以便断言。
  void stylesRel;
  void numberingRel;
  void settingsRel;
  return context;
}

function opcRelationships(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

async function validateDocx(bytes: Uint8Array): Promise<void> {
  let entries;
  try {
    entries = await readZip(bytes);
  } catch (reason) {
    throw new NoteExportError(
      'GENERATE_FAILED',
      `Word 生成失败：ZIP 结构无法回读（${
        reason instanceof Error ? reason.message : '未知错误'
      }）`,
    );
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const required = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/numbering.xml',
  ];
  const missing = required.filter((path) => !byPath.has(path));
  if (missing.length > 0) {
    throw new NoteExportError(
      'GENERATE_FAILED',
      `Word 生成失败：缺少 ${missing.join('、')}`,
    );
  }
  const documentEntry = byPath.get('word/document.xml')!;
  const xml = DECODER.decode(documentEntry.data);
  if (typeof DOMParser !== 'undefined') {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    if (parsed.getElementsByTagName('parsererror').length > 0) {
      throw new NoteExportError(
        'GENERATE_FAILED',
        'Word 生成失败：word/document.xml 不是合法 XML',
      );
    }
  }
  const mediaEntries = entries.filter((entry) =>
    entry.path.startsWith('word/media/'),
  );
  const relationshipEntry = byPath.get('word/_rels/document.xml.rels');
  if (mediaEntries.length > 0 && !relationshipEntry) {
    throw new NoteExportError(
      'GENERATE_FAILED',
      'Word 生成失败：图片缺少关系文件',
    );
  }
  if (relationshipEntry) {
    const rels = DECODER.decode(relationshipEntry.data);
    for (const media of mediaEntries) {
      const target = media.path.replace(/^word\//, '');
      if (!rels.includes(`Target="${target}"`)) {
        throw new NoteExportError(
          'GENERATE_FAILED',
          `Word 生成失败：图片关系缺失 ${media.path}`,
        );
      }
    }
  }
}

function dedupe(items: ReadonlyArray<string>): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

export async function renderNoteDocx(
  document: NoteExportDocument,
): Promise<NoteExportRenderResult> {
  const warnings: string[] = [...document.warnings];
  const context = createContext();
  const body = documentXml(document, context, warnings);

  const entries: ZipWriteEntry[] = [
    { path: '[Content_Types].xml', data: ENCODER.encode(contentTypesXml(context.media)) },
    { path: '_rels/.rels', data: ENCODER.encode(opcRelationships()) },
    { path: 'word/document.xml', data: ENCODER.encode(body) },
    { path: 'word/styles.xml', data: ENCODER.encode(stylesXml()) },
    { path: 'word/numbering.xml', data: ENCODER.encode(numberingXml(context)) },
    { path: 'word/settings.xml', data: ENCODER.encode(settingsXml()) },
    { path: 'word/header1.xml', data: ENCODER.encode(headerXml(document)) },
    { path: 'word/footer1.xml', data: ENCODER.encode(footerXml()) },
    {
      path: 'word/_rels/document.xml.rels',
      data: ENCODER.encode(relationshipsXml(context.relationships)),
    },
    { path: 'docProps/core.xml', data: ENCODER.encode(coreXml(document)) },
    { path: 'docProps/app.xml', data: ENCODER.encode(appXml()) },
    ...context.media.map((media) => ({ path: media.path, data: media.bytes })),
  ];

  const bytes = createZip(entries);
  await validateDocx(bytes);

  if (document.facts.formulas > 0) {
    warnings.push(
      `${document.facts.formulas} 个公式以 LaTeX 源导出（当前没有可用的公式预览图）。`,
    );
  }
  if (document.facts.internalLinks > 0) {
    warnings.push(
      `${document.facts.internalLinks} 个站内内链以“《标题》”文本导出，应用外不可跳转。`,
    );
  }

  return {
    bytes,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    warnings: dedupe(warnings),
  };
}
