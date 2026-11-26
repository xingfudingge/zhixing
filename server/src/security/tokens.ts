import { createHash, randomBytes, randomInt } from 'node:crypto';

import { uuidv7 } from '../../../packages/shared/src/index.ts';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

export function makeId(prefix: string): string {
  return `${prefix}_${uuidv7()}`;
}

// 去除 0/O/1/I/L 等易混淆字符，配对码人工输入更可靠。
const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function generatePairingCode(): string {
  let raw = '';
  for (let index = 0; index < 8; index += 1) {
    raw += PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)];
  }
  return `ZX-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function pairingCodeHash(code: string): string {
  return sha256Hex(normalizePairingCode(code));
}

export function newPairingCodeId(): string {
  return makeId('pair');
}

export function newDeviceId(): string {
  return makeId('dev');
}

export function newSessionId(): string {
  return makeId('as');
}

export function newAttachmentId(): string {
  return makeId('att');
}

export function newConflictId(): string {
  return makeId('cf');
}
