// A software passkey for tests: makes the responses a browser would send
// for navigator.credentials.create and .get, with a P-256 key.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function encode(value: Cbor): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === "number")
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array)
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (Array.isArray(value))
    return Buffer.concat([head(4, value.length), ...value.map(encode)]);
  return Buffer.concat([
    head(5, value.size),
    ...[...value].flatMap(([k, v]) => [encode(k), encode(v)]),
  ]);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest();

export class SoftPasskey {
  readonly id = randomBytes(16);
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private counter = 0;
  constructor(
    readonly origin: string,
    readonly rpId: string,
  ) {}

  private clientData(type: string, challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin }));
  }

  create(options: { challenge: string }, overrides: { origin?: string } = {}) {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x41]), // user present, attested credential data
      Buffer.alloc(4),
      Buffer.alloc(16), // AAGUID
      idLength,
      this.id,
      encode(cose),
    ]);
    return {
      id: b64(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64(
          this.clientData(
            "webauthn.create",
            options.challenge,
            overrides.origin,
          ),
        ),
        attestationObject: b64(
          encode(
            new Map<Cbor, Cbor>([
              ["fmt", "none"],
              ["attStmt", new Map()],
              ["authData", authData],
            ]),
          ),
        ),
      },
    };
  }

  get(options: { challenge: string }, overrides: { counter?: number } = {}) {
    this.counter = overrides.counter ?? this.counter + 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x05]), // user present and verified
      count,
    ]);
    const clientData = this.clientData("webauthn.get", options.challenge);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientData)]),
      this.keys.privateKey,
    );
    return {
      id: b64(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
      },
    };
  }
}
