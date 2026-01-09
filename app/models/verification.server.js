// app/models/verification.server.js
import sharp from "sharp";
import crypto from "crypto";
import db from "../db.server.js";
import { getS3ImageSignedURL, uploadImageToS3 } from "../s3.server.js";
import {
  CreditCardOrderStatus,
  CreditCardVerificationStatus,
  CreditCardRiskLevel,
  CreditCardRiskRecommendation,
} from "@prisma/client";
import { getSetting } from "./setting.server.js";
// import i18nInstance from "../i18n.server.js";
import { fetchBinInfo } from "../models/binLookup.server.js";
import { OmnisendService } from "../omnisend.server.js";
import "dotenv/config"; 
import { supabase } from "../supabase.server.js";

export const MAXIMUM_FAIL_ATTEMPT = 6;
export const MAXIMUM_IMAGE = 3;

/**
 * @typedef {Object} ShopifyGraphqlClient
 * @property {(query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json: () => Promise<any> }>} graphql
 */

/**
 * @typedef {Object|null} NotifyCustomerPayload
 * @property {string=} message
 */

/**
 * @param {number} lengthBytes
 * @returns {string}
 */
export function generateSecureToken(lengthBytes) {
  return crypto.randomBytes(lengthBytes).toString("hex");
}

/**
 * Runtime enum guard for Prisma string enums.
 * @param {Record<string, string>} enumObj
 * @param {unknown} v
 * @returns {boolean}
 */
function isEnumValue(enumObj, v) {
  return typeof v === "string" && Object.values(enumObj).includes(v);
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function coerceVerificationStatus(v) {
  return isEnumValue(CreditCardVerificationStatus, v) ? v : null;
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function coerceRiskLevel(v) {
  return isEnumValue(CreditCardRiskLevel, v) ? v : null;
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function coerceRiskRecommendation(v) {
  return isEnumValue(CreditCardRiskRecommendation, v) ? v : null;
}

/**
 * @param {FormData} form
 * @param {string} key
 * @returns {string}
 */
function getStringField(form, key) {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveInt(v, fallback) {
  const n =
    typeof v === "string"
      ? Number.parseInt(v, 10)
      : typeof v === "number"
        ? v
        : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {FormData} formData
 * @param {string=} key
 * @returns {Array<Exclude<FormDataEntryValue, string>>}
 */
function getUploadedFiles(formData, key = "files") {
  return formData.getAll(key).filter((v) => typeof v !== "string");
}

// ---------------------------
// Public listing helpers
// ---------------------------

/**
 * @param {string} shop
 * @param {any} _graphql
 * @param {number|string=} page
 * @param {number=} pageSize
 * @param {string|null=} query
 * @param {string|null=} status
 * @returns {Promise<{ verifications: any[]; totalCount: number }>}
 */
export async function getVerifications(
  shop,
  _graphql,
  page = 1,
  pageSize = 10,
  query,
  status
) {
  const pageNum = parsePositiveInt(page, 1);
  const skip = (pageNum - 1) * pageSize;

  const statusFilter = coerceVerificationStatus(status);

  const where = {
    shop,
    ...(query
      ? {
          OR: [
            { customer_email: { contains: query } },
            { credit_card_number: { contains: query } },
            { orders: { some: { order_name: { contains: query } } } },
          ],
        }
      : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
  };

  const [verifications, totalCount] = await db.$transaction([
    db.creditCardVerification.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { created_at: "desc" },
      include: { orders: true, images: true, bin_lookup: true },
    }),
    db.creditCardVerification.count({ where }),
  ]);

  if (verifications.length === 0) {
    return { verifications: [], totalCount };
  }
  // console.log('getVerifications::verifications', verifications);
  const formatted = await Promise.all(
    verifications.map((v) => supplementVerification(v))
  );

  return { verifications: formatted, totalCount };
}

/**
 * @param {any} verification
 * @returns {Promise<any>}
 */
async function supplementVerification(verification) {
  const urls = [];

  for (const image of verification.images) {
    const signedUrl = (await getS3ImageSignedURL(image.s3_file_key)) ?? null;
    if (signedUrl) urls.push(signedUrl);
  }

  return { ...verification, images: urls };
}

// ---------------------------
// Customer email resend
// ---------------------------

/**
 * @param {FormData} formData
 * @param {string} shop
 * @param {ShopifyGraphqlClient|null=} admin
 */
export async function resendEmail(formData, shop, admin = null) {
  const id = getStringField(formData, "id");
  const token = getStringField(formData, "token");

  const where = admin ? { id } : { id, token };

  const record = await db.creditCardVerification.findFirst({
    where,
    include: { images: true, orders: true },
  });

  if (!record) {
    return {
      isSubmitted: true,
      success: false,
      message: `未找到记录。 Verification request not found.`,
    };
  }

  if (record.status !== CreditCardVerificationStatus.PENDING_SUBMISSION) {
    return {
      isSubmitted: true,
      success: false,
      message: `用戶已經上傳了。 User has submitted photos.`,
    };
  }

  const setting = await getSetting(shop);

  const locale =
    (record.customer_locale?.startsWith("zh") ?? false) ||
    record.shipping_country === "CN"
      ? "zh-CN"
      : "en";

  const to = record.customer_email;

  const verificationLink = `https://${setting.app_domain}/photo-proof/verify/${record.id}?token=${record.token}`;

  const omnisend = new OmnisendService();
  const eventName = "Credit Card Verification Request";
  try {
    await omnisend.sendEvent({
      eventName,
      contact: { email: to },
      properties: {
        orderNumbers: record.orders
          .filter((o) => !o.cancelled_at)
          .map((o) => o.order_name)
          .join(","),
        customerLocale: locale,
        last4Digits: record.credit_card_number,
        primaryActionLink: verificationLink,
      },
    });
  } catch (err) {
    console.log("Send email error", err);
  }

  return {
    isSubmitted: true,
    success: true,
    message: `Success. Email resent to ${record.customer_email} for credit card ${record.credit_card_number}.`,
  };
}

// ---------------------------
// Customer submission (upload images)
// ---------------------------

/**
 * @param {FormData} formData
 * @param {ShopifyGraphqlClient|null=} admin
 */
export async function submitVerification(formData, admin = null) {
  // const { default: i18nInstance } = await import("../lib/i18n.server");
  const id = getStringField(formData, "id");
  const token = getStringField(formData, "token");
  const files = getUploadedFiles(formData, "files");

  console.log("submitVerification::files", files);
  console.log("submitVerification::admin", admin);
  console.log("submitVerification::id", id);
  console.log("submitVerification::token", token);

  const record = await db.creditCardVerification.findFirst({
    where: admin ? { id } : { id, token },
    include: { images: true },
  });

  if (!record) {
    return {
      isSubmitted: true,
      success: false,
      message: `未找到记录。 Verification request not found.`,
    };
  }

  const locale =
    record.customer_locale?.startsWith("zh") || record.shipping_country === "CN"
      ? "zh"
      : "en";

  if (!admin) {
    if (record.status === CreditCardVerificationStatus.PENDING_VERIFICATION) {
      return {
        isSubmitted: true,
        success: false,
        // message: i18nInstance.t("verification.pending", { ns: "common", lng: locale }),
        message: ''
      };
    }

    if (record.attempt_count >= MAXIMUM_FAIL_ATTEMPT) {
      return {
        isSubmitted: true,
        success: false,
        // message: i18nInstance.t("errors.maxAttemptCountReached", {
        //   ns: "common",
        //   lng: locale,
        // }),
        message: ''
      };
    }

    if (files.length > MAXIMUM_IMAGE) {
      return {
        isSubmitted: true,
        success: false,
        resubmit: true,
        // message: i18nInstance.t("errors.exceedMaximumFile", {
        //   ns: "common",
        //   lng: locale,
        //   limit: MAXIMUM_IMAGE,
        // }),
        message: ''
      };
    }

    if (files.length === 0) {
      return {
        isSubmitted: true,
        success: false,
        resubmit: true,
        // message: i18nInstance.t("errors.minImageUpload", {
        //   ns: "common",
        //   lng: locale,
        // }),
        message: ''
      };
    }
  }

  /** @type {Buffer[]} */
  const bufferFiles = [];

  try {
    for (const file of files) {
      const incoming = Buffer.from(await file.arrayBuffer());
      const buffer = await sharp(incoming).jpeg({ quality: 75 }).toBuffer();
      bufferFiles.push(buffer);
    }
  } catch {
    await db.creditCardVerification.update({
      where: { id: record.id },
      data: {
        attempt_count: { increment: 1 },
        ...(record.attempt_count + 1 >= MAXIMUM_FAIL_ATTEMPT
          ? { status: CreditCardVerificationStatus.ATTEMPTS_EXCEEDED }
          : {}),
      },
    });

    return {
      isSubmitted: true,
      success: false,
      resubmit: true,
      // message: i18nInstance.t("errors.invalidImageFile", {
      //   ns: "common",
      //   lng: locale,
      // }),
      message: ''
    };
  }

  try {
    const connectOrCreate = [];

    console.log("bufferFiles", bufferFiles);
    for (const [idx, buffer] of bufferFiles.entries()) {
      const s3FileKey = `${record.shop}/${record.id}-${idx + 1}.jpg`;
      await uploadImageToS3("credit-card-verification", s3FileKey, buffer);

      connectOrCreate.push({
        where: { s3_file_key: s3FileKey },
        create: { s3_file_key: s3FileKey },
      });
    }

    // delete extra old images if user uploaded fewer this time
    const imagesToDelete = [];
    if (
      !admin &&
      connectOrCreate.length > 0 &&
      record.images.length > connectOrCreate.length
    ) {
      for (let i = connectOrCreate.length; i < record.images.length; i++) {
        imagesToDelete.push(record.images[i].id);
      }
    }

    await db.creditCardVerification.update({
      where: { id: record.id },
      data: {
        images: { connectOrCreate },
        submission_time: new Date(),
        status: CreditCardVerificationStatus.PENDING_VERIFICATION,
        attempt_count: 0,
      },
    });

    if (imagesToDelete.length > 0) {
      await db.creditCardVerificationImage.deleteMany({
        where: { id: { in: imagesToDelete } },
      });
    }

    return {
      isSubmitted: true,
      success: true,
      // message: i18nInstance.t("verification.pending", { ns: "common", lng: locale }),
      message: ''
    };
  } catch (err) {
    console.log(err);

    await db.creditCardVerification.update({
      where: { id: record.id },
      data: {
        attempt_count: { increment: 1 },
        ...(record.attempt_count + 1 >= MAXIMUM_FAIL_ATTEMPT
          ? { status: CreditCardVerificationStatus.ATTEMPTS_EXCEEDED }
          : {}),
      },
    });

    return {
      isSubmitted: true,
      success: false,
      resubmit: true,
      // message: i18nInstance.t("errors.unexpectedError", {
      //   ns: "common",
      //   lng: locale,
      // }),
      message: ''
    };
  }
}

// ---------------------------
// Shopify fulfillment/order actions
// ---------------------------

/**
 * @param {string} fulfillmentOrderId
 * @param {ShopifyGraphqlClient} admin
 * @param {string=} reasonNotes
 */
export async function fulfillmentOrderHold(
  fulfillmentOrderId,
  admin,
  reasonNotes = "Awaiting credit card verification"
) {
  return admin.graphql(
    `#graphql
    mutation fulfillmentOrderHold($fulfillmentHold: FulfillmentOrderHoldInput!, $id: ID!) {
      fulfillmentOrderHold(fulfillmentHold: $fulfillmentHold, id: $id) {
        fulfillmentHold { id }
        fulfillmentOrder { orderId }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        fulfillmentHold: { reason: "OTHER", reasonNotes, handle: 'ccv' },
        id: fulfillmentOrderId,
      },
    }
  );
}

/**
 * @param {string} orderId
 * @param {ShopifyGraphqlClient} admin
 */
export async function orderCancel(orderId, admin) {
  return admin.graphql(
    `#graphql
    mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
      orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock) {
        orderCancelUserErrors { code field message }
      }
    }`,
    {
      variables: {
        notifyCustomer: true,
        orderId,
        reason: "OTHER",
        refund: true,
        restock: true,
        staffNote: "Credit card verification denied.",
      },
    }
  );
}

// releases ONLY the specified hold(s) on this fulfillment order

/**
 * @param {string} fulfillmentOrderId
 * @param {string[]|string} holdIds
 * @param {ShopifyGraphqlClient} admin
 * @param {string=} externalId
 */
export async function fulfillmentOrderRelease(
  fulfillmentOrderId,
  holdIds,
  admin,
  externalId
) {
  const ids = Array.isArray(holdIds)
    ? holdIds.filter(Boolean)
    : [holdIds].filter(Boolean);

  if (ids.length === 0) {
    throw new Error(
      "fulfillmentOrderRelease requires at least 1 holdId to avoid releasing other apps' holds."
    );
  }

  return admin.graphql(
    `#graphql
    mutation fulfillmentOrderReleaseHold($id: ID!, $holdIds: [ID!], $externalId: String) {
      fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds, externalId: $externalId) {
        fulfillmentOrder { id status requestStatus }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        id: fulfillmentOrderId,
        holdIds: ids,
        externalId: externalId ?? null,
      },
    }
  );
}

/**
 * @param {unknown} data
 * @param {ShopifyGraphqlClient} admin
 */
export async function capturePayment(data, admin) {
  return admin.graphql(
    `#graphql
    mutation orderCapture($input: OrderCaptureInput!) {
      orderCapture(input: $input) {
        transaction {
          errorCode
          kind
          id
          status
          totalUnsettledSet { presentmentMoney { amount currencyCode } }
        }
        userErrors { field message }
      }
    }`,
    { variables: { input: data } }
  );
}

// ---------------------------
// Admin validate/update verification + order hold/release/cancel
// ---------------------------

/**
 * @param {FormData} formData
 * @param {string} shop
 * @param {ShopifyGraphqlClient} admin
 */
export async function validateVerification(formData, shop, admin) {
  // Parse minimal required fields safely
  const id = getStringField(formData, "id");
  const status = coerceVerificationStatus(getStringField(formData, "status"));

  const internalNotes = getStringField(formData, "internalNotes");
  const followUpRaw = getStringField(formData, "followUp");
  const followUp =
    followUpRaw === ""
      ? undefined
      : followUpRaw === "true" || followUpRaw === "1";

  const riskLevel = coerceRiskLevel(getStringField(formData, "riskLevel")) ?? undefined;
  const riskRecommendation =
    coerceRiskRecommendation(getStringField(formData, "riskRecommendation")) ?? undefined;

  /** @type {NotifyCustomerPayload} */
  let notifyCustomer = null;
  const notifyCustomerStr = getStringField(formData, "notifyCustomer");
  if (notifyCustomerStr.trim()) {
    try {
      notifyCustomer = JSON.parse(notifyCustomerStr);
    } catch (e) {
      console.error("Parsing error for notifyCustomer:", e);
      notifyCustomer = null;
    }
  }

  const errors = validateRequests({ id, shop, status });
  if (errors) return { success: false, message: errors };

  const setting = await getSetting(shop);

  const verificationRecord = await db.creditCardVerification.findFirst({
    where: { id },
    include: { orders: true, fulfillment_holds: true },
  });

  if (!verificationRecord || !status) {
    return {
      success: false,
      message:
        "Status updated failed! Please try again later or contact developer.",
    };
  }

  try {
    // ✅ Safe allowlist update (no spreading raw form fields)
    const updateData = {
      status,
      ...(internalNotes ? { internal_notes: internalNotes } : {}),
      ...(typeof followUp === "boolean" ? { follow_up: followUp } : {}),
      ...(riskLevel ? { risk_level: riskLevel } : {}),
      ...(riskRecommendation ? { risk_recommendation: riskRecommendation } : {}),
      ...(status === CreditCardVerificationStatus.PENDING_SUBMISSION
        ? { created_at: new Date() }
        : {}),
    };

    await db.creditCardVerification.update({
      where: { id },
      data: updateData,
    });

    // Email settings
    const locale =
      (verificationRecord.customer_locale?.startsWith("zh") ?? false) ||
      verificationRecord.shipping_country === "CN"
        ? "zh-CN"
        : "en";
        
    const to = verificationRecord.customer_email;
    const verificationLink = `https://${setting.app_domain}/photo-proof/verify/${verificationRecord.id}?token=${verificationRecord.token}`;

    if (status === CreditCardVerificationStatus.PENDING_SUBMISSION) {
      const omnisend = new OmnisendService();
      const eventName = "Credit Card Verification Resubmit";

      try {
        await omnisend.sendEvent({
          eventName,
          contact: { email: to },
          properties: {
            orderNumbers: verificationRecord.orders
              .filter((order) => !order.cancelled_at)
              .map((order) => order.order_name)
              .join(","),
            customerLocale: locale,
            last4Digits: verificationRecord.credit_card_number,
            primaryActionLink: verificationLink,
            notifyCustomerMessage: notifyCustomer?.message,
          },
        });
      } catch (err) {
        console.log("Send email error", err);
      }
    }

    if (!setting.auto_change_order_status) {
      return {
        success: true,
        message:
          "Status updated successfully! Warning: Auto Hold/Release Order Fulifillment disabled.",
      };
    }
    console.log('validateVerification::status', status);
    switch (status) {
      case CreditCardVerificationStatus.APPROVED: {
        const activeOrderIds = new Set(
          verificationRecord.orders
            .filter((o) => !o.cancelled_at)
            .map((o) => o.order_id)
        );

        const holdsByFoId = new Map();

        for (const fh of verificationRecord.fulfillment_holds) {
          if (!activeOrderIds.has(fh.order_id)) continue;
          if (fh.released) continue;
          if (!fh.fulfillment_order_id || !fh.fulfillment_hold_id) continue;

          if (!holdsByFoId.has(fh.fulfillment_order_id)) {
            holdsByFoId.set(fh.fulfillment_order_id, new Set());
          }
          holdsByFoId.get(fh.fulfillment_order_id).add(fh.fulfillment_hold_id);
        }

        if (holdsByFoId.size === 0) {
          console.log("No fulfillment holds to release.");
          return;
        }

        const ops = Array.from(holdsByFoId.entries()).map(([foId, holdIdSet], idx) => {
          return {
            alias: `release${idx}`,
            foId,
            holdIds: Array.from(holdIdSet),
          };
        });

        const mutationBody = ops
          .map(
            ({ alias, foId, holdIds }) => `
              ${alias}: fulfillmentOrderReleaseHold(
                id: "${foId}",
                holdIds: ${JSON.stringify(holdIds)},
              ) {
                fulfillmentOrder { id status requestStatus }
                userErrors { field message code }
              }
            `
          )
          .join("\n");

        const bulkReleaseMutation = `#graphql
          mutation bulkReleaseAll {
            ${mutationBody}
          }
        `;

        const res = await admin.graphql(bulkReleaseMutation);
        const json = await res.json();

        // 4) figure out which aliases succeeded (no userErrors) => those holdIds are “released”
        const successfulHoldIds = [];

        for (const op of ops) {
          const result = json?.data?.[op.alias];
          const errs = result?.userErrors || [];
          if (errs.length === 0) {
            successfulHoldIds.push(...op.holdIds);
          } else {
            console.error(`${op.alias} failed:`, errs);
          }
        }

        if (successfulHoldIds.length === 0) {
          console.warn("No holds were released successfully; not updating DB.");
          return;
        }

        await db.creditCardVerificationRequestFulfillmentHold.updateMany({
          where: {
            fulfillment_hold_id: { in: successfulHoldIds },
            credit_card_verification_id: verificationRecord.id,
          },
          data: { released: true },
        });

        const omnisend = new OmnisendService();
        const eventName = "Credit Card Verification Approve";

        try {
          await omnisend.sendEvent({
            eventName,
            contact: { email: to },
            properties: {
              orderNumbers: verificationRecord.orders
                .filter((o) => !o.cancelled_at)
                .map((o) => o.order_name)
                .join(","),
              customerLocale: locale,
              last4Digits: verificationRecord.creditCardNumber,
            },
          });
        } catch (err) {
          console.log("Send email error", err);
        }
        break;
      }
      // NOTE: Intentionally no break here (matches original TS; will fall through).
      case CreditCardVerificationStatus.DENIED: {
        if (notifyCustomer) {
          const omnisend = new OmnisendService();
          const eventName = "Credit Card Verification Cancel";
          
          try {
            await omnisend.sendEvent({
              eventName,
              contact: { email: to },
              properties: {
                orderNumbers: verificationRecord.orders
                  .filter((o) => !o.cancelled_at)
                  .map((o) => o.order_name)
                  .join(","),
                customerLocale: locale,
                last4Digits: verificationRecord.credit_card_number,
                notifyCustomerMessage: notifyCustomer?.message,
              },
            });
          } catch (err) {
            console.log("Send email error", err);
          }
        }

        for (const order of verificationRecord.orders) {
          if (order?.cancelled_at) continue;
          const orderGid  = `gid://shopify/Order/${order.order_id}`
          const cancelResponse = await orderCancel(orderGid, admin);
          const cancelJson = await cancelResponse.json();
          if(cancelJson.data.orderCancelUserErrors && cancelJson.data.orderCancelUserErrors.length){
            console.error(cancelJson)
          }
          console.log("orderCancel:", cancelJson?.data, cancelJson?.extensions);

          await db.order.update({
            where: { order_id: order.order_id },
            data: { cancelled_at: new Date() },
          });
        }
        break;
      }

      case CreditCardVerificationStatus.PENDING_SUBMISSION:
      case CreditCardVerificationStatus.PENDING_VERIFICATION: {
        try{
          const allFulfillmentOrderIds = verificationRecord.fulfillment_holds.filter(fh=>fh.released).map(fh=>fh.fulfillment_order_id);
          console.log('allFulfillmentOrderIds12312', allFulfillmentOrderIds);
          if(allFulfillmentOrderIds?.length === 0) break;
          const uniqueFulfillmentOrderIds = [...new Set(allFulfillmentOrderIds)];
          
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
          
          results.forEach(([key, result]) => {
            if (result.fulfillmentHold?.id) {
              successfulHoldIds.push(result.fulfillmentHold.id);
            }
            if (result.userErrors?.length > 0) {
              holdErrors.push(...result.userErrors);
            }
          });
          
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
          const holdRecords = successfulHoldIds.map((holdId, index) => ({
            fulfillment_hold_id: holdId,
            fulfillment_order_id: uniqueFulfillmentOrderIds[index],
            credit_card_verification_id: verificationRecord.id,
            released: false
          }));

          const { error: holdRecordsError } = await supabase
            .from("credit_card_verification_fulfillment_holds")
            .upsert(holdRecords);

          if (holdRecordsError) {
            throw new Error("Database failed to save hold records. Manual intervention required.");
          }
        }catch(e){
          console.log("fulfillmentOrderHold failed", e);
          throw e;
        }
        break;
      }
    }

    return { success: true, message: "Status updated successfully!" };
  } catch (err) {
    console.log(err);
    return {
      success: false,
      message:
        "Status updated failed! Please try again later or contact developer.",
    };
  }
}

// ---------------------------
// Admin helper to create verification by order id
// ---------------------------

/**
 * @param {string|number} orderId
 * @param {string} shop
 * @param {ShopifyGraphqlClient} admin
 */
export async function requestVerification(orderId, shop, admin) {
  const numericOrderId = parsePositiveInt(orderId, 0);
  if (!numericOrderId) {
    return { success: false, message: "Order id must be provided" };
  }

  const admin_graphql_api_id = `gid://shopify/Order/${numericOrderId}`;

  const response = await admin.graphql(
    `#graphql
    query order($id: ID!) {
      order(id: $id) {
        id
        name
        billingAddress { countryCodeV2 }
        shippingAddress { countryCodeV2 }
        paymentGatewayNames
        customerLocale
        displayFinancialStatus
        customer { id displayName email }
        transactions {
          accountNumber
          id
          kind
          status
          paymentDetails {
            ... on CardPaymentDetails { bin company }
          }
        }
        fulfillmentOrders(first: 10) {
          nodes { id status orderId }
        }
        createdAt
      }
    }`,
    { variables: { id: admin_graphql_api_id } }
  );

  const parsedResponse = await response.json();
  const order = parsedResponse?.data?.order;

  if (!order) {
    return {
      success: false,
      message: "Order not found. Please input a correct order id.",
      order,
    };
  }

  const {
    id,
    name,
    customer,
    billingAddress,
    shippingAddress,
    paymentGatewayNames,
    customerLocale,
    displayFinancialStatus,
    createdAt
  } = order;

  if (displayFinancialStatus !== "AUTHORIZED") {
    return {
      success: false,
      message: "Order financial status is not marked as authorized",
    };
  }

  if (
    !Array.isArray(paymentGatewayNames) ||
    ((!paymentGatewayNames.includes("sage") &&
      !paymentGatewayNames.includes("authorize_net") &&
      !paymentGatewayNames.includes("authorize.net") &&
      !paymentGatewayNames.includes("Moneris")) &&
      !paymentGatewayNames.includes("bogus"))
  ) {
    return {
      success: false,
      message: "Order is not processed with a credit card payment method",
    };
  }

  const setting = await getSetting(shop);
  if (!setting.enabled) {
    return { success: false, message: "App disabled in setting." };
  }

  const txs = Array.isArray(order.transactions) ? order.transactions : [];

  for (const transaction of txs) {
    if (transaction?.status !== "SUCCESS") continue;
    if (transaction?.kind !== "AUTHORIZATION") continue;
    if (!transaction?.accountNumber) continue;
    if (!transaction?.paymentDetails?.bin) continue;

    const last4Digits = String(transaction.accountNumber).replace(
      "•••• •••• •••• ",
      ""
    );
    const bin = Number.parseInt(String(transaction.paymentDetails.bin), 10);
    if (!Number.isFinite(bin)) continue;

    let verificationRecord = await db.creditCardVerification.findFirst({
      where: {
        shop,
        customer_id: customer.id,
        credit_card_number: last4Digits,
        credit_card_bin: bin,
      },
      include: { orders: true },
    });

    if (verificationRecord) {
      if (verificationRecord.status === CreditCardVerificationStatus.APPROVED) {
        return {
          success: false,
          message: `Verification already requested and its credit card (${last4Digits}) already approved.`,
        };
      }
      
      const foundOrder = verificationRecord.orders.find(
        (o) => o.order_id === numericOrderId
      );

      if (foundOrder) {
        return { success: false, message: `Verification Already Requested.` };
      }

      if (verificationRecord.status === CreditCardVerificationStatus.DENIED) {
        await db.creditCardVerification.update({
          where: {
            shop_credit_card_number_customer_id_credit_card_bin: {
              shop,
              credit_card_number: last4Digits,
              customer_id: customer.id,
              credit_card_bin: bin,
            },
          },
          data: {
            status: CreditCardVerificationStatus.PENDING_SUBMISSION,
            attempt_count: 0,
            submission_time: null,
            created_at: new Date(),
          },
        });

        verificationRecord = await db.creditCardVerification.findFirst({
          where: {
            shop,
            customer_id: customer.id,
            credit_card_number: last4Digits,
            credit_card_bin: bin,
          },
          include: { orders: true },
        });
      }
    } else {
      const token = generateSecureToken(32);

      let binLookup = null;
      if (bin) {
        binLookup = await db.creditCardBinLookup.findFirst({ where: { bin } });
        if (!binLookup) {
          try {
            binLookup = await fetchBinInfo(bin);
          } catch (e) {
            console.log("Bin lookup fetch failed:", e);
            binLookup = null;
          }
        }
      }

      const data = {
        customer_id: customer.id,
        customer_name: customer.displayName ?? "",
        customer_email: customer.email ?? "",
        customer_locale: customerLocale ?? null,
        shipping_country: shippingAddress?.countryCodeV2 ?? null,
        shop,
        credit_card_number: last4Digits,
        credit_card_bin: bin,
        credit_card_company: transaction?.paymentDetails?.company ?? "",
        status: CreditCardVerificationStatus.PENDING_SUBMISSION,
        token,
        ...(binLookup
          ? {
              bin_lookup: {
                connectOrCreate: {
                  where: { bin },
                  create: {
                    bin: binLookup.bin ?? bin,
                    bank: binLookup.bank ?? "",
                    country: binLookup.country ?? null,
                    country_code: binLookup.countryCode ?? null,
                    type: binLookup.type ?? null,
                    scheme: binLookup.scheme ?? null,
                    url: binLookup.url ?? null,
                  },
                },
              },
            }
          : {}),
      };

      verificationRecord = await db.creditCardVerification.create({
        data,
        include: { orders: true },
      });
    }

    if (!verificationRecord) continue;

    if (verificationRecord.status !== CreditCardVerificationStatus.APPROVED) {
      const locale =
        (verificationRecord.customer_locale?.startsWith("zh") ?? false) ||
        verificationRecord.shipping_country === "CN"
          ? "zh-CN"
          : "en";

      const to = customer.email ?? verificationRecord.customer_email;
      const verificationLink = `https://${setting.app_domain}/photo-proof/verify/${verificationRecord.id}?token=${verificationRecord.token}`;

      const omnisend = new OmnisendService();
      const eventName = "Credit Card Verification Request";
      try {
        await omnisend.sendEvent({
          eventName,
          contact: { email: to },
          properties: {
            orderNumbers: name,
            customerLocale: locale,
            last4Digits: last4Digits,
            primaryActionLink: verificationLink,
          },
        });
      } catch (err) {
        console.log("Send email error", err);
      }
    }

    if (!setting.auto_change_order_status) continue;

    console.log('test::order.upsert', {
      order_id: orderId.toString(),
      order_name: name,
      shop_domain: shop,
      created_at: new Date(createdAt),
      updated_at: new Date(),
      credit_card_verification: verificationRecord.id }
    )
    try {
      const res = await db.order.upsert({
        where: { order_id: orderId.toString() },
        update: {
          order_name: name,
          shop: {},
          updated_at: new Date(),
          credit_card_verification: { connect: { id: verificationRecord.id } },
        },
        create: {
          order_id: orderId.toString(),
          order_name: name,
          shop: {
            connectOrCreate: {
              where: { shop_domain: shop },
              create: { shop_domain: shop },
            },
          },         
          created_at: new Date(createdAt),
          updated_at: new Date(),
          credit_card_verification: { connect: { id: verificationRecord.id } },
        },
      });
      console.log('db.order.update::Res', res);
    } catch (e) {
      console.log("Order row create skipped (maybe duplicate):", (e)?.code ?? e);
    }

    const fulfillmentOrders = order.fulfillmentOrders?.nodes ?? [];
    
    try {
      const allFulfillmentOrderIds = fulfillmentOrders.map(f=>f.id);
      const uniqueFulfillmentOrderIds = [...new Set(allFulfillmentOrderIds)];

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
    break;
  }

  return { success: true, message: "Success! Verification request created." };
}

// ---------------------------
// Simple validation
// ---------------------------

/**
 * @param {{ status: string|null, id: string, shop: string }} data
 * @returns {string|false}
 */
export function validateRequests(data) {
  if (!data.status) return "Status is required";
  if (!data.id) return "Id is required";
  if (!data.shop) return "Shop is required";
  return false;
}
