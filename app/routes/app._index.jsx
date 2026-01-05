import { useLoaderData, useSearchParams, useSubmit, Link, useFetcher, useRevalidator } from "react-router";
import { supabase } from "../supabase.server";
import { authenticate } from "../shopify.server";
import { useState } from "react";

// -----------------------------------------------------------------------------
// 1. ACTION (Robust Save Logic)
// -----------------------------------------------------------------------------
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "TOGGLE_APP") {
    // 1. Get the DESIRED status (sent as string "true" or "false")
    const newStatus = formData.get("newStatus") === "true";

    // 2. Check if setting exists
    const { data, error } = await supabase
      .from("additional_shipping_request_settings")
      .upsert({
        shop_domain: session.shop,
        app_enabled: newStatus
      }, { onConflict: "shop_domain" })
      .select("app_enabled")
      .single();

    if (error) {
      return { status: "error", message: `Database update failed: ${error}` };
    }

    return { status: "success", appEnabled: data.app_enabled };
  }

  return null;
};

// -----------------------------------------------------------------------------
// 1. LOADER (No changes to logic, just fetching the data)
// -----------------------------------------------------------------------------
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = 15;
  const offset = (page - 1) * limit;

  // Parallel Fetch: Requests + Settings
  const [requestsResponse, settingsResponse] = await Promise.all([
    supabase
      .from("additional_shipping_requests")
      .select(`
        *,
      primary_order:core_orders!primary_order_id ( order_name, shop_domain, order_id ),
      payment_order:core_orders!payment_order_id ( order_name, shop_domain, order_id ),
      fulfillment_holds:additional_shipping_request_fulfillment_holds ( * )
      `, { count: "exact" })
      .eq("shop_domain", session.shop)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),

    supabase
      .from("additional_shipping_request_settings")
      .select("app_enabled")
      .eq("shop_domain", session.shop)
      .single()
  ]);

  const { data: requests, count, error } = requestsResponse;

  if (error) {
    console.error("Supabase Error:", error);
    throw new Response("Error fetching data", { status: 500 });
  }

  // Handle Settings Default
  const appEnabled = settingsResponse?.data?.app_enabled ?? false;

  const enhancedRequests = requests.map((req) => {
    // Time Calculation
    let timeLeftDisplay = "-";
    if (req.status === 'AWAITING_PAYMENT') {
      const now = new Date();
      const expires = new Date(req.created_at).getTime() + 24 * 60 * 60 * 1000; // 24 hours from created_at
      const diffMs = expires - now;
      if (diffMs > 0) {
        const h = Math.floor(diffMs / (1000 * 60 * 60));
        const m = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        timeLeftDisplay = `${h}h ${m}m`;
      } else {
        timeLeftDisplay = "已超時";
      }
    }

    // Holds Logic
    const holds = req.fulfillment_holds || [];

    return {
      ...req,
      timeLeftDisplay,
      formattedDate: new Date(req.created_at).toLocaleString(),
      formattedAmount: req.additional_shipping_amount
        ? `$${Number(req.additional_shipping_amount).toFixed(2)}`
        : '-',
      totalHolds: holds.length,
      releasedHolds: holds.filter(h => h.released).length,
      holdsData: holds
    };
  });

  return {
    requests: enhancedRequests,
    page,
    totalPages: Math.ceil((count || 0) / limit),
    totalCount: count,
    appEnabled
  };
};

// -----------------------------------------------------------------------------
// 2. CLIENT UI
// -----------------------------------------------------------------------------
export default function RequestsPage() {
  const { requests, page, totalPages, totalCount, appEnabled: initialServerState } = useLoaderData();
  const [searchParams] = useSearchParams();
  const submit = useSubmit();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();

  // ---------------------------------------------------------------------------
  // THE FIX: "Fetcher-First" State Logic
  // ---------------------------------------------------------------------------
  // 1. Pending State (Optimistic)
  //    Check if we are currently sending data to the server.
  const isSubmitting = (fetcher.state !== "idle" && fetcher.formData?.get("intent") === "TOGGLE_APP");
  const optimisticValue = isSubmitting
    ? fetcher.formData.get("newStatus") === "true"
    : null;


  // 2. Confirmed State (Action Result)
  //    Check if the fetcher has finished and returned a success payload.
  //    This persists until the page is fully reloaded or fetcher is reset.
  const confirmedValue = fetcher.data?.status === "success"
    ? fetcher.data.appEnabled
    : null;


  // 3. Final Display Calculation
  //    IF submitting? -> Show Optimistic
  //    ELSE IF we have a confirmed action result? -> Show Confirmed Result (Ignore Loader)
  //    ELSE -> Show Initial Loader State
  const displayAppEnabled = optimisticValue !== null
    ? optimisticValue
    : (confirmedValue !== null ? confirmedValue : initialServerState);


  // ---------------------------------------------------------------------------

  const handleToggleApp = () => {
    // Always toggle based on what is VISIBLE to the user
    const nextStatus = !displayAppEnabled;
    fetcher.submit(
      {
        intent: "TOGGLE_APP",
        newStatus: String(nextStatus) // Explicitly send "true" or "false"
      },
      { method: "post" }
    );
  };

  const handlePageChange = (newPage) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("page", newPage);
    submit(newParams);
  };


  return (
    <s-page inlineSize="large">
      <s-button slot="primary-action" onClick={() => revalidator.revalidate()} icon="refresh">
        Refresh Data
      </s-button>


      <s-stack gap="small" vertical>
        <s-switch
          checked={displayAppEnabled}
          label="Enable App"
          details="If disable app, the app will not process any new requests" // If disable app, the app will not process any new requests
          onChange={handleToggleApp}
        />
        <s-card>
          <s-box padding-block-end="400">
            <s-table
              loading={revalidator.state === "loading"}
              paginate
              hasNextPage={page < totalPages}
              hasPreviousPage={page > 1}
              onNextPage={() => handlePageChange(page + 1)}
              onPreviousPage={() => handlePageChange(page - 1)}
            >
              <s-table-header-row>
                <s-table-header>原訂單</s-table-header>
                <s-table-header>拆單費訂單</s-table-header>
                <s-table-header>日期</s-table-header>
                <s-table-header>選擇</s-table-header>
                <s-table-header>包裹數量</s-table-header>
                <s-table-header numeric>拆單費用</s-table-header>
                <s-table-header>狀態</s-table-header>
                <s-table-header>出貨狀態</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {requests.length === 0 ? (
                  <s-table-row>
                    <s-table-cell col-span="8">
                      <s-box padding="400" display="flex" justify-content="center">
                        <s-text tone="subdued">No requests found.</s-text>
                      </s-box>
                    </s-table-cell>
                  </s-table-row>
                ) : (
                  requests.map((req) => (
                    // We extract the row to a sub-component to keep the popover logic clean
                    <RequestRow key={req.id} req={req} />
                  ))
                )}
              </s-table-body>
            </s-table>
          </s-box>

        </s-card>
      </s-stack>
    </s-page>
  );
}

// -----------------------------------------------------------------------------
// 3. ROW COMPONENT (Handles the Popover "Dropdown")
// -----------------------------------------------------------------------------
function RequestRow({ req }) {
  return (
    <s-table-row>
      {/* 1. Order Link */}
      <s-table-cell>
        <s-stack>
          <s-link
            href={`shopify:admin/orders/${req.primary_order?.order_id}`}
            target="_blank"
            remove-underline
            monochrome
          >
            <s-text type="strong">{req.primary_order?.order_name}</s-text>
          </s-link>
          {req.primary_order_cancelled_at && (
            <s-chip color="strong">已取消</s-chip>
          )}
        </s-stack>

      </s-table-cell>

      {/* 2. Payment Order Link */}
      <s-table-cell>
        {req.payment_order ? (
          <s-link
            href={`shopify:admin/orders/${req.payment_order?.order_id}`}
            target="_blank"
            remove-underline
            monochrome
          >
            <s-stack direction="inline" alignContent="center" alignItems="center" gap="small-300">
              <s-icon type="money" />
              <s-text type="strong">{req.payment_order?.order_name}</s-text>
            </s-stack>
            {req.payment_order_cancelled_at && (
              <s-chip color="strong">已取消</s-chip>
            )}
          </s-link>
        ) : (
          <s-text tone="subdued">-</s-text>
        )}
      </s-table-cell>

      {/* 2. Date */}
      <s-table-cell>{req.formattedDate}</s-table-cell>

      {/* 3. Choice */}
      <s-table-cell>
        {req.user_choice ? (
          <s-badge tone="success">用戶同意</s-badge>
        ) : (
          <s-badge tone="subdued">用戶拒绝</s-badge>
        )}
      </s-table-cell>

      {/* 4. Parcels */}
      <s-table-cell>
        拆{req.calculated_parcels}个包裹
      </s-table-cell>

      {/* 5. Amount */}
      <s-table-cell numeric>
        <s-stack>
          <s-text>{req.formattedAmount}</s-text>
          {req.shipping_level && (
            <s-text>檔位：{req.shipping_level}檔</s-text>
          )}
          {req.additional_shipping_amount && (
            <s-text>運費計算：${parseFloat(req.additional_shipping_amount) / (parseFloat(req.calculated_parcels) - 1)} * {req.calculated_parcels - 1}</s-text>
          )}
        </s-stack>
      </s-table-cell>

      {/* 6. Status */}
      <s-table-cell>
        <StatusBadge status={req.status} errorLog={req.error_log} timeLeftDisplay={req.timeLeftDisplay} primaryOrder={req.primary_order} primaryOrderCancelledAt={req.primary_order_cancelled_at} paymentOrder={req.payment_order} paymentOrderCancelledAt={req.payment_order_cancelled_at} />
      </s-table-cell>


      {/* 8. Holds (The "Dropdown" Detail View) */}
      <s-table-cell>
        {(req.status !== "CANCELLED" && req.status !== "APP_DISABLED") ? (
          <s-stack vertical gap="small-300">
            <s-stack justify="space-between" align="center" gap="small-300">
              <s-badge tone={req.releasedHolds === req.totalHolds ? "success" : "warning"}>
                {req.releasedHolds === req.totalHolds ? "All Released" : "Action Required"}
              </s-badge>
            </s-stack>
            <s-box border-block-start="base" padding-block-start="200">
              <s-stack vertical gap="small-100">
                <s-ordered-list>
                  {req.holdsData.map((hold, index) => (
                    <>
                      <s-tooltip id="bold-tooltip">Bold</s-tooltip>
                      <s-list-item key={index} interestedFor="bold-tooltip">{hold.released ? "Released" : "On Hold"}</s-list-item>
                    </>
                  ))}
                </s-ordered-list>
              </s-stack>
            </s-box>
          </s-stack>
        ) : (
          <s-text tone="subdued">-</s-text>
        )}
      </s-table-cell>
    </s-table-row>
  );
}

function StatusBadge({ status, errorLog, timeLeftDisplay, primaryOrder, primaryOrderCancelledAt, paymentOrder, paymentOrderCancelledAt }) {
  const [showDebugModal, setShowDebugModal] = useState(false);

  let tone = "info";
  if (status === "AWAITING_PAYMENT") tone = "info";
  if (status === "APP_DISABLED") tone = "warning";
  if (status === "COMPLETED") tone = "success";
  if (status === "CANCELLED") tone = "critical";
  if (status === "FAILED") tone = "critical";

  const statusText = {
    PENDING: "待處理",
    APP_DISABLED: "已跳过：应用已禁用", // Skipped because app is disabled
    AWAITING_PAYMENT: "待支付拆單費",
    COMPLETED: "已完成",
    CANCELLED: "已取消",
    FAILED: "已失敗", // Shortened for badge, details in modal
  };

  return (
    <s-stack vertical gap="200" align="start">
      {/* 1. Badge + Debug Trigger Row */}
      <s-stack gap="small-300" align="center">
        <s-badge tone={tone}>{statusText[status] || status}</s-badge>

        {/* Debug Button (Only for FAILED) */}
        {status === "FAILED" && (
          <>
            <s-button
              variant="plain"
              icon="alert-diamond"
              tone="critical"
              commandFor="debug-modal"
              interestFor="debug-tooltip"
              accessibilityLabel="Open Debug Log"
            >
              查看錯誤日誌
            </s-button>

            {/* Developer Debug Modal */}
            <s-modal
              id="debug-modal"
              open={showDebugModal}
              on-close={() => setShowDebugModal(false)}
              heading="錯誤日誌"
              width="large"
            >
              <s-box>
                <s-stack vertical gap="base">
                  {/* Context Banner */}
                  <s-banner tone="critical" title="Transaction Failed">
                    <s-text as="p">
                      The splitting process failed. Please share the log below with the developer.
                    </s-text>
                  </s-banner>

                  {/* Code Block UI */}
                  <s-stack gap="small-200">
                    <s-text variant="headingSm" as="h5">Stack Trace / Details</s-text>
                    <s-box
                      padding="base"
                      margin-block-start="base"
                      border-radius="base"
                      border="base"
                    >
                      {/* Using HTML pre/code for proper formatting of JSON/Stack traces */}
                      <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: '12px' }}>
                        <code>{errorLog ? JSON.stringify(errorLog, null, 2) : "No error details available."}</code>
                      </pre>
                    </s-box>
                  </s-stack>

                  {/* Copy Helper (Visual only, actual copy requires JS clipboard API) */}
                  <s-text variant="bodyXs" tone="subdued">
                    Tip: Select text to copy
                  </s-text>
                </s-stack>
              </s-box>
            </s-modal>
          </>
        )}


        {/* 2. Helper Text Row */}
        {status === "AWAITING_PAYMENT" && (
          <s-stack>
            <s-text tone="subdued" variant="bodyXs">
              用戶需在24小時內完成支付
            </s-text>
            <s-text tone="subdued" variant="bodyXs">
              付款倒時： {timeLeftDisplay}
            </s-text>
          </s-stack>
        )}

        {/* 3. Cancelled Row */}
        {status === "CANCELLED" && (
          <s-box>
            {primaryOrderCancelledAt && (paymentOrder && !paymentOrderCancelledAt) && (
              <s-stack>
                <s-text tone="critical">
                  注意：拆單費訂單仍未取消
                </s-text>
                <s-text tone="subdued">
                  建議檢查拆單費訂單狀態，並進行相應處理
                </s-text>
              </s-stack>
            )}
            {paymentOrderCancelledAt && (primaryOrder && !primaryOrderCancelledAt) && (
              <s-stack>
                <s-text tone="subdued">
                  注意：原訂單仍未取消
                </s-text>
                <s-text tone="subdued">
                  建議檢查原訂單狀態，並進行相應處理
                </s-text>
              </s-stack>
            )}
            {primaryOrderCancelledAt && paymentOrderCancelledAt && (
              <s-text tone="subdued">
                原訂單和拆單費訂單均已取消
              </s-text>
            )}
          </s-box>
        )}
      </s-stack>
    </s-stack>
  );
}