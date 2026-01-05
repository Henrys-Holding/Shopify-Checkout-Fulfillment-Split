import { authenticate } from "@/app/shopify.server"
import { supabase } from "@/app/supabase.server";

function getAttributeValueByName(attributes, name) {
    const attribute = attributes?.find(attr => attr.name === name);
    return attribute?.value || null;
}

export const action = async ({ request }) => {
    const { topic, shop, admin, payload } = await authenticate.webhook(request);

    if (!admin) return new Response();

    try {
        const {
            id: paymentOrderId,
            admin_graphql_api_id: paymentOrderGid,
            name: paymentOrderName,
            note_attributes,
            financial_status,
        } = payload;

        // 1. Verify if this is one of our Surcharge Payment Orders
        const isPaymentOrder = getAttributeValueByName(note_attributes, 'is_additional_shipping_payment_order') === 'true';
        const primaryOrderId = getAttributeValueByName(note_attributes, 'primary_order_id');

        if (!isPaymentOrder || !primaryOrderId) {
            return new Response(); // Ignore standard orders
        }

        console.log(`💳 Payment Webhook: ${paymentOrderName} status is ${financial_status}`);

        // 2. Only release holds if payment is secured (Paid or Authorized)
        const isSecured = financial_status === 'paid' || financial_status === 'authorized';
        if (!isSecured) {
            return new Response();
        }

        // 1. Fetch Request and Holds
        const { data: requestRecord, error: fetchError } = await supabase
            .from('additional_shipping_requests')
            .select(`
            id, 
            status,
            fulfillment_holds:additional_shipping_request_fulfillment_holds (
                fulfillment_hold_id, 
                fulfillment_order_id, 
                released
            )
            `)
            .eq('primary_order_id', primaryOrderId)
            .single();

        if (!requestRecord || requestRecord.status === 'COMPLETED') return new Response();

        const activeHolds = requestRecord.fulfillment_holds.filter(hold => !hold.released);
        if (!activeHolds?.length) {
            // Self-correction: If no active holds exist but status isn't COMPLETED, close it.
            console.debug(`Self-correction: No active holds found for request ${requestRecord.id}`);
            await supabase.from('additional_shipping_requests')
                .update({ status: 'COMPLETED' })
                .eq('id', requestRecord.id);
            return new Response();
        }

        // 2. Execute Release Mutation
        try {
            // 2. Build and Execute targeted release mutation
            const releaseMutation = `#graphql
                mutation bulkReleaseSpecificHolds {
                    ${activeHolds.map((hold, index) => `
                        release${index}: fulfillmentOrderReleaseHold(
                            id: "${hold.fulfillment_order_id}",
                            holdIds: ["${hold.fulfillment_hold_id}"]
                        ) {
                            userErrors { field message }
                        }
                    `).join('\n')}
                }
            `;

            const releaseRes = await admin.graphql(releaseMutation);
            const releaseJson = await releaseRes.json();
            const results = Object.entries(releaseJson.data || {});

            const successfulHoldGids = [];
            const criticalErrors = [];

            // 3. Analyze Shopify Results
            results.forEach(([key, result]) => {
                const index = parseInt(key.replace('release', ''));
                const holdGid = activeHolds[index].fulfillment_hold_id;
                const errors = result.userErrors || [];

                // A hold is considered "Cleared" if released or if it doesn't exist anymore
                const isCleared = errors.length === 0 || errors.some(e =>
                    e.message.includes("not found") || e.message.includes("not on hold")
                );

                if (isCleared) {
                    successfulHoldGids.push(holdGid);
                } else {
                    criticalErrors.push(`Hold ${holdGid}: ${errors[0].message}`);
                }
            });

            // 4. Update Database (Soft-Release)
            if (successfulHoldGids.length > 0) {
                await supabase
                    .from('additional_shipping_request_fulfillment_holds')
                    .update({ released: true })
                    .in('fulfillment_hold_id', successfulHoldGids);
            }

            // 5. Final State Management
            if (criticalErrors.length > 0) {
                // High-Visibility Failure
                await supabase
                    .from('additional_shipping_requests')
                    .update({
                        status: 'FAILED',
                        error_log: `Partial release failed: ${criticalErrors.join('; ')}`,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', requestRecord.id);

                console.error("🚨 Critical: Surcharge paid but holds remain locked.");
                return new Response("Logged Partial Failure");
            }

            // Complete Success
            await supabase
                .from('additional_shipping_requests')
                .update({
                    status: 'COMPLETED',
                    error_log: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', requestRecord.id);
        } catch (error) {
            // System-level failure (e.g. Database down)
            await supabase.from('additional_shipping_requests').update({
                status: 'FAILED',
                error_log: `System Error: ${error.message}`
            }).eq('primary_order_id', primaryOrderId);

            return new Response("System Error", { status: 500 });
        }
        return new Response("Success");
    } catch (error) {
        console.error("Error in Payment Webhook:", error);
        return new Response();
    }
};

// ---- Helper Functions ----
async function logDbError(supabase, recordId, errorMessage) {
    console.error(errorMessage);
    await supabase
        .from('additional_shipping_requests')
        .update({
            status: 'FAILED',
            error_log: errorMessage
        })
        .eq('id', recordId);
}
