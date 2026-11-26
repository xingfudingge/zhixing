/**
 * 笔记内容加密的前端入口。
 *
 * 密钥只存在于 Rust 进程内存：这里从不接收、保存或日志主密钥/口令派生值。
 * 浏览器预览没有 SQLite/钥匙串，明确返回“不支持”，不伪造加密成功。
 */

import { db, isTauriRuntime } from '../../data/db/client';
import type {
  NoteEncryptionReport,
  NoteEncryptionStatus,
} from '../../data/db/types';

export type {
  NoteEncryptionReport,
  NoteEncryptionStatus,
  NoteEncryptionStorage,
} from '../../data/db/types';

export const NOTE_ENCRYPTION_CHANGED_EVENT = 'zhixing:note-encryption-changed';

export class NoteEncryptionUnavailableError extends Error {
  constructor() {
    super('笔记加密只在桌面壳内可用：浏览器预览没有 SQLite 与系统钥匙串');
    this.name = 'NoteEncryptionUnavailableError';
  }
}

export function noteEncryptionSupported(): boolean {
  return isTauriRuntime();
}

function unsupportedStatus(): NoteEncryptionStatus {
  return {
    supported: false,
    configured: false,
    enabled: false,
    locked: false,
    keyMissing: false,
    storage: 'none',
    algorithm: '',
    keyId: null,
    encryptedNotes: 0,
    totalNotes: 0,
    plaintextNotes: 0,
    noteAttachments: 0,
    pendingEncryption: false,
    error: null,
  };
}

function announce(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(NOTE_ENCRYPTION_CHANGED_EVENT));
  }
}

export async function getNoteEncryptionStatus(): Promise<NoteEncryptionStatus> {
  if (!noteEncryptionSupported()) {
    return unsupportedStatus();
  }
  return db.noteEncryption.status();
}

export async function enableNoteEncryption(
  passphrase: string,
): Promise<NoteEncryptionReport> {
  if (!noteEncryptionSupported()) {
    throw new NoteEncryptionUnavailableError();
  }
  const report = await db.noteEncryption.enable(passphrase);
  announce();
  return report;
}

export async function unlockNoteEncryption(
  passphrase: string,
): Promise<NoteEncryptionStatus> {
  if (!noteEncryptionSupported()) {
    throw new NoteEncryptionUnavailableError();
  }
  const status = await db.noteEncryption.unlock(passphrase);
  announce();
  return status;
}

export async function lockNoteEncryption(): Promise<NoteEncryptionStatus> {
  if (!noteEncryptionSupported()) {
    throw new NoteEncryptionUnavailableError();
  }
  const status = await db.noteEncryption.lock();
  announce();
  return status;
}

export async function disableNoteEncryption(
  passphrase?: string,
): Promise<NoteEncryptionReport> {
  if (!noteEncryptionSupported()) {
    throw new NoteEncryptionUnavailableError();
  }
  const report = await db.noteEncryption.disable(passphrase);
  announce();
  return report;
}

export async function changeNoteEncryptionPassphrase(
  currentPassphrase: string,
  nextPassphrase: string,
): Promise<NoteEncryptionStatus> {
  if (!noteEncryptionSupported()) {
    throw new NoteEncryptionUnavailableError();
  }
  const status = await db.noteEncryption.changePassphrase(
    currentPassphrase,
    nextPassphrase,
  );
  announce();
  return status;
}

/** 导出“口令包裹的主密钥”信封：没有口令无法解出主密钥，不是明文密钥。 */
export async function exportNoteEncryptionEnvelope(): Promise<string | null> {
  if (!noteEncryptionSupported()) {
    throw new NoteEncryptionUnavailableError();
  }
  return db.noteEncryption.exportEnvelope();
}

export async function importNoteEncryptionEnvelope(
  envelopeJson: string,
): Promise<NoteEncryptionStatus> {
  if (!noteEncryptionSupported()) {
    throw new NoteEncryptionUnavailableError();
  }
  const status = await db.noteEncryption.importEnvelope(envelopeJson);
  announce();
  return status;
}

export function formatNoteEncryptionError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '笔记加密操作失败，请重试';
}
