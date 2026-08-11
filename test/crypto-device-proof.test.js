import { describe, test, expect } from 'vitest';
import { computeDeviceProof, canonicalRequestBodySha256 } from '../src/crypto.js';

// 文档 §3.4 固定测试向量
const SECRET_B64URL = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PRODUCT_ID = 'k1';
const DEVICE_SN = 'K1-2026-000001';
const CV = 1;
const TS = 1785210000;
const NONCE = 'AAECAwQFBgcICQoLDA0ODw';
const EXPECTED_PROOF = '31aCPbgG42Z5ObCVMuauwqNxZtrpSDU6GwJ0wvu5jes';

describe('computeDeviceProof — A0 固定测试向量', () => {
  test('用文档固定向量计算 device_proof 应得到预期值', async () => {
    const { proof, canonicalBody } = await computeDeviceProof({
      secretB64url: SECRET_B64URL,
      productId: PRODUCT_ID,
      deviceSn: DEVICE_SN,
      credentialVersion: CV,
      timestamp: TS,
      nonce: NONCE,
      appVersion: '1.2.1',
      firmwareVersion: '1.0.0',
      capabilityDigest: 'sha256:' + '0'.repeat(64),
    });

    expect(proof).toBe(EXPECTED_PROOF);
    expect(canonicalBody).toBeDefined();
  });

  test('proof 输出固定 43 字符', async () => {
    const { proof } = await computeDeviceProof({
      secretB64url: SECRET_B64URL,
      productId: PRODUCT_ID,
      deviceSn: DEVICE_SN,
      credentialVersion: CV,
      timestamp: TS,
      nonce: NONCE,
    });
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('canonicalRequestBodySha256 — JCS 规范化', () => {
  test('请求体按 key 排序紧凑编码后取 SHA-256 十六进制', async () => {
    const body = {
      credential_version: 1,
      device_sn: 'K1-2026-000001',
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
      product_id: 'k1',
      runtime: {
        app_version: '1.2.1',
        capability_digest: 'sha256:' + '0'.repeat(64),
        firmware_version: '1.0.0',
      },
      timestamp: 1785210000,
    };
    const { canonical, sha256Hex } = await canonicalRequestBodySha256(body);
    // JCS: 按 key 排序，紧凑分隔
    expect(canonical).toBe('{"credential_version":1,"device_sn":"K1-2026-000001","nonce":"AAECAwQFBgcICQoLDA0ODw","product_id":"k1","runtime":{"app_version":"1.2.1","capability_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","firmware_version":"1.0.0"},"timestamp":1785210000}');
    expect(sha256Hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
