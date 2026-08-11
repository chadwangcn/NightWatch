import { describe, test, expect } from 'vitest';
import { TestRunner } from '../src/runner.js';
import { computeDeviceProof, computePairingProof, genNonce } from '../src/crypto.js';

function makeMockClient() {
  return {
    baseUrl: 'https://api.example.com',
    setUserToken: () => {}, setDeviceToken: () => {},
    clearUserToken: () => {}, clearDeviceToken: () => {},
    login: async () => ({}), refreshSession: async () => ({}), logout: async () => null,
    deviceSession: async () => ({}), deviceBootstrap: async () => ({}),
    pairingChallenge: async () => ({}), bindDevice: async () => ({}),
    getBinding: async () => ({}), unbind: async () => null,
    health: async () => ({}), ready: async () => ({}),
  };
}

// 文档 §1 固定测试向量（非真实设备）
const TEST_VECTOR_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const TEST_VECTOR_SN = 'K1-2026-000001';
const EXPECTED_PROOF = '31aCPbgG42Z5ObCVMuauwqNxZtrpSDU6GwJ0wvu5jes';

describe('A0 固定测试向量（不依赖用户配置）', () => {
  test('即使用户配置的 secret 不同，A0 仍使用文档固定向量验证', async () => {
    const client = makeMockClient();
    // 用户配置了一个不同的 secret
    const runner = new TestRunner({
      client,
      config: {
        baseUrl: 'https://api.example.com',
        account: 'x', password: 'x',
        deviceSn: 'USER-DEVICE-SN',
        deviceSecretB64url: 'd'.repeat(43), // 用户自己的 secret
        childProfileId: 'c', productId: 'k1', credentialVersion: 1,
      },
      crypto: { computeDeviceProof, computePairingProof, genNonce },
    });
    const result = await runner.run('A0');
    expect(result.passed).toBe(true);
    // A0 用的是固定向量，不是用户配置
    expect(result.steps[0].request.vector).toBe('fixed');
    expect(result.steps[0].response.body.proof).toBe(EXPECTED_PROOF);
  });
});
