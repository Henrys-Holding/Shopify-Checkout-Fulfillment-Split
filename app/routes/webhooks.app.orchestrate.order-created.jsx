import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);



    return new Response();
}