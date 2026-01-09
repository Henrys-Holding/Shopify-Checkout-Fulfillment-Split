import { authenticate } from "../shopify.server";
import { ordersCreateQueue } from "../queues/ordersCreate.queue.server.js";

function getEventId(request) {
  // Shopify recommends using this to detect duplicates :contentReference[oaicite:3]{index=3}
  return (
    request.headers.get("X-Shopify-Event-Id") ||
    request.headers.get("X-Shopify-Webhook-Id") ||
    null
  );
}

export const action = async ({ request }) => {
  console.log('action orders.create.queued')
  const { shop, topic, payload } = await authenticate.webhook(request);

  // Only accept orders/create here (optional hard gate)
//   if (topic !== "ORDERS_CREATE" && topic !== "orders/create") {
//     return new Response("ignored", { status: 200 });
//   }
 const eventId = getEventId(request);
 console.log('add orders_create_pipeline',{ shop, topic, payload })
  try {
    await ordersCreateQueue.add(
      "orders_create_pipeline",
      { shop, topic, payload },
      {
        // ✅ dedupe duplicates for 1 day even if jobs get cleaned up
        ...(eventId
          ? { deduplication: { id: eventId, ttl: 24 * 60 * 60 * 1000 } }
          : {}),
        // (Optional) also set jobId for easier tracing; duplicate jobIds are ignored :contentReference[oaicite:4]{index=4}
        ...(eventId ? { jobId: eventId } : {}),
      }
    );

    // Return 200 fast so Shopify stops retrying
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("Failed to enqueue orders/create job", err);

    // If you return non-200, Shopify will retry the webhook (often what you want if Redis is down)
    return new Response("enqueue_failed", { status: 500 });
  }
};
