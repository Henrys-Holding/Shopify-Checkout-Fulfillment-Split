import { Worker } from "bullmq";
import IORedis from "ioredis";
import "dotenv/config"; 

import { ORDERS_CREATE_QUEUE_NAME } from "../app/queues/ordersCreate.queue.server.js";
import { getShopifyAdminForShop } from "../app/shopifyAdmin.server.js";
import { handleSplitPrimaryOrderCreated } from "../app/handlers/split.js";
import { handleCreditCardVerificationOrderCreated } from "../app/handlers/cc.js";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("Missing REDIS_URL");

// Worker connection should not hard-fail due to retries limit (BullMQ guidance) :contentReference[oaicite:6]{index=6}
const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const worker = new Worker(
  ORDERS_CREATE_QUEUE_NAME,
  async (job) => {
    const { shop, payload } = job.data;

    // create admin client from offline session (your helper)
    const admin = await getShopifyAdminForShop(shop);
    
    // console.log('worker admin', admin);
    // ✅ YOUR guaranteed sequence: 
    // console.log('b4 handleSplitPrimaryOrderCreated', {shop, payload});
    
    await handleSplitPrimaryOrderCreated({ shop, admin, payload });
    console.log('afeter handleCreditCardVerificationOrderCreated', {shop, payload});
    
    await handleCreditCardVerificationOrderCreated({ shop, admin, payload });
    
    return { ok: true };
  },
  {
    connection,

    // If you want strict global ordering, set 1.
    // Usually you can increase and still keep per-job sequence.
    concurrency: 5,

    // Optional: basic rate limiting to reduce Shopify API bursts :contentReference[oaicite:7]{index=7}
    limiter: { max: 4, duration: 1000 },

    // You can also override cleanup here (job opts can override worker opts)
    removeOnComplete: { age: 24 * 3600, count: 2000 },
    removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
  }
);

worker.on("completed", (job) => {
  console.log("✅ DONE", job.id, job.name);
});

worker.on("failed", (job, err) => {
  console.error("❌ FAILED", job?.id, "attempt", job?.attemptsMade, err);
  // BullMQ will auto-retry until attempts are exhausted :contentReference[oaicite:8]{index=8}
});
