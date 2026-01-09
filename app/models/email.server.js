import db from "../db.server";
import { getSetting } from "./setting.server";
import { CreditCardOrderStatus, CreditCardVerificationStatus } from "@prisma/client";
import { OmnisendService } from "../omnisend.server";

/**
 * @typedef {{ success: true; id: string; message: string } |
 *           { success: false; id: string; message: string; error?: unknown }} FollowUpEmailResult
 */

/**
 * @typedef {Object} SendFollowUpEmailsOptions
 * @property {string} shop
 * @property {number=} olderThanDays
 * @property {boolean=} dryRun
 */

/**
 * @param {number} days
 * @returns {Date}
 */
function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * @param {string|null|undefined} customerLocale
 * @param {string|null|undefined} shippingCountry
 * @returns {"zh-CN"|"en"}
 */
function pickLocale(customerLocale, shippingCountry) {
  const isZh = (customerLocale?.startsWith("zh") ?? false) || shippingCountry === "CN";
  return isZh ? "zh-CN" : "en";
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function safeErrorMessage(err) {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * @param {SendFollowUpEmailsOptions} options
 * @returns {Promise<FollowUpEmailResult[]>}
 */
export async function sendFollowUpEmails(options) {
  const { shop, olderThanDays = 3, dryRun = false } = options;

  const cutoff = daysAgo(olderThanDays);
  const setting = await getSetting(shop);

  if (!setting?.enabled) {
    return [{ success: false, id: "setting", message: `App disabled for shop ${shop}.` }];
  }
  if (!setting.app_domain) {
    return [{ success: false, id: "setting", message: `Missing appDomain for shop ${shop}.` }];
  }

  const pendingVerifications = await db.creditCardVerification.findMany({
    where: {
      shop,
      created_at: { lte: cutoff },
      follow_up: false,
      status: CreditCardVerificationStatus.PENDING_SUBMISSION,
    },
    include: { orders: true },
  });

  const omnisend = new OmnisendService();

  /** @type {FollowUpEmailResult[]} */
  const results = [];

  for (const record of pendingVerifications) {
    const id = record.id;

    try {
      const to = record.customer_email?.trim();
      if (!to) {
        results.push({
          success: false,
          id,
          message: `Skipped: missing customerEmail (card=${record.credit_card_number}).`,
        });
        continue;
      }

      const locale = pickLocale(record.customer_locale, record.shipping_country);

      const verificationLink = `https://${setting.app_domain}/photo-proof/verify/${record.id}?token=${record.token}`;
      const holdOrderNumbers = record.orders
        .filter((o) => !o.cancelled_at)
        .map((o) => o.order_name);

      // Trigger an Omnisend custom event.
      const eventName = "Credit Card Verification Request";

      if (!dryRun) {
        await omnisend.sendEvent({
          eventName,
          contact: { email: to },
          properties: {
            customerLocale: locale,
            last4Digits: record.credit_card_number,
            orderNumbers: holdOrderNumbers,
            primaryActionLink: verificationLink,
          },
        });

        // idempotent update
        await db.creditCardVerification.updateMany({
          where: { id, follow_up: false },
          data: { follow_up: true },
        });
      }

      results.push({
        success: true,
        id,
        message: dryRun
          ? `DRY RUN: would trigger Omnisend event '${eventName}' to ${to}`
          : `Triggered Omnisend event '${eventName}' to ${to}`,
      });
    } catch (err) {
      console.error(`[follow-up] error for verification=${id}`, err);
      results.push({
        success: false,
        id,
        message: `Failed to trigger follow-up for verification ${id}: ${safeErrorMessage(err)}`,
        error: err,
      });
    }
  }

  return results;
}
