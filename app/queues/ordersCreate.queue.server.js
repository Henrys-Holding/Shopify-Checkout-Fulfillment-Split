import { Queue } from "bullmq";
import { createProducerRedis } from "./redis.server.js";

export const ORDERS_CREATE_QUEUE_NAME = "orders-create";

const connection = createProducerRedis();

export const ordersCreateQueue = new Queue(ORDERS_CREATE_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    // ✅ automatic retry if worker throws
    attempts: 1,
    backoff: { type: "exponential", delay: 1000 }, // 1s, 2s, 4s...
    // keep some history so you can debug (age is seconds) :contentReference[oaicite:1]{index=1}
    removeOnComplete: { age: 24 * 3600, count: 2000 },
    removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
  },
});
