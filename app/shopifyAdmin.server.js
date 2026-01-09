// app/shopifyAdmin.server.js
import { unauthenticated } from "./shopify.server.js";

/**
 * Get an Admin API context for a shop without an incoming request.
 * Uses the OFFLINE session from your configured sessionStorage.
 */
export async function getShopifyAdminForShop(shop) {
  if (!shop) throw new Error("getShopifyAdminForShop: missing shop");

  // returns { admin, session }
  const { admin } = await unauthenticated.admin(shop);

  if (!admin?.graphql) {
    throw new Error(`Could not get admin graphql client for shop=${shop}`);
  }

  return admin; // admin.graphql(...) -> Response with .json()
}