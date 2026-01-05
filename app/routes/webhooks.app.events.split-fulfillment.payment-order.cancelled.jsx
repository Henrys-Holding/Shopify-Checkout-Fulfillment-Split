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

        // 1. Verify if this is one of our Surcharge Payment Orders
        const isPaymentOrder = getAttributeValueByName(note_attributes, 'is_additional_shipping_payment_order') === 'true';
        if (!isPaymentOrder) {
            console.debug(`Not a payment order ${orderId}. Skipping.`);
            return new Response();
        }

        const { data: paymentReq } = await supabase
            .from("additional_shipping_requests")
            .select("id, status")
            .eq("payment_order_id", orderId)
            .single();

        if (!paymentReq) {
            console.debug(`No payment request found for this order ${orderId}. Skipping.`);
            return new Response();
        }

        // 2. Update DB Record
        const { error: updateError } = await supabase
            .from('additional_shipping_requests')
            .update({
                status: 'CANCELLED',
                updated_at: updated_at,
                payment_order_cancelled_at: updated_at,
            })
            .eq('id', paymentReq.id);

        if (updateError) {
            console.error("Failed to update DB record:", updateError);
            return new Response();
        }


        return new Response("Success");
    } catch (error) {
        console.error("Error in Payment Webhook:", error);
        return new Response();
    }
};

