/**
 * Minimal S3-compatible object-storage client (AWS Signature V4 over fetch) — enough for
 * backups: put, get, list, delete. Works with any S3-compatible store (Backblaze B2,
 * Railway Buckets, Cloudflare R2, AWS S3, MinIO). No SDK dependency.
 *
 * Addressing is virtual-hosted (`https://<bucket>.<endpoint-host>/<key>`) by default;
 * `pathStyle` switches to `https://<endpoint-host>/<bucket>/<key>` (MinIO, local fakes).
 */
import crypto from 'node:crypto';

export interface S3Config {
  endpoint: string; // e.g. https://s3.us-east-005.backblazeb2.com (scheme optional ⇒ https)
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle?: boolean;
}

export interface S3Object { key: string; size: number; lastModified: string }

const sha256hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20130524T000000Z` */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * The SigV4 `Authorization` header for one request. `headers` are the headers to sign
 * (lower-case names, must include host, x-amz-content-sha256 and x-amz-date). Exported
 * for the AWS test vectors in tests/s3.test.ts.
 */
export function signV4(opts: {
  method: string;
  path: string; // already URI-encoded canonical path
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}): string {
  const date = opts.headers['x-amz-date']!;
  const day = date.slice(0, 8);
  const names = Object.keys(opts.headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(opts.headers[h]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(opts.query).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(opts.query[k]!)}`).join('&');
  const canonicalRequest = [opts.method, opts.path, canonicalQuery, canonicalHeaders, signedHeaders, opts.payloadHash].join('\n');
  const scope = `${day}/${opts.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), opts.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

export class S3Client {
  private readonly base: URL;
  constructor(private readonly cfg: S3Config) {
    this.base = new URL(/^https?:\/\//i.test(cfg.endpoint) ? cfg.endpoint : `https://${cfg.endpoint}`);
  }

  private async request(method: string, key: string, query: Record<string, string> = {}, body?: Buffer): Promise<Response> {
    const encKey = key.split('/').map(uriEncode).join('/');
    const host = this.cfg.pathStyle ? this.base.host : `${this.cfg.bucket}.${this.base.host}`;
    const path = this.cfg.pathStyle ? `/${uriEncode(this.cfg.bucket)}/${encKey}` : `/${encKey}`;
    const payloadHash = sha256hex(body ?? '');
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate(new Date()),
    };
    const authorization = signV4({
      method, path, query, headers, payloadHash,
      region: this.cfg.region, accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey,
    });
    const qs = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`).join('&');
    const url = `${this.base.protocol}//${host}${path}${qs ? `?${qs}` : ''}`;
    const { host: _host, ...sendHeaders } = headers; // fetch sets Host itself
    return fetch(url, {
      method,
      headers: { ...sendHeaders, authorization, ...(body ? { 'content-type': 'application/octet-stream' } : {}) },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  private static async fail(op: string, key: string, res: Response): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
    throw new Error(`S3 ${op} ${key || '(bucket)'} failed: HTTP ${res.status}${code ? ` ${code}` : ''}${msg ? ` — ${msg}` : ''}`);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const res = await this.request('PUT', key, {}, body);
    if (!res.ok) await S3Client.fail('PUT', key, res);
    await res.arrayBuffer();
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.request('GET', key);
    if (!res.ok) await S3Client.fail('GET', key, res);
    return Buffer.from(await res.arrayBuffer());
  }

  /** The object's bytes, or null if there is no such key. */
  async getIfExists(key: string): Promise<Buffer | null> {
    const res = await this.request('GET', key);
    if (res.status === 404) { await res.arrayBuffer(); return null; }
    if (!res.ok) await S3Client.fail('GET', key, res);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) await S3Client.fail('DELETE', key, res);
    await res.arrayBuffer();
  }

  /** Every object under `prefix` (follows continuation tokens). */
  async list(prefix = ''): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const res = await this.request('GET', '', query);
      if (!res.ok) await S3Client.fail('LIST', prefix, res);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const part = m[1]!;
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(part)?.[1] ?? '';
        out.push({
          key: decodeXml(key),
          size: Number(/<Size>(\d+)<\/Size>/.exec(part)?.[1] ?? 0),
          lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(part)?.[1] ?? '',
        });
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated ? decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || undefined : undefined;
    } while (token);
    return out;
  }
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
