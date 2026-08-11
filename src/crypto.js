// Lumi Device Platform — 加密辅助函数（跨平台：Node + 浏览器）
// 参照 docs/testing/public-api-eval-plan.md §6

/**
 * Base64url 无 padding 编码
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function b64url(bytes) {
  // 使用 Buffer（Node）或手动 btoa（浏览器）
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  }
  const b64 = btoa(chunks.join(''));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64url 解码（兼容有/无 padding）
 * @param {string} s
 * @returns {Uint8Array}
 */
export function b64urlDecode(s) {
  if (typeof Buffer !== 'undefined') {
    const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
    const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  let s2 = s.replace(/-/g, '+').replace(/_/g, '/');
  s2 += '='.repeat((4 - (s2.length % 4)) % 4);
  const binary = atob(s2);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 生成 16 字节 CSPRNG nonce，base64url 编码为 22 字符
 * @returns {string}
 */
export function genNonce() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * 对象按 key 深度排序（JCS 规范化的关键步骤）
 * @param {any} value
 * @returns {any}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const out = {};
    for (const k of sortedKeys) {
      out[k] = sortKeysDeep(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * JCS 规范化 JSON：按 key 排序 + 紧凑分隔
 * @param {object} body
 * @returns {string}
 */
function toJcsJson(body) {
  return JSON.stringify(sortKeysDeep(body));
}

/**
 * 异步 SHA-256 十六进制（Web Crypto API，跨平台）
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256HexAsync(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 计算请求体（不含 device_proof/pairing_proof）的 JCS 规范化 SHA-256 十六进制
 * 异步（浏览器环境必须异步）
 * @param {object} body
 * @param {string[]} excludeFields
 * @returns {Promise<{canonical: string, sha256Hex: string}>}
 */
export async function canonicalRequestBodySha256(body, excludeFields = []) {
  const filtered = { ...body };
  for (const f of excludeFields) delete filtered[f];
  const canonical = toJcsJson(filtered);
  const sha256Hex = await sha256HexAsync(canonical);
  return { canonical, sha256Hex };
}

/**
 * 异步 HMAC-SHA256，返回 base64url 无 padding
 * @param {Uint8Array} key
 * @param {string} msg
 * @returns {Promise<string>}
 */
async function hmacSha256B64url(key, msg) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}

/**
 * 计算设备认证 proof（文档 §3.4）
 *
 * Canonical request (9 行, LF 分隔, 末尾无 LF):
 *   K1_DEVICE_AUTH_V1
 *   POST
 *   /v1/device-sessions
 *   product_id=<product_id>
 *   device_sn=<device_sn>
 *   credential_version=<cv>
 *   timestamp=<unix_seconds>
 *   nonce=<b64url_nonce>
 *   body_sha256=<hex_sha256_of_body_without_device_proof>
 *
 * @param {object} opts
 * @returns {Promise<{proof: string, canonicalBody: string, bodySha256: string, canonicalRequest: string}>}
 */
export async function computeDeviceProof({
  secretB64url,
  productId,
  deviceSn,
  credentialVersion,
  timestamp,
  nonce,
  appVersion = '1.0.0',
  firmwareVersion = '0.2.0-dev.24',
  capabilityDigest,
}) {
  // capability_digest: 设备能力声明的 SHA-256
  // 调用方未提供时用全 0 占位（仅用于本地测试向量验证，真实设备应传入实际值）
  const capDigest = capabilityDigest || 'sha256:' + '0'.repeat(64);
  const body = {
    credential_version: credentialVersion,
    device_sn: deviceSn,
    nonce,
    product_id: productId,
    runtime: {
      app_version: appVersion,
      capability_digest: capDigest,
      firmware_version: firmwareVersion,
    },
    timestamp,
  };

  const { canonical: canonicalBody, sha256Hex: bodySha256 } = await canonicalRequestBodySha256(body);

  const canonicalRequest = [
    'K1_DEVICE_AUTH_V1',
    'POST',
    '/v1/device-sessions',
    `product_id=${productId}`,
    `device_sn=${deviceSn}`,
    `credential_version=${credentialVersion}`,
    `timestamp=${timestamp}`,
    `nonce=${nonce}`,
    `body_sha256=${bodySha256}`,
  ].join('\n');

  const secret = b64urlDecode(secretB64url);
  const proof = await hmacSha256B64url(secret, canonicalRequest);

  return { proof, canonicalBody, bodySha256, canonicalRequest };
}

/**
 * 计算配对 proof（文档 §3.7）
 *
 * Canonical request (6 行, LF 分隔, 末尾无 LF):
 *   K1_PAIRING_V1
 *   POST
 *   /v1/device-bindings
 *   device_sn=<device_sn>
 *   timestamp=<server_timestamp>
 *   nonce=<server_nonce>
 *
 * @param {object} opts
 * @returns {Promise<{proof: string, canonicalRequest: string}>}
 */
export async function computePairingProof({ secretB64url, deviceSn, timestamp, nonce }) {
  const canonicalRequest = [
    'K1_PAIRING_V1',
    'POST',
    '/v1/device-bindings',
    `device_sn=${deviceSn}`,
    `timestamp=${timestamp}`,
    `nonce=${nonce}`,
  ].join('\n');

  const secret = b64urlDecode(secretB64url);
  const proof = await hmacSha256B64url(secret, canonicalRequest);
  return { proof, canonicalRequest };
}
