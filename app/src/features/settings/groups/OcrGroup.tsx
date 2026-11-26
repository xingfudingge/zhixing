/**
 * 知识库与 OCR 设置分组。
 *
 * 直接挂载 OCR 功能面板：默认关闭；未安装/未配置引擎时显示真实不可用
 * 原因，测试识别只返回引擎原始结果。设置写入 OCR 设备偏好，重新加载后
 * 仍保持；不使用设置页的通用 SQLite 键，避免与附件运行时读写不一致。
 */

import { useMemo } from 'react';

import { OcrPanel } from '../../ocr/OcrPanel';
import {
  createAttachmentQueueResolver,
  createDefaultOcrService,
  listAttachmentOcrCandidates,
} from '../../ocr/runtime';
import type { OcrImageResolver, OcrService } from '../../ocr/service';
import type { OcrImageCandidate } from '../../ocr/types';
import { SettingsCard } from './Controls';

export type OcrGroupProps = {
  /** 测试注入；不传时使用本机偏好 + IndexedDB 作业存储。 */
  service?: OcrService;
  /** 测试注入；不传时按需读取桌面壳 SQLite/IndexedDB 中的真实附件。 */
  resolveImage?: OcrImageResolver;
  listImages?: () => Promise<OcrImageCandidate[]>;
};

export function OcrGroup({ service, resolveImage, listImages }: OcrGroupProps = {}) {
  const fallback = useMemo(() => createDefaultOcrService(), []);
  const active = service ?? fallback;
  const queueResolver = useMemo(() => createAttachmentQueueResolver(), []);

  return (
    <SettingsCard
      title="知识库与 OCR"
      description="图片 OCR 默认关闭；只使用真实可用的引擎，未配置时明确显示不可用，不暗中上传图片，也不生成模拟识别结果。"
    >
      <OcrPanel
        service={active}
        resolveImage={resolveImage ?? queueResolver}
        listImages={listImages ?? listAttachmentOcrCandidates}
      />
    </SettingsCard>
  );
}
