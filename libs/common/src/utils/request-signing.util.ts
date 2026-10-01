import * as crypto from 'crypto';
import {
  MicroserviceAuthContext,
  SignedMicroservicePayload,
} from '../interfaces/microservice-auth.interface';

/** Signed microservice messages older than this are rejected (replay protection). */
export const SIGNATURE_MAX_AGE_MS = 30_000;

function computeSignature(
  data: unknown,
  context: MicroserviceAuthContext,
  timestamp: number,
  secret: string,
): string {
  const canonical = JSON.stringify({ data, context, timestamp });
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export function signMicroservicePayload<T>(
  data: T,
  context: MicroserviceAuthContext,
  secret: string,
): SignedMicroservicePayload<T> {
  const timestamp = Date.now();
  const signature = computeSignature(data, context, timestamp, secret);
  return { data, context, timestamp, signature };
}

/**
 * Property under which a transport-level signature rides along with an
 * ordinary message payload.
 *
 * The `SignedMicroservicePayload` envelope above is the richer form: it
 * carries the caller's identity where a handler needs it, at the cost of
 * changing the payload's shape, so a handler has to be rewritten to accept
 * it. That cost is why signing only ever reached thirteen of this platform's
 * ~260 message patterns, leaving the rest of every microservice's TCP port an
 * unauthenticated admin API.
 *
 * This form attaches the same signature and the same caller context as one
 * extra property on the payload object, leaving the payload otherwise
 * untouched. A handler's DTO is unaffected, the guard strips the property
 * before validation runs, and signing can therefore be turned on for every
 * pattern at once rather than one rewritten handler at a time.
 */
export const RPC_SIGNATURE_KEY = '__rpcAuth';

export interface RpcSignatureEnvelope {
  context: MicroserviceAuthContext;
  timestamp: number;
  signature: string;
}

/** True for a payload shape that can carry an attached signature. */
function isPlainPayloadObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
  );
}

/**
 * Returns a copy of `data` carrying a signature over its own contents.
 *
 * A copy, not a mutation: the caller usually passes a validated DTO instance
 * that may be reused (retries, logging), and quietly growing a property on it
 * would leak into both.
 */
export function attachRpcSignature<T>(
  data: T,
  context: MicroserviceAuthContext,
  secret: string,
): T {
  if (!isPlainPayloadObject(data)) {
    return data;
  }

  // Signed over the payload *without* the signature property, which is what
  // the verifier reconstructs. The discarded binding is the rest-omit idiom:
  // re-signing an already-signed payload must not fold the old signature in.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [RPC_SIGNATURE_KEY]: discarded, ...body } = data as Record<
    string,
    unknown
  >;
  const timestamp = Date.now();
  const signature = computeSignature(body, context, timestamp, secret);

  return {
    ...body,
    [RPC_SIGNATURE_KEY]: { context, timestamp, signature },
  } as T;
}

export interface RpcSignatureVerification {
  valid: boolean;
  /** Caller identity from the verified signature, when valid. */
  context?: MicroserviceAuthContext;
  /** Why verification failed, for logging. Never returned to the caller. */
  reason?: string;
}

/**
 * Verifies a signature attached by `attachRpcSignature` and, on success,
 * removes it from the payload in place.
 *
 * Removal has to happen before the validation pipe runs, or
 * `forbidNonWhitelisted` would reject every signed message for carrying a
 * property its DTO does not declare. Deleting the property from the payload
 * object — rather than replacing the argument — is what keeps this
 * independent of how the framework passes handler arguments around.
 */
export function verifyAndStripRpcSignature(
  payload: unknown,
  secret: string,
): RpcSignatureVerification {
  if (!isPlainPayloadObject(payload)) {
    return { valid: false, reason: 'payload is not a signable object' };
  }

  const envelope = payload[RPC_SIGNATURE_KEY] as
    Partial<RpcSignatureEnvelope> | undefined;

  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, reason: 'no signature attached' };
  }
  if (
    typeof envelope.signature !== 'string' ||
    typeof envelope.timestamp !== 'number'
  ) {
    return { valid: false, reason: 'malformed signature envelope' };
  }
  if (Date.now() - envelope.timestamp > SIGNATURE_MAX_AGE_MS) {
    return { valid: false, reason: 'signature expired' };
  }

  // Rest-omit: the signature cannot be part of what it signs.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [RPC_SIGNATURE_KEY]: discarded, ...body } = payload;
  const expected = computeSignature(
    body,
    envelope.context,
    envelope.timestamp,
    secret,
  );

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(envelope.signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: 'signature mismatch' };
  }
  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  delete payload[RPC_SIGNATURE_KEY];
  return { valid: true, context: envelope.context };
}

/** True if `payload` looks like the nested SignedMicroservicePayload envelope. */
export function isSignedEnvelope(
  payload: unknown,
): payload is SignedMicroservicePayload {
  if (!isPlainPayloadObject(payload)) return false;
  return (
    'data' in payload &&
    'signature' in payload &&
    'timestamp' in payload &&
    'context' in payload
  );
}

export function verifyMicroservicePayload(
  payload: unknown,
  secret: string,
): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const envelope = payload as Partial<SignedMicroservicePayload>;

  if (
    typeof envelope.signature !== 'string' ||
    typeof envelope.timestamp !== 'number'
  ) {
    return false;
  }
  if (Date.now() - envelope.timestamp > SIGNATURE_MAX_AGE_MS) {
    return false;
  }

  const expected = computeSignature(
    envelope.data,
    envelope.context,
    envelope.timestamp,
    secret,
  );

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(envelope.signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
