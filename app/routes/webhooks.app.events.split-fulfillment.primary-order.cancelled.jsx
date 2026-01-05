import { authenticate } from "@/app/shopify.server"
import { supabase } from "@/app/supabase.server";
import { getAttributeValueByName } from "@/app/helpers/fulfillment-split";



export const action = async ({ request }) => {
    const { topic, shop, admin, payload } = await authenticate.webhook(request);

    if (!admin) return new Response();


    try {
        const {
            id: orderId,
            note_attributes,
            updated_at
        } = payload;

        // Check 1: Parse Attributes
        const splitChoice = getAttributeValueByName(note_attributes, 'split_choice'); // 'yes' or 'no'
        const fulfillmentCount = parseInt(getAttributeValueByName(note_attributes, 'split_fulfillment_count') || 0);

        // Check 2: Is a split actually required/requested?
        if (!splitChoice || fulfillmentCount <= 1) {
            console.debug("Split not requested or single parcel. Skipping.");
            return new Response();
        }

        const { data: splitReq } = await supabase
            .from("additional_shipping_requests")
            .select("id, status")
            .eq("primary_order_id", orderId)
            .single();

        if (!splitReq) {
            console.debug("No split request found for this order. Skipping.");
            return new Response();
        }

        // 2. Update DB Record
        const { error: updateError } = await supabase
            .from('additional_shipping_requests')
            .update({
                status: 'CANCELLED',
                updated_at: updated_at,
                primary_order_cancelled_at: updated_at,
            })
            .eq('id', splitReq.id);

        if (updateError) {
            console.error("Failed to update DB record:", updateError);
            return new Response();
        }

        console.log("Primary Order Cancelled Webhook: Success");
        return new Response("Success");
    } catch (error) {
        console.error("Error in Primary Order Cancelled Webhook:", error);
        return new Response();
    }
};

