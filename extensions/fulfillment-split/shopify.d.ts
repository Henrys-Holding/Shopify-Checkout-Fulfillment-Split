import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Checkout.jsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.payment-method-list.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/utils.js' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.payment-method-list.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}
