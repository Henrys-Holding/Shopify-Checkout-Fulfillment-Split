import crypto from "crypto";
import db from "../db.server";

function timingSafeEqualHex(a, b) {
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

// Per Shopify: signature is SHA-256 HMAC (hex) of other query params sorted and joined.
// Important detail: build the message by sorting keys and concatenating key=value pairs
// with NO "&" delimiter (Shopify app proxy signature behavior).
function verifyAppProxySignature(url, secret) {
  const params = url.searchParams;
  const provided = params.get("signature");
  if (!provided) return false;

  // Build: key=value (values joined by "," for duplicate keys),
  // sort by key, then concatenate with NO delimiter.
  const keys = Array.from(new Set(Array.from(params.keys()))).filter(
    (k) => k !== "signature"
  );

  const message = keys
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${params.getAll(k).join(",")}`)
    .join(""); // ✅ IMPORTANT: no "&"

  const computed = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return timingSafeEqualHex(computed, provided);
}

function buildVerifyUrl(appUrl, id, token) {
  const base = appUrl.replace(/\/$/, ""); // remove trailing slash
  return `${base}/photo-proof/verify/${id}?token=${encodeURIComponent(token)}`;
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) return new Response("Missing secret", { status: 500 });

  if (!verifyAppProxySignature(url, secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shop = url.searchParams.get("shop") || "";
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") || "";

  if (!loggedInCustomerId) {
    return Response.json({ loggedIn: false, verifications: [] });
  }

  const customerGid = `gid://shopify/Customer/${loggedInCustomerId}`;

  // NOTE: your model name might be `creditCardVerification` not `verification`.
  // Keep it consistent with your schema.
  const verifications = await db.creditCardVerification.findMany({
    where: { shop, customer_id: customerGid },
    orderBy: { created_at: "desc" },
    include: { orders: true, bin_lookup: true },
  });

  const appUrl = process.env.SHOPIFY_APP_URL || "";

  const payload = verifications.map((v) => ({
    id: v.id,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    status: v.status,
    last4: v.credit_card_number,
    bin: v.credit_card_bin,
    company: v.credit_card_company,
    shippingCountry: v.shipping_country,
    riskLevel: v.risk_level,
    riskRecommendation: v.risk_recommendation,

    verifyUrl:
      v.status === "PENDING_SUBMISSION" && appUrl
        ? buildVerifyUrl(appUrl, v.id, v.token)
        : null,

    orders: (v.orders || []).map((o) => ({
      id: o.order_id,
      number: o.order_name,
    })),

    binLookup: v.binLookup
      ? {
          bank: v.binLookup.bank,
          country: v.binLookup.country,
          countryCode: v.binLookup.countryCode,
          scheme: v.binLookup.scheme,
          type: v.binLookup.type,
        }
      : null,
  }));
  
  return Response.json({ loggedIn: true, verifications: payload });
};
