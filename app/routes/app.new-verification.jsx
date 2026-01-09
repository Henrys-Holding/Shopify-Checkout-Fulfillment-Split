import { useActionData, useLoaderData, useNavigate, useNavigation, useSubmit } from "react-router";
import { useEffect, useState } from "react";
import { Page, Layout, Text, Card, BlockStack, TextField, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { requestVerification } from "../models/verification.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const orderId = url.searchParams.get("id") || null;

  return Response.json({ orderId });
};

export async function action({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const { shop } = session;

  const formData = await request.formData();
  const rawId = formData.get("id");

  if (typeof rawId !== "string" || rawId.trim() === "") {
    return Response.json({ success: false, message: "Missing order id." }, { status: 400 });
  }

  const id = rawId.trim();

  // If your model returns a plain object, wrap it:
  const result = await requestVerification(id, shop, admin);
  return result instanceof Response ? result : Response.json(result);
}

export default function Index() {
  const { orderId } = useLoaderData();
  const [id, setId] = useState(orderId || "");

  const navigate = useNavigate();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

  const actionData = useActionData();
  const submit = useSubmit();

  function handleSubmit() {
    submit({ id }, { method: "post" });
  }

  useEffect(() => {
    if (actionData?.success && actionData?.message) {
      // If App Bridge toast is wired, this should work:
      // window.shopify?.toast?.show(actionData.message, { duration: 5000 });
      navigate(`/app/credit-card-verifications`);
    }
  }, [actionData, navigate]);

  return (
    <Page
      fullWidth
      title="Request Order Verification"
      primaryAction={{
        content: "Submit",
        disabled: !id || isLoading,
        accessibilityLabel: "Request Order Verification",
        onAction: handleSubmit,
      }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {!actionData?.success && actionData?.message ? (
              <Banner title="Failed" tone="critical">
                <p>{actionData.message}</p>
              </Banner>
            ) : null}

            <Card padding="400">
              <BlockStack gap="500">
                <Text as="h2" variant="headingMd">
                  Order ID
                </Text>
                <TextField
                  id="id"
                  label="Order ID"
                  labelHidden
                  autoComplete="off"
                  value={id}
                  onChange={setId}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
