import { describe, test, expect } from 'vitest';
import { computePairingProof } from '../src/crypto.js';

const SECRET_B64URL = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const DEVICE_SN = 'K1-2026-000001';

describe('computePairingProof — 配对 proof 计算', () => {
  test('输出固定 43 字符 base64url', async () => {
    const { proof } = await computePairingProof({
      secretB64url: SECRET_B64URL,
      deviceSn: DEVICE_SN,
      timestamp: 1785210000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
    });
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('相同输入产生相同输出（确定性）', async () => {
    const opts = {
      secretB64url: SECRET_B64URL,
      deviceSn: DEVICE_SN,
      timestamp: 1785210000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
    };
    const r1 = await computePairingProof(opts);
    const r2 = await computePairingProof(opts);
    expect(r1.proof).toBe(r2.proof);
  });

  test('canonical request 为 6 行 LF 分隔', async () => {
    const { canonicalRequest } = await computePairingProof({
      secretB64url: SECRET_B64URL,
      deviceSn: DEVICE_SN,
      timestamp: 1785210000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
    });
    const lines = canonicalRequest.split('\n');
    expect(lines.length).toBe(6);
    expect(lines[0]).toBe('K1_PAIRING_V1');
    expect(lines[1]).toBe('POST');
    expect(lines[2]).toBe('/v1/device-bindings');
    expect(lines[3]).toBe(`device_sn=${DEVICE_SN}`);
    expect(lines[4]).toBe('timestamp=1785210000');
    expect(lines[5]).toBe('nonce=AAECAwQFBgcICQoLDA0ODw');
  });
});
