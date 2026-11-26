/**
 * 提醒计划与发送记录的本地存储。
 *
 * 只保存标题/时间/状态与去重键；不保存任务正文。记录上限 500 条，
 * 防止长期使用后无限增长。
 */

import type {
  DeliveryRecord,
  NotificationChannel,
  ReminderPlan,
  ReminderPlanStatus,
} from './types';

export const NOTIFICATION_STORE_KEY = 'zhixing.notification-plans.v1';
const MAX_RECORDS = 500;

export interface NotificationPlanStore {
  listPlans(): Promise<ReminderPlan[]>;
  savePlans(plans: ReminderPlan[]): Promise<void>;
  listDeliveries(): Promise<DeliveryRecord[]>;
  addDelivery(record: DeliveryRecord): Promise<void>;
  clearDeliveries(): Promise<void>;
  clear(): Promise<void>;
}

type StoredDocument = {
  version: 1;
  plans: ReminderPlan[];
  deliveries: DeliveryRecord[];
};

export type NotificationStorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function emptyDocument(): StoredDocument {
  return { version: 1, plans: [], deliveries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const CHANNELS = new Set<NotificationChannel>(['in-app', 'browser', 'system']);
const STATUSES = new Set<ReminderPlanStatus>([
  'scheduled',
  'sent',
  'suppressed',
  'blocked',
  'unsupported',
  'failed',
  'canceled',
]);

function parsePlan(value: unknown): ReminderPlan | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.ownerId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.triggerAt !== 'string' ||
    typeof value.dedupeKey !== 'string' ||
    !CHANNELS.has(value.channel as NotificationChannel) ||
    !STATUSES.has(value.status as ReminderPlanStatus)
  ) {
    return null;
  }
  return {
    id: value.id,
    ownerType: value.ownerType === 'digest' ? 'digest' : 'task',
    ownerId: value.ownerId,
    channel: value.channel as NotificationChannel,
    title: value.title,
    body: value.body,
    triggerAt: value.triggerAt,
    timezone: typeof value.timezone === 'string' ? value.timezone : 'Asia/Shanghai',
    dedupeKey: value.dedupeKey,
    status: value.status as ReminderPlanStatus,
    explanation:
      typeof value.explanation === 'string' ? value.explanation : null,
    createdAt:
      typeof value.createdAt === 'string'
        ? value.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof value.updatedAt === 'string'
        ? value.updatedAt
        : new Date().toISOString(),
  };
}

function parseDelivery(value: unknown): DeliveryRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.dedupeKey !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.at !== 'string' ||
    !CHANNELS.has(value.channel as NotificationChannel) ||
    !STATUSES.has(value.status as ReminderPlanStatus)
  ) {
    return null;
  }
  return {
    id: value.id,
    planId: typeof value.planId === 'string' ? value.planId : '',
    dedupeKey: value.dedupeKey,
    channel: value.channel as NotificationChannel,
    title: value.title,
    body: typeof value.body === 'string' ? value.body : '',
    status: value.status as ReminderPlanStatus,
    at: value.at,
    explanation:
      typeof value.explanation === 'string' ? value.explanation : null,
  };
}

export class LocalStorageNotificationPlanStore implements NotificationPlanStore {
  private readonly storage: NotificationStorageLike | null;
  private readonly key: string;
  private memory: StoredDocument = emptyDocument();

  constructor(
    storage: NotificationStorageLike | null =
      typeof localStorage !== 'undefined' ? localStorage : null,
    key = NOTIFICATION_STORE_KEY,
  ) {
    this.storage = storage;
    this.key = key;
  }

  private read(): StoredDocument {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(this.key) ?? null;
    } catch {
      raw = null;
    }
    if (!raw) return this.memory;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return emptyDocument();
      return {
        version: 1,
        plans: Array.isArray(parsed.plans)
          ? parsed.plans.map(parsePlan).filter((plan): plan is ReminderPlan => plan !== null)
          : [],
        deliveries: Array.isArray(parsed.deliveries)
          ? parsed.deliveries
              .map(parseDelivery)
              .filter((record): record is DeliveryRecord => record !== null)
          : [],
      };
    } catch {
      return emptyDocument();
    }
  }

  private write(document: StoredDocument): void {
    this.memory = document;
    try {
      this.storage?.setItem(this.key, JSON.stringify(document));
    } catch {
      // 内存副本仍可用。
    }
  }

  async listPlans(): Promise<ReminderPlan[]> {
    return this.read().plans.map((plan) => ({ ...plan }));
  }

  async savePlans(plans: ReminderPlan[]): Promise<void> {
    const document = this.read();
    this.write({
      ...document,
      plans: plans.slice(-MAX_RECORDS).map((plan) => ({ ...plan })),
    });
  }

  async listDeliveries(): Promise<DeliveryRecord[]> {
    return this.read().deliveries.map((record) => ({ ...record }));
  }

  async addDelivery(record: DeliveryRecord): Promise<void> {
    const document = this.read();
    const dedupe = document.deliveries.filter(
      (item) => item.dedupeKey !== record.dedupeKey,
    );
    this.write({
      ...document,
      deliveries: [...dedupe, { ...record }].slice(-MAX_RECORDS),
    });
  }

  async clearDeliveries(): Promise<void> {
    const document = this.read();
    this.write({ ...document, deliveries: [] });
  }

  async clear(): Promise<void> {
    this.write(emptyDocument());
  }
}

export class MemoryNotificationPlanStore implements NotificationPlanStore {
  private plans: ReminderPlan[] = [];
  private deliveries: DeliveryRecord[] = [];

  async listPlans(): Promise<ReminderPlan[]> {
    return this.plans.map((plan) => ({ ...plan }));
  }

  async savePlans(plans: ReminderPlan[]): Promise<void> {
    this.plans = plans.map((plan) => ({ ...plan }));
  }

  async listDeliveries(): Promise<DeliveryRecord[]> {
    return this.deliveries.map((record) => ({ ...record }));
  }

  async addDelivery(record: DeliveryRecord): Promise<void> {
    this.deliveries = [
      ...this.deliveries.filter((item) => item.dedupeKey !== record.dedupeKey),
      { ...record },
    ].slice(-MAX_RECORDS);
  }

  async clearDeliveries(): Promise<void> {
    this.deliveries = [];
  }

  async clear(): Promise<void> {
    this.plans = [];
    this.deliveries = [];
  }
}
