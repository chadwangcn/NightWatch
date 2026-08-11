import { describe, test, expect } from 'vitest';
import { b64url, b64urlDecode, genNonce } from '../src/crypto.js';

describe('b64url 编码', () => {
  test('将字节数组编码为 base64url 无 padding 字符串', () => {
    // RFC 4648 base64url 测试向量
    expect(b64url(new Uint8Array([0, 1, 2, 3]))).toBe('AAECAw');
    expect(b64url(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]))).toBe('AAECAwQFBgcICQoLDA0ODw');
  });

  test('32 字节固定向量编码为 43 字符', () => {
    // 文档 §1: 32字节 → base64url 无 padding 固定 43 字符
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    const encoded = b64url(bytes);
    expect(encoded).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
    expect(encoded.length).toBe(43);
  });
});

describe('b64urlDecode 解码', () => {
  test('解码文档固定测试向量 secret', () => {
    const secret = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const bytes = b64urlDecode(secret);
    expect(bytes.length).toBe(32);
    for (let i = 0; i < 32; i++) {
      expect(bytes[i]).toBe(i);
    }
  });

  test('解码后重新编码应得到原字符串', () => {
    const original = 'AAECAwQFBgcICQoLDA0ODw';
    const decoded = b64urlDecode(original);
    expect(b64url(decoded)).toBe(original);
  });
});

describe('genNonce 生成随机 nonce', () => {
  test('生成 22 字符的 base64url 字符串（16 字节）', () => {
    const nonce = genNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test('文档固定测试向量 nonce 符合正则', () => {
    // 文档 §3.4 固定向量: nonce=AAECAwQFBgcICQoLDA0ODw
    expect('AAECAwQFBgcICQoLDA0ODw').toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
