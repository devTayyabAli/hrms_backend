import * as crypto from 'crypto';

/**
 * Web Push, implemented on Node's own crypto: message encryption per RFC 8291
 * (`aes128gcm`, RFC 8188) and VAPID sender identification per RFC 8292.
 *
 * Kept dependency-free on purpose — the `web-push` package would pull five
 * transitive dependencies into an install that already mixes npm and pnpm.
 *
 * Keys are base64url, as browsers and the `web-push` CLI produce them:
 * - VAPID public key: the 65-byte uncompressed P-256 point (`04 || x || y`)
 * - VAPID private key: the 32-byte private scalar `d`
 * Generate a pair with `WebPushUtil.generateVapidKeys()`.
 */

/** What the browser hands over from `PushManager.subscribe()`, as JSON. */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` contact for the push service operator. */
  subject: string;
}

export interface WebPushOptions {
  /** Seconds the push service may hold the message for an offline device. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Replaces an undelivered message with the same topic (max 32 url-safe chars). */
  topic?: string;
}

export interface WebPushResult {
  ok: boolean;
  statusCode: number;
  /** 404/410: the subscription is gone for good and should be deleted. */
  expired: boolean;
  body?: string;
}

const b64url = {
  encode: (buf: Buffer) => buf.toString('base64url'),
  decode: (value: string) => Buffer.from(value, 'base64url'),
};

/**
 * The private scalar as exactly 32 bytes. Node's `ECDH.getPrivateKey()` drops
 * leading zero bytes (about 1 key in 256), and JWK requires the full length.
 */
const privateScalar = (privateKey: string): Buffer => {
  const raw = b64url.decode(privateKey);
  return raw.length >= 32 ? raw : Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
};

/** One HKDF-Expand block (RFC 5869), all this scheme ever needs. */
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer => {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
};

/** Record size advertised in the aes128gcm header; one record carries the whole message. */
const RECORD_SIZE = 4096;
/** Room for the delimiter byte and the 16-byte GCM tag inside one record. */
export const WEB_PUSH_MAX_PAYLOAD = RECORD_SIZE - 17;

export class WebPushUtil {
  static generateVapidKeys(): { publicKey: string; privateKey: string } {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      publicKey: b64url.encode(ecdh.getPublicKey()),
      privateKey: b64url.encode(privateScalar(b64url.encode(ecdh.getPrivateKey()))),
    };
  }

  /** Throws with a readable reason when the configured VAPID keys can't be used. */
  static assertVapidKeys(config: VapidConfig): void {
    const pub = b64url.decode(config.publicKey);
    const priv = privateScalar(config.privateKey);
    if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY must be a base64url 65-byte uncompressed P-256 key.');
    if (priv.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be a base64url 32-byte P-256 private key.');
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY.');
    if (!/^(mailto:|https:)/.test(config.subject)) throw new Error('VAPID_SUBJECT must start with mailto: or https:.');
  }

  /**
   * Encrypts `payload` for one subscription (RFC 8291 §3.4). Returns the
   * request body: the aes128gcm header (salt, record size, sender key) and
   * the single encrypted record.
   */
  static encrypt(subscription: WebPushSubscription, payload: Buffer, salt = crypto.randomBytes(16)): Buffer {
    if (payload.length > WEB_PUSH_MAX_PAYLOAD) {
      throw new Error(`Web Push payload is ${payload.length} bytes; the limit is ${WEB_PUSH_MAX_PAYLOAD}.`);
    }
    const uaPublic = b64url.decode(subscription.keys.p256dh);
    const authSecret = b64url.decode(subscription.keys.auth);
    if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Malformed push subscription keys.');

    const sender = crypto.createECDH('prime256v1');
    const asPublic = sender.generateKeys();
    const sharedSecret = sender.computeSecret(uaPublic);

    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
    const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    // 0x02 marks the last (here, only) record; no further padding.
    const record = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header.writeUInt8(asPublic.length, 20);
    return Buffer.concat([header, asPublic, record]);
  }

  /** `Authorization` header value for the push service at `endpoint` (RFC 8292). */
  static vapidAuthorization(endpoint: string, config: VapidConfig, now = Date.now()): string {
    const header = b64url.encode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = b64url.encode(
      Buffer.from(
        JSON.stringify({
          aud: new URL(endpoint).origin,
          // Push services reject anything over 24h.
          exp: Math.floor(now / 1000) + 12 * 60 * 60,
          sub: config.subject,
        }),
      ),
    );
    const pub = b64url.decode(config.publicKey);
    const key = crypto.createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: b64url.encode(privateScalar(config.privateKey)),
        x: b64url.encode(pub.subarray(1, 33)),
        y: b64url.encode(pub.subarray(33, 65)),
      },
    });
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${b64url.encode(signature)}, k=${config.publicKey}`;
  }

  /** Encrypts and delivers one message. Network failures resolve as `ok: false`, never throw. */
  static async send(
    subscription: WebPushSubscription,
    payload: string | Record<string, unknown>,
    config: VapidConfig,
    options: WebPushOptions = {},
  ): Promise<WebPushResult> {
    const body = WebPushUtil.encrypt(
      subscription,
      Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8'),
    );
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(options.ttl ?? 24 * 60 * 60),
      Urgency: options.urgency ?? 'normal',
      Authorization: WebPushUtil.vapidAuthorization(subscription.endpoint, config),
    };
    if (options.topic) headers.Topic = options.topic;

    try {
      const response = await fetch(subscription.endpoint, {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = response.ok ? undefined : (await response.text().catch(() => '')).slice(0, 300);
      return {
        ok: response.ok,
        statusCode: response.status,
        expired: response.status === 404 || response.status === 410,
        body: text,
      };
    } catch (error: any) {
      return { ok: false, statusCode: 0, expired: false, body: error?.message ?? String(error) };
    }
  }
}
