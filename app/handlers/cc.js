// app/handlers/cc.js
import db from "../db.server.js";
import {
  CreditCardVerificationStatus,
  CreditCardRiskLevel,
  CreditCardRiskRecommendation,
} from "@prisma/client";
import { randomInt } from "crypto";

// --- TODO: replace these imports with your real implementations ---
import { fetchBinInfo } from "../models/binLookup.server.js";
import {
  generateSecureToken,
} from "../models/verification.server.js";
import { OmnisendService } from "../omnisend.server.js";
import { getSetting } from "../models/setting.server.js";
import { supabase } from "../supabase.server.js";
// ---------------------------------------------------------------

function isRiskLevel(v) {
  return (
    v === CreditCardRiskLevel.LOW ||
    v === CreditCardRiskLevel.MEDIUM ||
    v === CreditCardRiskLevel.HIGH ||
    v === CreditCardRiskLevel.NONE ||
    v === CreditCardRiskLevel.PENDING
  );
}

function isRiskRecommendation(v) {
  return (
    v === CreditCardRiskRecommendation.ACCEPT ||
    v === CreditCardRiskRecommendation.CANCEL ||
    v === CreditCardRiskRecommendation.INVESTIGATE ||
    v === CreditCardRiskRecommendation.NONE
  );
}

function extractLast4(accountNumber) {
  const match = String(accountNumber || "").match(/(\d{4})$/);
  return (match && match[1]) || null;
}

/**
 * Credit card verification pipeline for an orders/create payload.
 *
 * @param {object} params
 * @param {string} params.shop
 * @param {object} params.admin Shopify Admin GraphQL client
 * @param {object} params.payload Shopify webhook payload
 */
export async function handleCreditCardVerificationOrderCreated({
  shop,
  admin,
  payload,
}) {
  if (!admin) return { skipped: true, reason: "no_admin" };

  const safePayload = payload || {};

  const {
    id: orderId,
    name,
    customer,
    admin_graphql_api_id,
    billing_address,
    shipping_address,
    payment_gateway_names = [],
    customer_locale,
    financial_status,
  } = safePayload;

  console.log(`Handling CC verification for order create ${name}`);

  // Only authorized
  if (financial_status !== "authorized") {
    console.log("Exit. Financial status is not authorized.", financial_status);
    return { skipped: true, reason: "financial_status_not_authorized" };
  }

  // US -> US orders ignored
  if (
    billing_address?.country_code === "US" &&
    shipping_address?.country_code === "US"
  ) {
    console.log("Exit. Billing & Shipping address located in USA.");
    return { skipped: true, reason: "us_to_us" };
  }

  // Must be credit card-ish gateway
  const gatewayOk =
    payment_gateway_names.includes("credit card") ||
    payment_gateway_names.includes("authorize_net") ||
    payment_gateway_names.includes("authorize.net") ||
    payment_gateway_names.includes("sage") ||
    payment_gateway_names.includes("Moneris") ||
    payment_gateway_names.includes("bogus");

  if (!gatewayOk) {
    console.log(
      "Exit. Credit Card not found in payment gateway.",
      payment_gateway_names
    );
    return { skipped: true, reason: "gateway_not_supported" };
  }

  const setting = await getSetting(shop);
  if (!setting.enabled) {
    console.log("Exit. App disabled in setting.");
    return { skipped: true, reason: "app_disabled" };
  }
  
  // Need order GID to query GraphQL
  if (!admin_graphql_api_id) {
    console.log("Exit. Missing admin_graphql_api_id in payload");
    return { skipped: true, reason: "missing_order_gid" };
  }

  // --- Query details (risk + transactions + fulfillmentOrders) ---
  const gqlRes = await admin.graphql(
    `#graphql
    query order($id: ID!) {
      order(id: $id) {
        risk {
          assessments {
            riskLevel
            facts { description sentiment }
          }
          recommendation
        }
        customer {
          id
          displayName
        }
        transactions {
          accountNumber
          id
          kind
          status
          totalUnsettledSet {
            presentmentMoney { amount currencyCode }
          }
          paymentDetails {
            ... on CardPaymentDetails {
              bin
              company
            }
          }
        }
        fulfillmentOrders(first: 10) {
          nodes {
            id
            status
            orderId
          }
        }
      }
    }`,
    { variables: { id: admin_graphql_api_id } }
  );
  
  const gqlJson = await gqlRes.json();
  const order = gqlJson?.data?.order;
  
  if (!order) {
    console.log("Exit. GraphQL order query returned null", gqlJson);
    return { skipped: true, reason: "order_null" };
  }

  if (!order.customer?.id) {
    console.log("Exit. No customer on this order (guest checkout?)");
    return { skipped: true, reason: "no_customer" };
  }

  const customerId = order.customer.id;
  const customerName = order.customer.displayName ?? "";
  const customerEmail = String(customer?.email ?? "").trim();

  const txs = Array.isArray(order.transactions) ? order.transactions : [];

  let didAnything = false;
  
  for (const transaction of txs) {
    if (transaction?.status !== "SUCCESS") {
      console.log("Pass. Transaction status not success.", transaction?.status);
      continue;
    }

    if (!transaction?.accountNumber) {
      console.log("Pass. accountNumber is null.");
      continue;
    }

    let last4Digits = extractLast4(transaction.accountNumber);
    if (!last4Digits) {
      // keep your behavior: generate last4 if masked weirdly
      last4Digits = randomInt(0, 10000).toString().padStart(4, "0");
    }

    const binStr = transaction?.paymentDetails?.bin;
    const bin = binStr ? Number.parseInt(binStr, 10) : NaN;
    if (!Number.isFinite(bin)) {
      console.log("Pass. BIN is null/invalid.", binStr);
      continue;
    }

    const company = transaction?.paymentDetails?.company;
    if (!company) {
      console.log("Pass. Card company is null.");
      continue;
    }

    console.log(`Checking if ${last4Digits} + BIN ${bin} exists...`);

    // Find existing verification record
    let verificationRecord = await db.creditCardVerification.findFirst({
      where: {
        credit_card_number: last4Digits,
        credit_card_bin: bin,
        customer_id: customerId,
        shop,
      },
      include: { orders: true },
    });

    if (verificationRecord) {
      console.log("Found verification record status:", verificationRecord.status);

      if (verificationRecord.status === CreditCardVerificationStatus.APPROVED) {
        console.log("Exit. Card already approved.");
        return { skipped: true, reason: "already_approved" };
      }

      const foundOrder = verificationRecord.orders.find(
        (o) => o.id === admin_graphql_api_id
      );
      if (foundOrder) {
        console.log("Exit. Order already recorded (webhook resend).");
        return { skipped: true, reason: "already_recorded" };
      }

      if (verificationRecord.status === CreditCardVerificationStatus.DENIED) {
        console.log("Denied card. Resetting status to pending submission.");
        await db.creditCardVerification.update({
          where: {
            shop_creditCardNumber_customerId_creditCardBIN: {
              shop,
              credit_card_number: last4Digits,
              customer_id: customerId,
              credit_card_bin: bin,
            },
          },
          data: {
            status: CreditCardVerificationStatus.PENDING_SUBMISSION,
            attemptCount: 0,
            submissionTime: null,
            createdAt: new Date(),
          },
        });

        verificationRecord = await db.creditCardVerification.findUnique({
          where: {
            shop_credit_card_number_customer_id_credit_card_bin: {
              shop,
              credit_card_number: last4Digits,
              customer_id: customerId,
              credit_card_bin: bin,
            },
          },
          include: { orders: true },
        });
      }
    } else {
      console.log("Creating verification record...");

      const token = generateSecureToken(32);

      // Lookup BIN info (optional)
      let binLookup = null;
      const existingBin = await db.creditCardBinLookup.findFirst({ where: { bin } });
      if (existingBin) {
        binLookup = existingBin;
      } else {
        try {
          binLookup = await fetchBinInfo(bin);
        } catch (e) {
          console.log("BIN fetch failed; continuing without binLookup.", e);
        }
      }

      const data = {
        customer_id: customerId,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_locale: customer_locale ?? null,
        shipping_country: shipping_address?.country_code ?? null,
        shop,
        credit_card_number: last4Digits,
        credit_card_bin: bin,
        credit_card_company: company,
        status: CreditCardVerificationStatus.PENDING_SUBMISSION,
        token,
        risk_level:
          order?.risk?.assessments?.length > 0 &&
          isRiskLevel(order.risk.assessments[0]?.riskLevel)
            ? order.risk.assessments[0].riskLevel
            : null,
        risk_recommendation:
          order?.risk?.recommendation && isRiskRecommendation(order.risk.recommendation)
            ? order.risk.recommendation
            : null,
        ...(binLookup && {
          bin_lookup: {
            connectOrCreate: {
              where: { bin },
              create: {
                bin: binLookup.bin,
                bank: binLookup.bank,
                country: binLookup.country ?? null,
                country_code: binLookup.country_code ?? null,
                type: binLookup.type ?? null,
                scheme: binLookup.scheme ?? null,
                url: binLookup.url ?? null,
              },
            },
          },
        }),
      };

      try {
        verificationRecord = await db.creditCardVerification.create({
          data,
          include: { orders: true },
        });
      } catch (err) {
        console.error("Failed to create verification record.", err);
        // This is probably transient DB issue -> throw so BullMQ retries
        throw err;
      }
    }

    if (!verificationRecord) continue;

    didAnything = true;

    // Send email if not approved
    if (verificationRecord.status !== CreditCardVerificationStatus.APPROVED) {
      console.log("Send verification link to customer");

      const locale =
        (verificationRecord.customer_locale?.startsWith("zh") ?? false) ||
        verificationRecord.shipping_country === "CN"
          ? "zh-CN"
          : "en";

      const to = customerEmail;
      if (!to) {
        console.log("No customer email; skip sending.");
      } else {
        const appDomain = setting.app_domain ?? "";
        const verificationLink = `https://${appDomain}/photo-proof/verify/${verificationRecord.id}?token=${verificationRecord.token}`;

        const omnisend = new OmnisendService();
        const eventName = "Credit Card Verification Request";

        try {
          await omnisend.sendEvent({
            eventName,
            contact: { email: to },
            properties: {
              customerLocale: locale,
              last4Digits,
              orderNumbers: name,
              primaryActionLink: verificationLink,
            },
          });
        } catch (err) {
          console.log("Send email error", err);
          // Email failures are often transient -> throw to retry
          throw err;
        }
      }
    }
    
    if (!setting.auto_change_order_status) {
      console.log("Return since auto change order status disabled");
      return { handled: true, reason: "auto_change_disabled" };
    }

    console.log("Ready to change fulfillment order status.");
    const fulfillmentOrders = order.fulfillmentOrders?.nodes ?? [];

    console.log('cc.js::fulfillmentOrders', fulfillmentOrders);
    // for (const node of fulfillmentOrders) {
      // const fulfillmentOrderId = node.id;

      try {
        const allFulfillmentOrderIds = fulfillmentOrders.map(f=>f.id);
        const uniqueFulfillmentOrderIds = [...new Set(allFulfillmentOrderIds)];


        // We build the mutation string with unique variables for each hold handle
        const holdMutation = `#graphql
          mutation bulkHoldAll($reason: FulfillmentHoldReason!, $notes: String!) {
            ${uniqueFulfillmentOrderIds.map((id, index) => `
              hold${index}: fulfillmentOrderHold(id: "${id}", fulfillmentHold: { reason: $reason, reasonNotes: $notes, handle: "ccv" }) {
                fulfillmentHold { id }
                userErrors { field message }
              }
            `).join('\n')}
          }
        `;

        const holdResponse = await admin.graphql(holdMutation, {
          variables: { reason: "OTHER", notes: "Awaiting credit card verification." }
        });

        const holdJson = await holdResponse.json();
        const results = Object.entries(holdJson.data || {});

        const successfulHoldIds = [];
        const holdErrors = [];

        // 1. Sort successes from failures
        results.forEach(([key, result]) => {
          if (result.fulfillmentHold?.id) {
            successfulHoldIds.push(result.fulfillmentHold.id);
          }
          if (result.userErrors?.length > 0) {
            holdErrors.push(...result.userErrors);
          }
        });

        // 2. Robust Error Handling (Rollback Pattern)
        if (holdErrors.length > 0) {
          console.error(`❌ Hold Partial Failure. Errors: ${JSON.stringify(holdErrors)}`);
          if (successfulHoldIds.length > 0) {
            console.log(`🔄 Rolling back ${successfulHoldIds.length} successful holds to maintain state consistency...`);

            const rollbackMutation = `#graphql
              mutation rollbackHolds {
                ${successfulHoldIds.map((holdId, idx) => `
                  release${idx}: fulfillmentOrderReleaseHold(fulfillmentHoldId: "${holdId}") {
                      userErrors { message }
                  }
                `).join('\n')}
              }
          `;
            await admin.graphql(rollbackMutation);
          }
          throw new Error(`Hold Phase Failed. Order state restored to Open. Error Logs: ${JSON.stringify(holdErrors, null, 2)}`);
        }

        // 3. Commit to Database
        // If we reached here, ALL holds succeeded.
        const holdRecords = successfulHoldIds.map((holdId, index) => ({
          fulfillment_hold_id: holdId,
          fulfillment_order_id: uniqueFulfillmentOrderIds[index],
          credit_card_verification_id: verificationRecord.id,
          order_id: orderId.toString()
        }));

        const { error: holdRecordsError } = await supabase
            .from('credit_card_verification_fulfillment_holds')
            .insert(holdRecords);
        
        if (holdRecordsError) {
            throw new Error("Database failed to save hold records. Manual intervention required.");
        }

        console.log("✅ All parcels held and recorded successfully.");
      } catch (e) {
        console.log("fulfillmentOrderHold failed", e);
        throw e;
      }
      
      try {
        console.log('orderId.toString()', orderId.toString());
        const res = await db.order.update({
          where: {order_id: orderId.toString()},
          data: {
            credit_card_verification: { connect: { id: verificationRecord.id } },
          },
        });
        console.log('db.order.update::Res', res);
      } catch (e) {
        console.log("Order row create skipped (maybe duplicate):", (e)?.code ?? e);
      }
    // }
  }

  return { success: didAnything };
}
