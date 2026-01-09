import IORedis from "ioredis";
import "dotenv/config"; 

export function getRedisUrl() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("Missing REDIS_URL");
  return url;
}

/**
 * Producer connection: fail fast (don’t hang HTTP requests forever)
 * Worker will create its own connections internally.
 */
export function createProducerRedis() {
  return new IORedis(getRedisUrl(), {
    // keep default maxRetriesPerRequest for "fail fast" behavior on web requests
  });
}
