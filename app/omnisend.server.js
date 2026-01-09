// app/lib/omnisend.server.js
import "dotenv/config"; 
/**
 * @typedef {Record<string, unknown>} Json
 */

/**
 * @param {string} name
 * @returns {string}
 */
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * @typedef {Object} OmnisendEventPayload
 * @property {string} eventName
 * @property {("api"|string)=} origin
 * @property {{ email?: string, phone?: string, [k: string]: unknown }} contact
 * @property {Json=} properties
 */

export class OmnisendClient {
  /**
   * @param {{ apiKey?: string, baseUrl?: string }=} opts
   */
  constructor(opts) {
    this.apiKey = opts?.apiKey ?? requireEnv("OMNISEND_API_KEY");
    this.baseUrl = (
      opts?.baseUrl ??
      process.env.OMNISEND_API_BASE_URL ??
      "https://api.omnisend.com"
    ).replace(/\/+$/, "");
  }

  /**
   * @template T
   * @param {string} path
   * @param {unknown} body
   * @returns {Promise<T>}
   */
  async post(path, body) {
    const url = `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Omnisend API key header (per docs)
        "X-API-KEY": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    const data = text ? safeJsonParse(text) : null;

    if (!res.ok) {
      const err = new Error(
        `Omnisend request failed: ${res.status} ${res.statusText} - ${
          text || "<empty>"
        }`
      );
      err.status = res.status;
      err.response = data ?? text;
      throw err;
    }

    return /** @type {T} */ (data ?? {});
  }
}

/**
 * @param {string} input
 * @returns {any}
 */
function safeJsonParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export class OmnisendService {
  /**
   * @param {OmnisendClient=} client
   */
  constructor(client = new OmnisendClient()) {
    this.client = client;
  }

  /**
   * Sends a custom event. Use Omnisend Automation to email customers from this event.
   * @param {OmnisendEventPayload} payload
   */
  async sendEvent(payload) {
    console.log("sendEvent::payload", payload);
    return this.client.post("/v5/events", {
      ...payload,
      origin: payload.origin ?? "api",
    });
  }
}
