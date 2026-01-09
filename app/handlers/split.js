// app/handlers/split.js
import { supabase } from "../../app/supabase.server.js";
import {
  calculateFulfillmentSplits,
  getParcelPriceByShippingLineTitle,
  getShippingLineLevel,
} from "../helpers/fulfillment-split.js"; // <-- adjust path if needed

function getAttributeValueByName(attributes, name) {
  const attribute = attributes?.find((attr) => attr.name === name);
  return attribute?.value || null;
}

// ---- Helper Functions ----
async function logDbError(supabaseClient, recordId, errorMessage) {
  console.error(errorMessage);

  // Best effort DB update; don't crash if DB update fails
  try {
    await supabaseClient
      .from("additional_shipping_requests")
      .update({
        status: "FAILED",
        error_log: errorMessage,
      })
      .eq("id", recordId);
  } catch (e) {
    console.error("logDbError update failed:", e);
  }
}

/**
 * Run the split-fulfillment pipeline for an orders/create payload.
 *
 * @param {object} params
 * @param {string} params.shop
 * @param {object} params.admin Shopify Admin GraphQL client
 * @param {object} params.payload Shopify webhook payload
 */
export async function handleSplitPrimaryOrderCreated({ shop, admin, payload }) {
  // if no admin, just skip
  if (!admin) return { skipped: true, reason: "no_admin" };

  try {
    const {
      id: orderId,
      admin_graphql_api_id: orderGid,
      name: orderName,
      note_attributes,
      line_items,
      shipping_lines,
      customer,
      created_at,
      updated_at,
      shipping_address,
      customer_locale,
    } = payload || {};

    if (!orderId || !orderGid || !orderName) {
      return { skipped: true, reason: "missing_order_fields" };
    }
    if (!customer?.id) {
      return { skipped: true, reason: "missing_customer" };
    }

    // --- PRE-CHECKS ---
    if (!shipping_lines || shipping_lines.length === 0) {
      return { skipped: true, reason: "no_shipping_lines" };
    }

    // Check 2: Parse Attributes
    const splitChoice = getAttributeValueByName(note_attributes, "split_choice"); // 'yes' or 'no'
    const fulfillmentCount = parseInt(
      getAttributeValueByName(note_attributes, "split_fulfillment_count") || 0,
      10
    );

    // Check 3: Is a split actually required/requested?
    if (!splitChoice || fulfillmentCount <= 1) {
      return { skipped: true, reason: "no_split_required" };
    }

    const splitChoiceBoolean = splitChoice === "yes";
    const shippingCountryCode = shipping_address?.country_code;

    // --- STEP 1: CALCULATE LOGIC (Pure JS, no API calls yet) ---
    const recommendedParcels = calculateFulfillmentSplits(line_items);
    const costPerParcel = getParcelPriceByShippingLineTitle(
      shipping_lines[0]?.title,
      shippingCountryCode
    );
    const shippingLineLevel = getShippingLineLevel(
      shipping_lines[0]?.title,
      shippingCountryCode
    );

    if (!shippingLineLevel || !costPerParcel) {
      return { skipped: true, reason: "unknown_shipping_level_or_price" };
    }

    const extraParcels = Math.max(0, fulfillmentCount - 1);
    const additionalShippingAmount = extraParcels * costPerParcel;
    const locale = customer_locale || "zh-CN";

    // --- STEP 2: DB STATE INIT (Idempotency Check) ---
    const { data: shopRecord, error: shopError } = await supabase
      .from("core_shops")
      .upsert({ shop_domain: shop }, { onConflict: "shop_domain" })
      .select(
        `
        settings:additional_shipping_request_settings (
          app_enabled
        )
      `
      )
      .single();

    if (shopError) console.error("DB Shop Error:", shopError);

    const { error: orderError } = await supabase
      .from("core_orders")
      .upsert(
        {
          order_id: orderId,
          order_name: orderName,
          shop_domain: shop,
          customer_id: customer.id,
          updated_at,
          created_at,
        },
        { onConflict: "order_id" }
      );

    if (orderError) console.error("DB Order Error:", orderError);

    const { error: customerError } = await supabase
      .from("core_customers")
      .upsert(
        {
          customer_id: customer.id,
          shop_domain: shop,
          email: customer.email,
          first_name: customer.first_name,
          last_name: customer.last_name,
        },
        { onConflict: "customer_id" }
      );

    if (customerError) console.error("DB Customer Error:", customerError);

    // Check if we have already processed this split
    const { data: existingRecord } = await supabase
      .from("additional_shipping_requests")
      .select("id, status, draft_order_id")
      .eq("primary_order_id", orderId)
      .single();

    if (
      existingRecord &&
      (existingRecord.status === "COMPLETED" || existingRecord.status === "FAILED")
    ) {
      return { skipped: true, reason: "already_completed_or_failed" };
    }

    const settings = Array.isArray(shopRecord?.settings)
      ? shopRecord.settings[0]
      : shopRecord?.settings;

    const isAppEnabled = settings?.app_enabled || false;

    const { data: splitRecord, error: splitDbError } = await supabase
      .from("additional_shipping_requests")
      .upsert(
        {
          primary_order_id: orderId,
          shop_domain: shop,
          user_choice: splitChoiceBoolean,
          status: !isAppEnabled
            ? "APP_DISABLED"
            : splitChoiceBoolean
            ? "PENDING"
            : "COMPLETED",
          calculated_parcels: fulfillmentCount,
          shipping_level: shippingLineLevel,
          additional_shipping_amount: additionalShippingAmount,
          error_log: null,
          updated_at: new Date().toISOString(),
          created_at,
        },
        { onConflict: "primary_order_id" }
      )
      .select()
      .single();

    if (splitDbError) {
      console.error("Failed to init DB record:", splitDbError);
      // Throw so BullMQ can retry (DB may be temporarily down)
      throw new Error(`Split init DB failed: ${splitDbError.message || splitDbError}`);
    }

    if (!splitChoiceBoolean) return { skipped: true, reason: "user_chose_no_split" };
    if (!isAppEnabled) return { skipped: true, reason: "app_disabled" };

    // --- STEP 3: PREPARE SHOPIFY DATA ---
    const foQuery = `#graphql
      query getOrderFulfillments($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 5, query: "status:OPEN") {
            nodes {
              id
              status
              lineItems(first: 50) {
                nodes { id lineItem { id } }
              }
            }
          }
        }
      }`;

    const foResponse = await admin.graphql(foQuery, { variables: { id: orderGid } });
    const foJson = await foResponse.json();
    const primaryFulfillmentOrder = foJson.data?.order?.fulfillmentOrders?.nodes?.[0];

    if (!primaryFulfillmentOrder) {
      await logDbError(
        supabase,
        splitRecord.id,
        `${orderName} ${splitChoice}, ${fulfillmentCount} No OPEN fulfillment order found.\n${JSON.stringify(
          foJson.data?.order?.fulfillmentOrders?.nodes,
          null,
          2
        )}`
      );
      throw new Error("No OPEN fulfillment order found");
    }

    // Build Split Payload
    const splitInputs = [];
    for (let i = 1; i < recommendedParcels.length; i++) {
      const parcelConfig = recommendedParcels[i];
      const foItems = [];

      parcelConfig.forEach((item) => {
        const match = primaryFulfillmentOrder.lineItems.nodes.find(
          (node) => node.lineItem.id === item.lineItemId
        );
        if (match) foItems.push({ id: match.id, quantity: item.quantity });
      });

      if (foItems.length > 0) {
        splitInputs.push({
          fulfillmentOrderId: primaryFulfillmentOrder.id,
          fulfillmentOrderLineItems: foItems,
        });
      }
    }

    // --- STEP 4: EXECUTE PHASE 1 (SPLIT + HOLD) ---
    try {
      const splitMutation = `#graphql
        mutation splitFulfillment($splitInputs: [FulfillmentOrderSplitInput!]!) {
          fulfillmentOrderSplit(fulfillmentOrderSplits: $splitInputs) {
            fulfillmentOrderSplits {
              fulfillmentOrder { id }
              remainingFulfillmentOrder { id }
            }
            userErrors { field message }
          }
        }`;

      const splitResponse = await admin.graphql(splitMutation, {
        variables: { splitInputs },
      });

      const splitJson = await splitResponse.json();
      const splitData = splitJson.data?.fulfillmentOrderSplit;

      if (splitData?.userErrors?.length > 0) {
        throw new Error(`Split Failed: ${JSON.stringify(splitData.userErrors)}`);
      }

      const allFulfillmentOrderIds = [
        primaryFulfillmentOrder.id,
        ...splitData.fulfillmentOrderSplits.map((s) => s.fulfillmentOrder.id),
        ...splitData.fulfillmentOrderSplits.map((s) => s.remainingFulfillmentOrder.id),
      ];
      const uniqueFulfillmentOrderIds = [...new Set(allFulfillmentOrderIds)];

      const holdMutation = `#graphql
        mutation bulkHoldAll($reason: FulfillmentHoldReason!, $notes: String!) {
          ${uniqueFulfillmentOrderIds
            .map(
              (id, index) => `
            hold${index}: fulfillmentOrderHold(
              id: "${id}",
              fulfillmentHold: { reason: $reason, reasonNotes: $notes }
            ) {
              fulfillmentHold { id }
              userErrors { field message }
            }`
            )
            .join("\n")}
        }`;

      const holdResponse = await admin.graphql(holdMutation, {
        variables: { reason: "OTHER", notes: "Awaiting additional shipping payment." },
      });

      const holdJson = await holdResponse.json();
      const results = Object.entries(holdJson.data || {});

      const successfulHoldIds = [];
      const holdErrors = [];

      results.forEach(([, result]) => {
        if (result?.fulfillmentHold?.id) successfulHoldIds.push(result.fulfillmentHold.id);
        if (result?.userErrors?.length > 0) holdErrors.push(...result.userErrors);
      });

      if (holdErrors.length > 0) {
        console.error(`❌ Hold Partial Failure. Errors: ${JSON.stringify(holdErrors)}`);

        // rollback successful holds
        if (successfulHoldIds.length > 0) {
          const rollbackMutation = `#graphql
            mutation rollbackHolds {
              ${successfulHoldIds
                .map(
                  (holdId, idx) => `
                release${idx}: fulfillmentOrderReleaseHold(fulfillmentHoldId: "${holdId}") {
                  userErrors { message }
                }`
                )
                .join("\n")}
            }`;
          await admin.graphql(rollbackMutation);
        }

        throw new Error(
          `Hold Phase Failed. Rolled back holds. Errors: ${JSON.stringify(holdErrors)}`
        );
      }

      // Commit holds to DB
      const holdRecords = successfulHoldIds.map((holdId, index) => ({
        fulfillment_hold_id: holdId,
        fulfillment_order_id: uniqueFulfillmentOrderIds[index],
        additional_shipping_request_id: splitRecord.id,
      }));

      const { error: holdRecordsError } = await supabase
        .from("additional_shipping_request_fulfillment_holds")
        .insert(holdRecords);

      if (holdRecordsError) {
        throw new Error("Database failed to save hold records. Manual intervention required.");
      }

      console.log("✅ All parcels held and recorded successfully.");
    } catch (e) {
      await logDbError(supabase, splitRecord.id, `Phase 1 Error: ${e.message}`);
      throw e; // ✅ important for BullMQ retry
    }

    // --- STEP 5: EXECUTE PHASE 2 (DRAFT → ORDER → INVOICE) ---
    let payment_order_id = null;
    let draft_order_id = null;

    try {
      const draftCreateMutation = `#graphql
        mutation draftCreate($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id }
            userErrors { field message }
          }
        }`;

      const draftInput = {
        customerId: customer.admin_graphql_api_id,
        note: `Additional shipping for ${orderName} (Split into ${fulfillmentCount} parcels)`,
        lineItems: [
          {
            title: `${orderName} ship${recommendedParcels.length} ${shippingLineLevel}檔`,
            quantity: 1,
            originalUnitPrice: additionalShippingAmount.toString(),
          },
        ],
        customAttributes: [
          { key: "is_additional_shipping_payment_order", value: "true" },
          { key: "primary_order_id", value: orderId.toString() },
        ],
        tags: ["additional-shipping-payment-order"],
        paymentTerms: {
          paymentSchedules: [
            { dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
          ],
          paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/7",
        },
      };

      const draftRes = await admin.graphql(draftCreateMutation, {
        variables: { input: draftInput },
      });
      const draftJson = await draftRes.json();

      if (draftJson.data?.draftOrderCreate?.userErrors?.length > 0) {
        throw new Error(
          `Draft Create Failed: ${JSON.stringify(draftJson.data.draftOrderCreate.userErrors)}`
        );
      }

      draft_order_id = draftJson.data?.draftOrderCreate?.draftOrder?.id;

      const draftCompleteMutation = `#graphql
        mutation draftComplete($id: ID!) {
          draftOrderComplete(id: $id, paymentPending: true) {
            draftOrder { order { id name legacyResourceId } }
            userErrors { field message }
          }
        }`;

      const completeRes = await admin.graphql(draftCompleteMutation, {
        variables: { id: draft_order_id },
      });
      const completeJson = await completeRes.json();

      if (completeJson.data?.draftOrderComplete?.userErrors?.length > 0) {
        throw new Error(
          `Draft Complete Failed: ${JSON.stringify(
            completeJson.data.draftOrderComplete.userErrors
          )}`
        );
      }

      payment_order_id = completeJson.data.draftOrderComplete.draftOrder.order.legacyResourceId;
      const payment_order_name = completeJson.data.draftOrderComplete.draftOrder.order.name;

      const { error: payment_order_error } = await supabase.from("core_orders").insert([
        {
          order_id: payment_order_id,
          order_name: payment_order_name,
          shop_domain: shop,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      if (payment_order_error) {
        throw new Error(`Payment Order Create Failed: ${JSON.stringify(payment_order_error)}`);
      }

      const orderInvoiceMutation = `#graphql
        mutation orderInvoiceSend($id: ID!, $email: EmailInput!) {
          orderInvoiceSend(id: $id, email: $email) {
            order { id }
            userErrors { field message }
          }
        }`;

      const invoiceSubject = locale.includes("en")
        ? `[Invoice] Order ${orderName} Split Parcel Additional Shipping (Please complete within 24 hours)`
        : `[付款单] 订单 ${orderName} 拆分包裹补款通知 (请在24小时内完成)`;

      const invoiceCustomMessage = locale.includes("en")
        ? `This invoice is associated with your original order: ${orderName}.<br><br>Important Notice: You selected "Split Parcel" at checkout to ensure safer shipping. This is an additional shipping fee invoice. Click the "Pay Now" button in the email to proceed to checkout, <br><strong>Please complete payment within 24 hours.</strong><br><br>• If payment is completed: We will immediately split and ship the parcel.<br>• If payment is not completed: Your original order will be automatically canceled.<br><br>Thank you for your cooperation.`
        : `此账单关联您的原始订单：${orderName}。<br><br>重要提示：您在结账时选择了“拆分包裹”以获得更安全的运输保障。这是为您生成的额外运费账单。请点击邮件中的 “立即支付” 按钮进入结账页面，<br><strong>请务必在 24 小时内 完成支付。</strong><br><br>• 如完成支付：我们将立即为您拆分包裹并发出。<br>• 如超时未付：系统将自动取消您的原始订单。<br><br>感谢您的配合。`;

      const invoiceRes = await admin.graphql(orderInvoiceMutation, {
        variables: {
          id: `gid://shopify/Order/${payment_order_id}`,
          email: {
            subject: invoiceSubject,
            customMessage: invoiceCustomMessage,
          },
        },
      });

      const invoiceJson = await invoiceRes.json();
      if (invoiceJson.data?.orderInvoiceSend?.userErrors?.length > 0) {
        throw new Error(
          `Invoice Send Failed: ${JSON.stringify(invoiceJson.data.orderInvoiceSend.userErrors)}`
        );
      }
    } catch (e) {
      await logDbError(supabase, splitRecord.id, `Phase 2 Error: ${e.message}`);
      throw e; // ✅ important for BullMQ retry
    }

    // --- STEP 6: DB SUCCESS ---
    try {
      const { error: linkOrderError } = await supabase
        .from("additional_shipping_requests")
        .update({
          status: "AWAITING_PAYMENT",
          payment_order_id,
          draft_order_id,
          error_log: null,
        })
        .eq("id", splitRecord.id);

      if (linkOrderError) {
        throw new Error(`Final DB Link Order Error: ${linkOrderError.message}`);
      }
    } catch (e) {
      await logDbError(supabase, splitRecord.id, `Phase 6 Error: ${e.message}`);
      throw e; // ✅ important for BullMQ retry
    }

    console.log(`✅ Success: Order ${orderName} split & invoiced.`);

    return {
      success: true,
      orderId,
      orderGid,
      splitRequestId: splitRecord.id,
      payment_order_id,
      draft_order_id,
    };
  } catch (error) {
    console.error("Error processing fulfillment split:", error);
    // Throw so BullMQ marks this job as failed and retries (based on attempts/backoff)
    throw error;
  }
}
