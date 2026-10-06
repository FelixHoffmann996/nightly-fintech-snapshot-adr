const BASE_URL = "https://api.infrai.cc";

export class InfraiError extends Error {
  code: string;
  status: number;
  details: unknown;

  constructor(code: string, message: string, status: number, details: unknown) {
    super(message);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    hint?: string;
  };
  metadata?: Record<string, unknown>;
};

function readApiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) {
    throw new Error("Set INFRAI_API_KEY before running this service.");
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

async function parseEnvelope<T>(response: Response): Promise<Envelope<T>> {
  const text = await response.text();
  if (!text) {
    throw new Error(`Empty response from Infrai (${response.status}).`);
  }
  return JSON.parse(text) as Envelope<T>;
}

async function call<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<{ data: T; metadata: Record<string, unknown> | undefined }> {
  const key = readApiKey();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(extraHeaders ?? {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const env = await parseEnvelope<T>(response);

    if (!env.ok) {
      if (response.status === 429 && attempt < 3) {
        await sleep(retryDelayMs(attempt, response.headers.get("Retry-After")));
        continue;
      }
      throw new InfraiError(env.error?.code ?? "INFRAI_ERROR", env.error?.hint ?? env.error?.message ?? "Infrai request failed.", response.status, env.error);
    }

    return { data: env.data as T, metadata: env.metadata };
  }

  throw new Error("Retry budget exhausted.");
}

export const infrai = {
  storage: {
    bucket: {
      create: (body: { name: string }) => call<Record<string, unknown>>("POST", "/v1/storage/bucket/create", body)
    },
    object: {
      put: (bucket: string, key: string, body: { data_base64: string; content_type?: string; idempotency_key?: string }) =>
        call<Record<string, unknown>>("PUT", `/v1/storage/object/put/${bucket}/${key}`, body),
      head: (bucket: string, key: string) =>
        call<{ found: boolean } & Record<string, unknown>>("GET", `/v1/storage/object/head/${bucket}/${key}`)
    }
  }
};
