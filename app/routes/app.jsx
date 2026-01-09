// app/routes/app.jsx
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";

import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enPolaris from "@shopify/polaris/locales/en.json";

import { I18nextProvider } from "react-i18next";
import i18nClient from "../i18n.client";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enPolaris}>
        <I18nextProvider i18n={i18nClient}>
          <s-app-nav>
            <s-link href="/app">Home</s-link>
            <s-link href="/app/additional">Additional page</s-link>
            <s-link href="/app/credit-card-verifications">Credit Card Verification</s-link>
          </s-app-nav>
          
          <Outlet />
        </I18nextProvider>
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (args) => boundary.headers(args);
