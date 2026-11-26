/** 无依赖 Base64（Basic 认证）。Tauri WebView / Node 测试环境都可运行。 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const triple = (first << 16) | (second << 8) | third;
    output += ALPHABET[(triple >> 18) & 0x3f];
    output += ALPHABET[(triple >> 12) & 0x3f];
    output += index + 1 < bytes.length ? ALPHABET[(triple >> 6) & 0x3f] : '=';
    output += index + 2 < bytes.length ? ALPHABET[triple & 0x3f] : '=';
  }
  return output;
}

export function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${encodeBase64(bytes)}`;
}
