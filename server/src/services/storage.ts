import { createHash } from 'node:crypto';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { StorageConfig } from '../config.ts';
import { errors } from '../errors.ts';

export type StoredObject = {
  size: number;
  contentType: string | null;
  sha256?: string;
};

/**
 * MinIO/S3 适配器。只保存内容寻址对象的元数据，二进制不进 PostgreSQL。
 */
export class StorageService {
  readonly config: StorageConfig;
  private readonly client: S3Client | null;
  private readonly signingClient: S3Client | null;
  private lastError: string | null = null;

  constructor(config: StorageConfig) {
    this.config = config;
    this.client = config.enabled
      ? new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          forcePathStyle: config.forcePathStyle,
          credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: config.secretKey,
          },
        })
      : null;
    // Docker 内部访问 minio:9000，宿主机/客户端必须用 localhost:9000。
    this.signingClient = config.enabled
      ? new S3Client({
          endpoint: config.publicEndpoint,
          region: config.region,
          forcePathStyle: config.forcePathStyle,
          credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: config.secretKey,
          },
        })
      : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  status() {
    return {
      configured: this.configured,
      bucket: this.config.bucket,
      driver: 'minio' as const,
      lastError: this.lastError,
    };
  }

  private requireClient(): S3Client {
    if (!this.client) {
      throw errors.serviceUnavailable('未配置对象存储', 'STORAGE_NOT_CONFIGURED');
    }
    return this.client;
  }

  async ensureBucket(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      this.lastError = null;
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
        this.lastError = null;
      } catch (error) {
        this.lastError = (error as Error).message;
        throw error;
      }
    }
  }

  async health(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
        { abortSignal: AbortSignal.timeout(2500) },
      );
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message;
      throw error;
    }
  }

  private requireSigningClient(): S3Client {
    if (!this.signingClient) {
      throw errors.serviceUnavailable('未配置对象存储', 'STORAGE_NOT_CONFIGURED');
    }
    return this.signingClient;
  }

  async putUrl(key: string, mime: string, expiresIn = 900): Promise<string> {
    const client = this.requireSigningClient();
    return getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: mime,
      }),
      { expiresIn },
    );
  }

  async getUrl(key: string, expiresIn = 900): Promise<string> {
    const client = this.requireSigningClient();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn },
    );
  }

  async stat(key: string): Promise<StoredObject> {
    const client = this.requireClient();
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        size: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
      };
    } catch (error) {
      this.lastError = (error as Error).message;
      throw errors.unprocessable('对象尚未上传完成', 'ATTACHMENT_OBJECT_MISSING');
    }
  }

  /** 读回对象并计算 SHA-256，确认内容与元数据一致后才标记 available。 */
  async verifyHash(key: string, expectedSha256: string): Promise<void> {
    const client = this.requireClient();
    try {
      const object = await client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!object.Body) throw new Error('empty object body');
      const hash = createHash('sha256');
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
      }
      const actual = hash.digest('hex');
      if (actual !== expectedSha256) {
        await this.delete(key).catch(() => undefined);
        throw errors.unprocessable('附件 SHA-256 校验失败', 'ATTACHMENT_HASH_MISMATCH', {
          expected: expectedSha256,
          actual,
        });
      }
      this.lastError = null;
    } catch (error) {
      if (error instanceof Error && error.name === 'ApiError') throw error;
      this.lastError = (error as Error).message;
      throw errors.serviceUnavailable('对象存储读取失败', 'STORAGE_UNAVAILABLE');
    }
  }

  async delete(key: string): Promise<void> {
    const client = this.requireClient();
    await client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }
}
