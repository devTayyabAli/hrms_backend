import * as crypto from 'crypto';

export class TotpUtil {
  private static base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  public static generateSecret(length = 20): string {
    const buffer = crypto.randomBytes(length);
    let secret = '';
    for (let i = 0; i < buffer.length; i++) {
      secret += this.base32Alphabet[buffer[i] % 32];
    }
    return secret;
  }

  public static generateURI(issuer: string, label: string, secret: string): string {
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  }

  public static verify(token: string, secret: string, window = 1): boolean {
    if (!token || !secret || token.length !== 6) return false;
    const timeStep = 30;
    const counter = Math.floor(Date.now() / 1000 / timeStep);
    for (let i = -window; i <= window; i++) {
      if (this.generateToken(secret, counter + i) === token) {
        return true;
      }
    }
    return false;
  }

  public static generateToken(secret: string, counter?: number): string {
    const timeStep = 30;
    const cnt = counter !== undefined ? counter : Math.floor(Date.now() / 1000 / timeStep);
    const key = this.base32Decode(secret);
    const buf = Buffer.alloc(8);
    let tmp = cnt;
    for (let i = 7; i >= 0; i--) {
      buf[i] = tmp & 0xff;
      tmp = Math.floor(tmp / 256);
    }
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return (code % 1000000).toString().padStart(6, '0');
  }

  private static base32Decode(base32: string): Buffer {
    const cleaned = base32.toUpperCase().replace(/=+$/, '');
    const bits: number[] = [];
    for (let i = 0; i < cleaned.length; i++) {
      const val = this.base32Alphabet.indexOf(cleaned[i]);
      if (val === -1) continue;
      for (let j = 4; j >= 0; j--) {
        bits.push((val >> j) & 1);
      }
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) {
        byte = (byte << 1) | bits[i + j];
      }
      bytes.push(byte);
    }
    return Buffer.from(bytes);
  }
}
