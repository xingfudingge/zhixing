/**
 * 服务端附件分片模块。
 *
 * 与现有 `server/src/services/attachment-service.ts` 的关系：
 * - 现有服务负责 `attachments` 元数据与整文件预签名（P2-01）；
 * - 本模块在其上增加 4MB 分片会话、续传、complete.json 清单、逐片回读
 *   哈希校验与下载清单，供 P2-03 的客户端使用。
 *
 * 挂载方式（由部署入口在 `/api/v1` 前缀下注册）：
 *   app.register(async (api) => registerAttachmentChunkRoutes(api))
 */

export {
  AttachmentChunkService,
  type ChunkPart,
  type CompleteUploadInput,
  type DownloadManifestResult,
  type UploadSessionResult,
} from './chunked-upload-service.ts';
export { registerAttachmentChunkRoutes } from './routes.ts';
export {
  COMPLETE_CONTENT_TYPE,
  DEFAULT_CHUNK_SIZE,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_SIZE,
  MAX_PARTS,
  MIN_CHUNK_SIZE,
  PART_CONTENT_TYPE,
  completeStorageKey,
  normalizeChunkSize,
  partCountFor,
  partSizeFor,
  partStorageKey,
  partsPrefix,
} from './chunk-plan.ts';
