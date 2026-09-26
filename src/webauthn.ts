// Passkeys (WebAuthn) on the server, with node:crypto only: the small
// subset of CBOR, authenticator data and COSE keys that registering and
// signing in need. Attestation is not checked ("none"): the server trusts
// the key it is given at registration, as most passkey sites do.
import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
} from "node:crypto";

export class WebAuthnError extends Error {}

const fail = (message: string): never => {
  throw new WebAuthnError(message);
};

export const toBase64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");
export const fromBase64url = (text: unknown, what: string): Buffer => {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text))
    fail(`${what} is not base64url`);
  return Buffer.from(text as string, "base64url");
};

// ---------------------------------------------------------------- CBOR

type Cbor =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | Cbor[]
  | Map<Cbor, Cbor>;

/** Decodes one CBOR item; returns it and where it ended. */
export function decodeCbor(bytes: Uint8Array, start = 0): [Cbor, number] {
  let at = start;
  const need = (n: number) => {
    if (at + n > bytes.length) fail("CBOR ends early");
  };
  const byte = () => {
    need(1);
    return bytes[at++]!;
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    const size =
      info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!size) fail("CBOR length is not supported");
    need(size);
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + bytes[at++]!;
    if (!Number.isSafeInteger(value)) fail("CBOR length is too large");
    return value;
  };
  const item = (depth: number): Cbor => {
    if (depth > 16) fail("CBOR is nested too deeply");
    const head = byte();
    const major = head >> 5;
    const info = head & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2:
      case 3: {
        const n = length(info);
        need(n);
        const chunk = bytes.subarray(at, at + n);
        at += n;
        return major === 2 ? chunk : new TextDecoder().decode(chunk);
      }
      case 4: {
        const n = length(info);
        if (n > 1000) fail("CBOR array is too long");
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        const n = length(info);
        if (n > 1000) fail("CBOR map is too long");
        const map = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const key = item(depth + 1);
          map.set(key, item(depth + 1));
        }
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        return fail("CBOR value is not supported");
      default:
        return fail("CBOR tags are not supported");
    }
  };
  const value = item(0);
  return [value, at];
}

// ---------------------------------------------------------------- data

export interface AuthenticatorData {
  readonly rpIdHash: Buffer;
  readonly userPresent: boolean;
  readonly userVerified: boolean;
  readonly signCount: number;
  readonly credentialId?: Buffer;
  readonly publicKey?: JsonWebKey;
}

/** COSE key → JWK, for ES256 and RS256 keys. */
export function coseToJwk(cose: Cbor): JsonWebKey {
  if (!(cose instanceof Map)) return fail("The public key is not a COSE key");
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (key: number) => {
    const v = cose.get(key);
    return v instanceof Uint8Array
      ? toBase64url(v)
      : fail("COSE key misses a part");
  };
  if (kty === 2 && alg === -7 && cose.get(-1) === 1)
    return {
      kty: "EC",
      crv: "P-256",
      x: bytes(-2),
      y: bytes(-3),
      alg: "ES256",
    };
  if (kty === 3 && alg === -257)
    return { kty: "RSA", n: bytes(-1), e: bytes(-2), alg: "RS256" };
  return fail("Only ES256 and RS256 passkeys are supported");
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) fail("Authenticator data is too short");
  const flags = data[32]!;
  const result: AuthenticatorData = {
    rpIdHash: data.subarray(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount: data.readUInt32BE(33),
  };
  if (!(flags & 0x40)) return result;
  // Attested credential data: AAGUID, id length, id, COSE key.
  if (data.length < 55) fail("Authenticator data misses its credential");
  const idLength = data.readUInt16BE(53);
  const id = data.subarray(55, 55 + idLength);
  if (id.length !== idLength) fail("Authenticator data ends early");
  const [cose] = decodeCbor(data, 55 + idLength);
  return { ...result, credentialId: id, publicKey: coseToJwk(cose) };
}

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest();

const same = (a: Buffer, b: Buffer) =>
  a.length === b.length && timingSafeEqual(a, b);

interface Expected {
  /** base64url of the challenge the server handed out. */
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
}

function checkClientData(
  raw: Buffer,
  type: "webauthn.create" | "webauthn.get",
  expected: Expected,
) {
  let client: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    client = JSON.parse(raw.toString("utf8"));
  } catch {
    return fail("clientDataJSON is not JSON");
  }
  if (client.type !== type) fail("The passkey answered the wrong request");
  if (client.challenge !== expected.challenge)
    fail("The passkey answered another challenge");
  if (client.origin !== expected.origin)
    fail(`The passkey was used on another site (${String(client.origin)})`);
}

/** Checks a registration (navigator.credentials.create) response. */
export function verifyRegistration(
  credential: unknown,
  expected: Expected,
): { id: string; publicKey: JsonWebKey; signCount: number } {
  const response = (credential as { response?: Record<string, unknown> })
    ?.response;
  if (!response) return fail("No passkey response");
  const clientData = fromBase64url(response.clientDataJSON, "clientDataJSON");
  checkClientData(clientData, "webauthn.create", expected);
  const [attestation] = decodeCbor(
    fromBase64url(response.attestationObject, "attestationObject"),
  );
  if (!(attestation instanceof Map)) return fail("Attestation is not a map");
  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array))
    return fail("Attestation misses authData");
  const data = parseAuthenticatorData(Buffer.from(authData));
  if (!same(data.rpIdHash, sha256(expected.rpId)))
    fail("The passkey belongs to another site");
  if (!data.userPresent) fail("The passkey was used without the user");
  if (!data.credentialId || !data.publicKey) fail("The passkey sent no key");
  return {
    id: toBase64url(data.credentialId!),
    publicKey: data.publicKey!,
    signCount: data.signCount,
  };
}

/** Checks a sign-in (navigator.credentials.get) response against the
 * stored key; returns the authenticator's new signature count. */
export function verifyAuthentication(
  credential: unknown,
  expected: Expected & { publicKey: JsonWebKey; signCount: number },
): number {
  const response = (credential as { response?: Record<string, unknown> })
    ?.response;
  if (!response) return fail("No passkey response");
  const clientData = fromBase64url(response.clientDataJSON, "clientDataJSON");
  checkClientData(clientData, "webauthn.get", expected);
  const authData = fromBase64url(
    response.authenticatorData,
    "authenticatorData",
  );
  const data = parseAuthenticatorData(authData);
  if (!same(data.rpIdHash, sha256(expected.rpId)))
    fail("The passkey belongs to another site");
  if (!data.userPresent) fail("The passkey was used without the user");
  const key = createPublicKey({ key: expected.publicKey, format: "jwk" });
  const signed = Buffer.concat([authData, sha256(clientData)]);
  const signature = fromBase64url(response.signature, "signature");
  if (!verify("sha256", signed, key, signature))
    fail("The passkey's signature does not match");
  // A counter that does not grow means a cloned authenticator; zero means
  // the authenticator keeps none (most synced passkeys).
  if (data.signCount !== 0 && data.signCount <= expected.signCount)
    fail("The passkey's counter went backwards");
  return data.signCount;
}
