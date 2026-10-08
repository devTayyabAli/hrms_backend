import * as crypto from 'crypto';
import { WebPushUtil, WEB_PUSH_MAX_PAYLOAD } from './web-push.util';

/** A browser's side of a subscription: its ECDH key pair and auth secret. */
const makeBrowser = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
  };
};

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 8291 decryption as the user agent performs it — written independently of the encrypter. */
const browserDecrypt = (browser: ReturnType<typeof makeBrowser>, body: Buffer): string => {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  expect(rs).toBe(4096);

  const shared = browser.ecdh.computeSecret(asPublic);
  const prkKey = hmac(browser.auth, shared);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, info);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // Strip padding: everything after the last delimiter 0x02.
  const end = plain.lastIndexOf(2);
  expect(end).toBeGreaterThanOrEqual(0);
  return plain.subarray(0, end).toString('utf8');
};

describe('WebPushUtil', () => {
  it('encrypts a payload the receiving browser can decrypt', () => {
    const browser = makeBrowser();
    const message = JSON.stringify({ title: 'New sign-in', body: 'Chrome on Windows · 18.143.151.88' });
    const body = WebPushUtil.encrypt(browser.subscription, Buffer.from(message));
    expect(browserDecrypt(browser, body)).toBe(message);
  });

  it('uses a fresh sender key and salt for every message', () => {
    const browser = makeBrowser();
    const a = WebPushUtil.encrypt(browser.subscription, Buffer.from('same'));
    const b = WebPushUtil.encrypt(browser.subscription, Buffer.from('same'));
    expect(a.equals(b)).toBe(false);
  });

  it('refuses payloads that do not fit in one record', () => {
    const browser = makeBrowser();
    expect(() => WebPushUtil.encrypt(browser.subscription, Buffer.alloc(WEB_PUSH_MAX_PAYLOAD + 1))).toThrow(/limit/);
    expect(() => WebPushUtil.encrypt(browser.subscription, Buffer.alloc(WEB_PUSH_MAX_PAYLOAD))).not.toThrow();
  });

  it('signs a VAPID token the push service can verify with the public key', () => {
    const keys = WebPushUtil.generateVapidKeys();
    const config = { ...keys, subject: 'mailto:ops@example.com' };
    WebPushUtil.assertVapidKeys(config);

    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const header = WebPushUtil.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', config, now);
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);

    const [h, c, s] = token.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:ops@example.com' });

    const pub = Buffer.from(keys.publicKey, 'base64url');
    const verifyKey = crypto.createPublicKey({
      format: 'jwk',
      key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    });
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(valid).toBe(true);
  });

  it('rejects a mismatched VAPID key pair', () => {
    const a = WebPushUtil.generateVapidKeys();
    const b = WebPushUtil.generateVapidKeys();
    expect(() => WebPushUtil.assertVapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey, subject: 'mailto:x@y.z' })).toThrow(
      /does not belong/,
    );
  });
});

describe('WebPushUtil private key length', () => {
  it('accepts a private key whose leading zero byte was dropped', () => {
    // Find a key whose scalar starts with 0x00, as ECDH.getPrivateKey() returns it (31 bytes).
    const crypto = require('crypto');
    let ecdh;
    do {
      ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
    } while (ecdh.getPrivateKey().length === 32);
    const config = {
      publicKey: ecdh.getPublicKey().toString('base64url'),
      privateKey: ecdh.getPrivateKey().toString('base64url'),
      subject: 'mailto:ops@example.com',
    };
    expect(() => WebPushUtil.assertVapidKeys(config)).not.toThrow();
    expect(WebPushUtil.vapidAuthorization('https://push.example/x', config)).toMatch(/^vapid t=/);
  });

  it('always generates a 43-character private key', () => {
    for (let i = 0; i < 50; i += 1) expect(WebPushUtil.generateVapidKeys().privateKey).toHaveLength(43);
  });
});
