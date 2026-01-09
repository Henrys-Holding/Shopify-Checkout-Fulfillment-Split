import crypto from "crypto";
import db from "../db.server.js";
import { submitVerification, MAXIMUM_IMAGE } from "../models/verification.server.js";

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function timingSafeEqualHex(a, b) {
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

// Shopify app-proxy signature check (same logic you already used)
function verifyAppProxySignature(url, secret) {
  const params = url.searchParams;
  const provided = params.get("signature");
  if (!provided) return false;

  const keys = Array.from(new Set(Array.from(params.keys()))).filter(
    (k) => k !== "signature"
  );

  const message = keys
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${params.getAll(k).join(",")}`)
    .join(""); // IMPORTANT: no "&"

  const computed = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return timingSafeEqualHex(computed, provided);
}

const MAX_FILES = MAXIMUM_IMAGE ?? 3;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ success: false, message: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) return json({ success: false, message: "Missing secret" }, { status: 500 });

  if (!verifyAppProxySignature(url, secret)) {
    return json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // These come from app proxy query params
  const shop = url.searchParams.get("shop") || "";
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") || "";
  const customerGid = loggedInCustomerId
    ? `gid://shopify/Customer/${loggedInCustomerId}`
    : "";

  const formData = await request.formData();

  // Accept either "id" or "verificationId" from the client
  const rawId = formData.get("id") || formData.get("verificationId");
  const id = typeof rawId === "string" ? rawId.trim() : "";

  if (!id) {
    return json({ success: false, message: "Missing verification id." }, { status: 400 });
  }

  // Files: must be image/*, max 3, enforce size
  const files = formData.getAll("files").filter((v) => typeof v !== "string");

  if (files.length === 0) {
    return json({ success: false, message: "Please upload at least 1 image." }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return json({ success: false, message: `Max ${MAX_FILES} images allowed.` }, { status: 400 });
  }

  for (const f of files) {
    // f is a File in the server runtime
    const type = f?.type || "";
    const size = f?.size ?? 0;

    if (!type.startsWith("image/")) {
      return json({ success: false, message: "Only image files are allowed." }, { status: 400 });
    }
    if (size > MAX_FILE_SIZE_BYTES) {
      return json(
        { success: false, message: `Each image must be <= ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB.` },
        { status: 400 }
      );
    }
  }

  /**
   * IMPORTANT:
   * Your submitVerification() currently requires {id, token} when admin=null.
   *
   * Best approach for app-proxy:
   * - don’t rely on token from client
   * - verify the record belongs to the logged-in customer + shop
   * - then inject the token server-side (so submitVerification works unchanged)
   */
  const record = await db.creditCardVerification.findFirst({
    where: {
      id,
      shop,
      customer_id: customerGid,
    },
    select: { token: true },
  });

  if (!record) {
    return json({ success: false, message: "Verification not found or not allowed." }, { status: 403 });
  }

  // Ensure submitVerification receives fields it expects
  formData.set("id", id);
  formData.set("token", record.token);

  const result = await submitVerification(formData, null);

  return json(result, { status: result?.success ? 200 : 400 });
}
