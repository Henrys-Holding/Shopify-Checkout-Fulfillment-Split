# Agent instructions: Shopify Remix app (Polaris Web Components first)

## Mission

Build a Shopify **Remix.js** app (JavaScript-only) + Shopify UI extensions that:

1. **Checkout:** asks the buyer a **Yes / No** question about **fulfillment splitting** in checkout.
2. **After checkout:** if fulfillment splitting requires **additional shipping cost**, automatically create a **linked draft order** via **Shopify Admin GraphQL API**, send the **invoice** to the customer, and track whether it has been paid.
3. **Customer account:** show a **payment required** notice and a **pay link** inside the customer’s **order history** (and/or order details) for orders that require additional shipping payment.
4. **Admin embedded app:** provide a Shopify-embedded admin page to view:
   - the buyer’s split choice (Yes/No),
   - the linked additional-shipping draft order (or resulting paid order),
   - invoice/payment status,
   - timestamps and relevant IDs.

All UI must use **Shopify Polaris Web Components FIRST**, and follow Shopify’s design guidelines.

---

## Hard constraints (non‑negotiable)

### UI / design
- **Use Polaris web components first** for all UI in:
  - Embedded admin pages
  - Checkout UI extension
  - Customer account UI extension
- **Follow Shopify App Design Guidelines** (layout, hierarchy, accessibility, mobile-first, consistent admin experience).
- **No custom component libraries** (no Tailwind, no MUI, no Chakra, no Bootstrap, etc.).
- **Avoid custom CSS** unless Polaris documentation explicitly requires it (tokens & component props preferred).
- Never build interactive “fake buttons/links” with divs. Use `s-button`, `s-link`, and other Polaris primitives.

- Use the Shopify Remix app template’s required packages as-is (do not replace core Shopify/Remix dependencies).

### Stack
- **Remix.js + JavaScript only (no TypeScript).**
- **Supabase** is the backend datastore (Postgres).
- **Prisma Client must NOT be used at runtime.**
- **Supabase client for all queries.**
- **Prisma is used for schema migration ONLY** (no Prisma Client at runtime). Runtime DB access must use Supabase client.
- Use **Shopify Admin GraphQL API** (not REST) for all Shopify operations.

### Shopify integration rules
- Use `authenticate.admin` for Admin embedded routes and Admin GraphQL calls.
- Use `authenticate.public.checkout` for endpoints called from checkout extensions.
- Use `authenticate.public.customerAccount` for endpoints called from customer account extensions.
- Use **app-specific webhooks (recommended)** configured in `shopify.app.toml`.
- Webhook routes must authenticate using `authenticate.webhook`, respond **HTTP 200 quickly**, and offload heavy work if needed.

---

## Source of truth (must-read)

### Polaris Web Components (Admin / App Home + UI extension concepts)
- https://shopify.dev/docs/api/app-home/using-polaris-components#availability
- https://shopify.dev/docs/api/app-home/using-polaris-components#styling
- https://shopify.dev/docs/api/app-home/using-polaris-components#custom-layout
- https://shopify.dev/docs/api/app-home/using-polaris-components#scale
- https://shopify.dev/docs/api/app-home/using-polaris-components#responsive-values
- https://shopify.dev/docs/api/app-home/using-polaris-components#interactive-elements
- https://shopify.dev/docs/api/app-home/using-polaris-components#variant-tone-and-color
- https://shopify.dev/docs/api/app-home/using-polaris-components#using-with-react-app-home
- https://shopify.dev/docs/api/app-home/using-polaris-components#using-with-preact-ui-extensions
- https://shopify.dev/docs/api/app-home/using-polaris-components#properties-vs-attributes
- https://shopify.dev/docs/api/app-home/using-polaris-components#event-handling
- https://shopify.dev/docs/api/app-home/using-polaris-components#slots
- https://shopify.dev/docs/api/app-home/using-polaris-components#working-with-forms
- https://shopify.dev/docs/api/app-home/using-polaris-components#accessibility

### Shopify Remix app package (strict)
- https://shopify.dev/docs/api/shopify-app-remix/latest

Key pages:
- Admin auth + GraphQL: https://shopify.dev/docs/api/shopify-app-remix/latest/authenticate/admin
- Admin API: https://shopify.dev/docs/api/shopify-app-remix/latest/apis/admin-api
- Webhooks (app-specific): https://shopify.dev/docs/api/shopify-app-remix/latest/guide-webhooks

---

## Preferred implementation architecture

### Surfaces

#### 1) Embedded admin app (Remix)
- Merchants/admin users view a dashboard of:
  - orders requiring extra shipping payment
  - split choice results
  - draft order / invoice link
  - payment status
- UI uses Polaris web components only.

#### 2) Checkout UI extension
- Renders a Yes/No question.
- Stores buyer choice in a **checkout metafield** (namespace/key owned by the app).
- Do NOT attempt to modify checkout styling; use Polaris components only.

#### 3) Customer account UI extension
- Renders on **Order index** and/or **Order status** page surfaces.
- Shows “Additional shipping payment required” if a linked unpaid invoice exists.
- Provide a single clear call-to-action link/button to the invoice checkout URL (if available).

#### 4) Webhooks + backend jobs (Remix actions)
- Webhooks listen for:
  - New order creation (to read buyer choice and decide whether extra shipping is needed)
  - Payment/fulfillment related events needed to update status
  - App uninstall (cleanup shop data)
- Webhooks must be authenticated, idempotent, and fast.

---

## Data model (Supabase Postgres)

Create tables (via Prisma migrations) like:

### `shops`
- `id` (uuid pk)
- `shop_domain` (unique)
- `installed_at`
- `uninstalled_at` (nullable)

### `orders`
Tracks parent orders from checkout.
- `id` (uuid pk)
- `shop_domain`
- `shopify_order_gid` (unique per shop)
- `shopify_order_name` (e.g., #1001)
- `customer_gid` (nullable)
- `split_choice` (enum: 'yes' | 'no' | 'unknown')
- `split_choice_source` (e.g., 'checkout_metafield', 'admin_override')
- `requires_additional_shipping` (boolean)
- `additional_shipping_amount` (numeric, nullable)
- `currency` (text)
- `created_at`, `updated_at`

### `additional_shipping_requests`
Tracks the draft order/invoice lifecycle.
- `id` (uuid pk)
- `shop_domain`
- `parent_order_gid` (indexed)
- `draft_order_gid` (unique nullable until created)
- `draft_order_status` (text)
- `invoice_url` (text nullable)
- `invoice_sent_at` (timestamptz nullable)
- `payment_status` (enum: 'not_required' | 'pending' | 'paid' | 'void' | 'unknown')
- `child_order_gid` (nullable; order created from the draft order after payment)
- `last_synced_at`
- `created_at`, `updated_at`

### `audit_events` (optional)
- `shop_domain`
- `type`
- `payload_json`
- `created_at`

**Important:** Enable RLS. Server routes use Supabase service role keys; client code never receives them.

---

## Shopify IDs, linking strategy, and metafields

### Use app-specific metafields
Define order-level metafields owned by the app, for example:
- `namespace`: `your_app`
- keys:
  - `split_choice` (string/boolean)
  - `additional_shipping_required` (boolean)
  - `additional_shipping_draft_order_gid` (string)
  - `additional_shipping_invoice_url` (string)
  - `additional_shipping_paid` (boolean)

### Link parent order ↔ draft order / child order
- Store relationships in Supabase (source of truth for the app).
- Optionally mirror links into Shopify order metafields for easy support/debugging.

**Idempotency rule:** Never create more than one additional-shipping request for the same parent order unless explicitly re-triggered by the merchant.

---

## Backend flows (must implement)

### Flow A — Checkout choice capture
1. Checkout UI extension renders “Split fulfillment?” with Yes/No.
2. When buyer changes choice:
   - Write to a checkout metafield (namespace/key).
3. Keep UI minimal; one question + short explanation.

### Flow B — Parent order webhook processing
On order creation webhook:
1. Authenticate webhook request.
2. Identify the shop and order.
3. Read the app’s metafield(s) from the order (the checkout metafield should be associated with the order).
4. Persist `split_choice` to Supabase.
5. Decide `requires_additional_shipping` based on business rules.
6. If additional shipping is required:
   - Create a draft order via Admin GraphQL.
   - Ensure the draft order includes the additional shipping cost amount.
   - Send invoice via Admin GraphQL.
   - Store `draft_order_gid`, `invoice_url`, and set `payment_status='pending'`.
   - Save linkage metadata (Supabase + optional Shopify order metafields).

### Flow C — Payment status sync
When the invoice is paid, the draft order becomes an order.
Implement ONE of these strategies (prefer webhooks):
- Listen to relevant Shopify webhooks that let you detect payment completion and map back to the draft order / parent order.
- Or periodically sync by querying the draft order’s `status`, `completedAt`, `order { id }`, `invoiceUrl`, etc., and update Supabase.

### Flow D — Customer account display
Customer account extension:
1. Determine the current order context (order ID).
2. Call your app backend (public endpoint) to fetch whether a pending additional shipping request exists.
3. If pending:
   - display a clear banner/card with amount and a “Pay additional shipping” button linking to the invoice URL.
4. If paid:
   - show a subtle “Paid” status (no CTA).

### Flow E — Admin embedded dashboard
Admin page requirements:
- List view with filters:
  - pending payment
  - paid
  - no additional shipping required
  - error states
- Detail view:
  - parent order info
  - split choice
  - draft order link / invoice URL
  - payment status and last sync timestamp
- Provide “Refresh status” action that triggers server-side sync for that record.

---

## Shopify Admin GraphQL patterns (how to call)

### Always use Admin GraphQL via authenticate.admin
- In Remix `loader`/`action` for embedded routes:
  1. `const { admin, session } = await authenticate.admin(request);`
  2. Use `admin.graphql(...)` for GraphQL queries/mutations.

### Draft order + invoice expectations
- Creating a draft order is the mechanism for sending an invoice with a secure checkout link.
- After invoice send, persist `invoiceUrl` for UI surfaces.
- Track draft order `status`, `completedAt`, and `order { id }`.

---

## Polaris Web Components rules (Admin + extensions)

### Setup for embedded admin UI
- Include App Bridge + Polaris script tags, and the shopify-api-key meta tag.
- Do NOT use Polaris React. Use web components tags like `<s-page>`, `<s-section>`, `<s-card>`, etc.

### Layout
- Use opinionated layout components (`s-page`, `s-section`) to match Shopify admin spacing.
- Use `s-stack` and `s-grid` only for custom layouts when needed.
- Prefer `s-box` for padding/background/border in small cases.

### Scale & spacing
- Use Shopify’s scale tokens (e.g., `small-300`, `base`, `large-200`) when setting spacing.
- Default to `base` unless there is a specific reason.

### Responsive
- Use responsive values and container queries where supported.
- Don’t hardcode breakpoints in CSS. Prefer Polaris primitives.

### Interactive elements
- Use `s-button` and `s-link` for interactions.
- `s-clickable` is an escape hatch when no other component works.
- Do not nest interactive components inside other interactive containers.

### Properties vs attributes
- In JSX, ensure values are set correctly:
  - strings can be attributes
  - objects/arrays must be set as properties
- Remember standard `value` / `checked` behavior differs and follows HTML conventions.

### Events
- React handlers use camelCase props (e.g., `onChange`).
- Standard DOM event semantics apply.
- Prefer explicit handlers and avoid inline anonymous functions when it harms readability.

### Slots
- Use `slot="..."` attributes to populate named slots (when required by a component).
- Don’t invent your own slot names—follow component docs.

### Forms
- Prefer native `<form>` + Polaris form components.
- Ensure every input has an accessible label or `labelAccessibilityVisibility` config as documented.
- Use Remix actions for submissions; don’t add client-only form libraries.

### Accessibility
- Assume accessibility is a feature requirement, not “nice to have”.
- Always provide meaningful labels.
- Don’t rely on color alone to communicate status.
- Test keyboard navigation for everything interactive.

---

## Remix patterns (preferred)

### Data fetching
- Use Remix loaders for initial page data (auth + essential records).
- Use `@tanstack/react-query` for:
  - client-side polling/refresh of payment status
  - pagination & filtering caches
  - optimistic updates where safe

### Mutations
- Prefer Remix `<Form>` + server actions for writes that require session/admin access.
- Use `fetcher` for background updates (refresh status, resend invoice, etc.).

### Server boundaries
- Anything that touches:
  - Shopify Admin API tokens
  - Supabase service role
  - webhook secrets
  must run **server-side only**.

---

## Quality bars & acceptance criteria

### Correctness
- Never create duplicate additional-shipping draft orders for a parent order.
- Always link the request to the parent order in Supabase (and optionally metafields).
- Payment status shown in admin and customer account must reflect Shopify state.

### Performance
- Webhook endpoints must respond quickly (no slow DB scans / heavy GraphQL loops).
- Admin list views must paginate; do not render thousands of rows at once.

### Security
- Verify all incoming webhook requests.
- Verify all public extension requests with `authenticate.public.*`.
- Never expose secrets to the client or extension runtime.

### UX
- Minimal, clear checkout question.
- Customer account CTA is unambiguous and only shown when payment is needed.
- Admin dashboard matches Shopify admin patterns (spacing, hierarchy, buttons).

---

## “Do / Don’t” checklist

### Do
- ✅ Use `<s-page>` + `<s-section>` for admin pages.
- ✅ Use checkout/customer account metafields to store the buyer’s choice and link data.
- ✅ Use Admin GraphQL draft orders to invoice additional shipping.
- ✅ Store app state in Supabase; treat Shopify as system of record for payments.
- ✅ Use app-specific webhooks in `shopify.app.toml` and `authenticate.webhook` on the handler route.

### Don’t
- ❌ Don’t add UI libs or CSS frameworks.
- ❌ Don’t use Polaris React.
- ❌ Don’t use Prisma Client in runtime code.
- ❌ Don’t use Shopify REST Admin API.
- ❌ Don’t block webhooks with slow code paths.

---

## Notes for future enhancements (optional)
- Add merchant-configurable shipping surcharge rules (per zone, weight, product tags).
- Add retry & alerting for failed invoice sending.
- Add “Resend invoice” action (rate-limited).
- Add order detail admin extension block to display split-choice/payment status on the order page.
