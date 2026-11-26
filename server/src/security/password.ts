import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

export type PasswordHash = {
  hash: string;
  salt: string;
  scheme: string;
};

/** scrypt 口令哈希；服务端只保存哈希与盐，不保存明文。 */
export async function hashPassword(passphrase: string): Promise<PasswordHash> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(passphrase.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return {
    hash: derived.toString('hex'),
    salt,
    scheme: `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${KEY_LENGTH}`,
  };
}

export async function verifyPassword(
  passphrase: string,
  stored: { hash: string | null; salt: string | null; scheme?: string | null },
): Promise<boolean> {
  if (!stored.hash || !stored.salt) return false;
  const derived = await scrypt(
    passphrase.normalize('NFKC'),
    stored.salt,
    KEY_LENGTH,
    PARAMS,
  );
  const expected = Buffer.from(stored.hash, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

export function validatePassphrase(passphrase: unknown): string {
  if (typeof passphrase !== 'string') {
    throw new Error('管理口令必须是字符串');
  }
  const value = passphrase.normalize('NFKC');
  if (value.length < 8) throw new Error('管理口令至少 8 个字符');
  if (value.length > 200) throw new Error('管理口令最多 200 个字符');
  if (/^\s+$/.test(value)) throw new Error('管理口令不能全为空白');
  return value;
}
