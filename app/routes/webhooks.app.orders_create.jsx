import { authenticate } from "@/app/shopify.server"
import { supabase } from "@/app/supabase.server";

export const action = async ({ request }) => {
    // 1. Authenticate and parse payload
    const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

    if (!admin) {
        // If we can't get an admin client (e.g. shop uninstalled), stop.
        return new Response();
    }

    // 2. Extract Order Details
    const orderId = payload.admin_graphql_api_id;
    const orderName = payload.name;
    const customerId = payload.customer ? payload.customer.admin_graphql_api_id : null;
    const customerEmail = payload.email;

    console.log(`Processing Order ${orderName} for ${shop}`);
    console.log(JSON.stringify(payload, null, 2));

    // 3. Fetch Metafields via GraphQL
    // (Webhooks payloads don't always include all metafields, so we query to be safe)
    const orderData = await admin.graphql(
        `#graphql
    query getOrderMetafields($id: ID!) {
      order(id: $id) {
        metafieldChoice: metafield(namespace: "your_app", key: "split_choice") { value }
        metafieldCount: metafield(namespace: "your_app", key: "fulfillment_count") { value }
        totalShippingPriceSet {
          shopMoney { amount currencyCode }
        }
      }
    }`,
        { variables: { id: orderId } }
    );

    const orderJson = await orderData.json();
    const orderNode = orderJson.data?.order;

    const splitChoice = orderNode?.metafieldChoice?.value || 'unknown'; // "yes", "no"
    const fulfillmentCount = parseInt(orderNode?.metafieldCount?.value || '1', 10);
    const currency = orderNode?.totalShippingPriceSet?.shopMoney?.currencyCode || 'USD';

    // 4. Calculate Surcharge
    // Logic: Calculate additional cost based on fulfillment count.
    // Example: If count is 3, we need 2 extra labels. 
    // You can adjust this math based on the "order shipping method" as requested.
    const costPerParcel = 10.00; // Hardcoded example, or fetch from DB settings
    let additionalShippingAmount = 0;
    let requiresAdditionalShipping = false;

    if (splitChoice === 'yes' && fulfillmentCount > 1) {
        const extraParcels = fulfillmentCount - 1;
        additionalShippingAmount = extraParcels * costPerParcel;
        requiresAdditionalShipping = true;
    }

    // 5. Persist Parent Order to Supabase

    const { error: dbError } = await supabase
        .from('orders')
        .upsert({
            shop_domain: shop,
            shopify_order_gid: orderId,
            shopify_order_name: orderName,
            customer_gid: customerId,
            split_choice: splitChoice,
            split_choice_source: 'checkout_metafield',
            requires_additional_shipping: requiresAdditionalShipping,
            additional_shipping_amount: requiresAdditionalShipping ? additionalShippingAmount : 0,
            currency: currency,
            updated_at: new Date().toISOString()
        }, { onConflict: 'shopify_order_gid' });

    if (dbError) console.error("Supabase Error (Orders):", dbError);

    // 6. Create Draft Order (if required)
    if (requiresAdditionalShipping && customerId) {
        // Check if we already created one to ensure idempotency
        const { data: existingRequest } = await supabase
            .from('additional_shipping_requests')
            .select('id')
            .eq('parent_order_gid', orderId)
            .single();

        if (!existingRequest) {
            await createAndInvoiceDraftOrder({
                admin,
                shop,
                orderId,
                customerId,
                amount: additionalShippingAmount,
                currency,
                supabase
            });
        }
    }

    return new Response();
};

// ---- Helper Functions ----

async function createAndInvoiceDraftOrder({ admin, shop, orderId, customerId, amount, currency, supabase }) {
    // A. Create Draft Order
    const draftResponse = await admin.graphql(
        `#graphql
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
        }
        userErrors {
          field
          message
        }
      }
    }`,
        {
            variables: {
                input: {
                    customerId: customerId,
                    note: `Additional shipping for Split Fulfillment on Order ${orderId}`,
                    lineItems: [
                        {
                            title: "Split Fulfillment Surcharge",
                            quantity: 1,
                            originalUnitPrice: String(amount)
                        }
                    ],
                    tags: ["split_fulfillment_surcharge"],
                    metafields: [
                        { namespace: "your_app", key: "parent_order_gid", value: orderId, type: "single_line_text_field" }
                    ]
                }
            }
        }
    );

    const draftJson = await draftResponse.json();
    const draftOrder = draftJson.data?.draftOrderCreate?.draftOrder;

    if (!draftOrder) {
        console.error("Failed to create draft order", draftJson.data?.draftOrderCreate?.userErrors);
        return;
    }

    // B. Send Invoice (activates the Draft Order and emails the customer)
    const invoiceResponse = await admin.graphql(
        `#graphql
    mutation draftOrderInvoiceSend($id: ID!) {
      draftOrderInvoiceSend(id: $id) {
        draftOrderInvoice {
          to
        }
        userErrors {
          field
          message
        }
      }
    }`,
        { variables: { id: draftOrder.id } }
    );

    // Note: invoiceUrl is stable, but sending the invoice triggers the email.

    // C. Save to Supabase
    const { error: reqError } = await supabase
        .from('additional_shipping_requests')
        .insert({
            shop_domain: shop,
            parent_order_gid: orderId,
            draft_order_gid: draftOrder.id,
            draft_order_status: 'invoice_sent',
            invoice_url: draftOrder.invoiceUrl,
            invoice_sent_at: new Date().toISOString(),
            payment_status: 'pending',
        });

    if (reqError) console.error("Supabase Error (Requests):", reqError);
}