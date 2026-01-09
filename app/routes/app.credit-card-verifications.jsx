import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "react-router";

import {
  Badge,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  ChoiceList,
  DropZone,
  Icon,
  IndexFilters,
  IndexFiltersMode,
  IndexTable,
  InlineStack,
  Layout,
  Link as PolarisLink,
  Modal,
  Page,
  Pagination,
  Spinner,
  Text,
  TextField,
  Thumbnail,
  Tooltip,
  useBreakpoints,
  useSetIndexFiltersMode,
  UnstyledButton,
} from "@shopify/polaris";
import { NoteIcon, QuestionCircleIcon } from "@shopify/polaris-icons";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getVerifications,
  resendEmail,
  submitVerification,
  validateVerification,
} from "../models/verification.server";

export const headers = (args) => boundary.headers(args);

const ROWS_PER_PAGE = 20;

/** Client-safe enums (avoid importing @prisma/client into a browser bundle) */
const VerificationStatus = {
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  PENDING_VERIFICATION: "PENDING_VERIFICATION",
  PENDING_SUBMISSION: "PENDING_SUBMISSION",
  ATTEMPTS_EXCEEDED: "ATTEMPTS_EXCEEDED",
};

const RiskLevel = { HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" };

const RiskRecommendation = {
  ACCEPT: "ACCEPT",
  CANCEL: "CANCEL",
  INVESTIGATE: "INVESTIGATE",
};

const OrderStatus = { HOLD: "HOLD", RELEASED: "RELEASED" };

function holdOrderNumbers(orders) {
  return orders.filter((o) => o.status === OrderStatus.HOLD).map((o) => o.order_name);
}

function isBrowser() {
  return typeof window !== "undefined";
}

function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  const [isDebouncing, setIsDebouncing] = useState(false);

  useEffect(() => {
    setIsDebouncing(true);
    const t = setTimeout(() => {
      setDebounced(value);
      setIsDebouncing(false);
    }, delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return [debounced, isDebouncing];
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const page = Number.parseInt(url.searchParams.get("page") || "1", 10);
  const status = url.searchParams.get("status") || "All";
  const query = url.searchParams.get("query") || "";

  const { verifications, totalCount } = await getVerifications(
    session.shop,
    admin.graphql,
    page,
    ROWS_PER_PAGE,
    query || null,
    status
  );

  const normalizedVerifications = verifications.map((v) => ({
    ...v,
    credit_card_bin: v.credit_card_bin == null ? null : String(v.credit_card_bin),
    created_at: v.created_at instanceof Date ? v.created_at.toISOString() : v.created_at,
    submission_time: v.submission_time instanceof Date ? v.submission_time.toISOString() : v.submission_time,
  }));

  return {
    verifications: normalizedVerifications,
    totalCount,
    page,
    query,
    status,
  };
};

export async function action({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const { shop } = session;

  const formData = await request.formData();
  const act = formData.get("action");

  if (act === "upload") {
    formData.delete("action");
    return await submitVerification(formData, admin);
  }

  if (act === "resendEmail") {
    formData.delete("action");
    return await resendEmail(formData, shop, admin);
  }

  return await validateVerification(formData, shop, admin);
}

function DropZoneArea({ files, setFiles }) {
  const handleDropZoneDrop = useCallback(
    (_dropFiles, acceptedFiles) => {
      setFiles((prev) => [...prev, ...acceptedFiles]);
    },
    [setFiles]
  );

  const validImageTypes = ["image/jpeg", "image/png"];

  const fileUpload = !files.length && (
    <DropZone.FileUpload actionHint="Accepts .jpg, and .png" />
  );

  const uploadedFiles = files.length > 0 && (
    <BlockStack gap="200">
      {files.map((file, idx) => (
        <InlineStack key={`${file.name}-${idx}`} gap="200" blockAlign="center">
          <Thumbnail
            alt={file.name}
            size="small"
            source={
              validImageTypes.includes(file.type) && isBrowser()
                ? window.URL.createObjectURL(file)
                : NoteIcon
            }
          />
          <BlockStack gap="050">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              {file.name}
            </Text>
            <Text as="p" variant="bodyXs" tone="subdued">
              {file.size} bytes
            </Text>
          </BlockStack>
        </InlineStack>
      ))}
    </BlockStack>
  );

  return (
    <DropZone onDrop={handleDropZoneDrop} accept=".jpg,.png">
      {uploadedFiles}
      {fileUpload}
    </DropZone>
  );
}

function VRTableRow({ request, position, onOpenImages, onUpload, onResendEmail, onSelectStatus }) {
  const createdAt = new Date(request.created_at);
  const daysSince = Math.max(
    0,
    Math.ceil((Date.now() - createdAt.getTime()) / (1000 * 3600 * 24))
  );

  const canShowAge =
    request.status !== VerificationStatus.APPROVED &&
    request.status !== VerificationStatus.DENIED;

  return (
    <IndexTable.Row id={request.id} position={position}>
      <IndexTable.Cell>
        <BlockStack gap="050">
          <Text variant="bodyXs" fontWeight="bold" as="span">
            ID: {String(request.customer_id || "").replace("gid://shopify/Customer/", "")}
          </Text>
          <Text variant="bodyXs" as="span">
            Email: {request.customer_email}
          </Text>
          <Text variant="bodyXs" as="span">
            Name: {request.customer_name}
          </Text>
        </BlockStack>
      </IndexTable.Cell>

      <IndexTable.Cell>
        <Text as="p" variant="bodyXs">
          {request.credit_card_number}
        </Text>
      </IndexTable.Cell>

      <IndexTable.Cell>
        <BlockStack gap="050">
          {(request?.bin_lookup?.bin || request.credit_card_bin) && (
            <Text as="p" variant="bodyXs">
              BIN: {request?.bin_lookup?.bin || request.credit_card_bin}
            </Text>
          )}
          {request?.bin_lookup?.bank && (
            <Text as="p" variant="bodyXs">
              Bank: {request.bin_lookup.bank}
            </Text>
          )}
          {request?.bin_lookup?.scheme && (
            <Text as="p" variant="bodyXs">
              Scheme: {request.bin_lookup.scheme}
            </Text>
          )}
          {request?.bin_lookup?.type && (
            <Text as="p" variant="bodyXs">
              Type: {request.bin_lookup.type}
            </Text>
          )}
        </BlockStack>
      </IndexTable.Cell>

      <IndexTable.Cell>
        <BlockStack gap="050">
          <Text as="p" variant="bodyXs">
            {createdAt.toLocaleDateString("en-CA")}
          </Text>
          <Text as="p" variant="bodyXs">
            {createdAt.toLocaleTimeString("en-US")}
          </Text>
        </BlockStack>
      </IndexTable.Cell>

      <IndexTable.Cell>
        {canShowAge ? (
          daysSince >= 7 ? (
            <Text as="p" variant="bodyMd" tone="critical" fontWeight="semibold">
              {daysSince}
            </Text>
          ) : (
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {daysSince}
            </Text>
          )
        ) : null}
      </IndexTable.Cell>

      <IndexTable.Cell>
        {request.status === VerificationStatus.PENDING_SUBMISSION && request.follow_up ? (
          <Badge tone="attention">Reminded</Badge>
        ) : null}
      </IndexTable.Cell>

      <IndexTable.Cell>
        {request.status !== VerificationStatus.PENDING_SUBMISSION ? (
          <InlineStack gap="200" blockAlign="center">
            {request.images.slice(0, 2).map((img, idx) => (
              <UnstyledButton
                key={`${request.id}-img-${idx}`}
                plain
                onClick={() => onOpenImages(request.images, idx)}
              >
                <Thumbnail source={img} alt="Photo proof" size="small" />
              </UnstyledButton>
            ))}
            {request.images.length > 2 ? (
              <UnstyledButton style={{border:0, backgroundColor: 'unset', cursor: 'pointer'}} plain onClick={() => onOpenImages(request.images, 0)}>
                <Badge tone="attention">+{request.images.length - 2}</Badge>
              </UnstyledButton>
            ) : null}
          </InlineStack>
        ) : (
          <Thumbnail source={QuestionCircleIcon} alt="Photo proof" size="small" />
        )}
      </IndexTable.Cell>

      <IndexTable.Cell>
        <Text as="p" variant="bodyXs">
          {request.status !== VerificationStatus.PENDING_SUBMISSION && request.submission_time
            ? new Date(request.submission_time).toLocaleString("en-CA")
            : "N/A"}
        </Text>
      </IndexTable.Cell>

      <IndexTable.Cell>
        {request.status === VerificationStatus.APPROVED && <Badge tone="success">Approved</Badge>}
        {request.status === VerificationStatus.DENIED && <Badge tone="critical">Denied</Badge>}
        {request.status === VerificationStatus.PENDING_SUBMISSION && (
          <Badge tone="info">Pending Submission</Badge>
        )}
        {request.status === VerificationStatus.PENDING_VERIFICATION && (
          <Badge tone="attention">Pending Verification</Badge>
        )}
        {request.status === VerificationStatus.ATTEMPTS_EXCEEDED && (
          <Badge tone="attention">Attempts Exceeded</Badge>
        )}
      </IndexTable.Cell>

      <IndexTable.Cell>
        <BlockStack gap="100">
          {request.risk_level ? (
            <InlineStack gap="100" blockAlign="center">
              <Text as="p" variant="bodyXs">
                Risk Level:
              </Text>
              {request.risk_level === RiskLevel.HIGH && <Badge tone="critical">High</Badge>}
              {request.risk_level === RiskLevel.MEDIUM && <Badge tone="attention">Medium</Badge>}
              {request.risk_level === RiskLevel.LOW && <Badge tone="success">Low</Badge>}
            </InlineStack>
          ) : null}

          {request.risk_recommendation ? (
            <InlineStack gap="100" blockAlign="center">
              <Text as="p" variant="bodyXs">
                Recommendation:
              </Text>
              {request.risk_recommendation === RiskRecommendation.ACCEPT && (
                <Badge tone="success">Approve</Badge>
              )}
              {request.risk_recommendation === RiskRecommendation.CANCEL && (
                <Badge tone="critical">Cancel</Badge>
              )}
              {request.risk_recommendation === RiskRecommendation.INVESTIGATE && (
                <Badge tone="attention">Investigate</Badge>
              )}
            </InlineStack>
          ) : null}
        </BlockStack>
      </IndexTable.Cell>

      <IndexTable.Cell>
        {request.internal_notes ? (
          <Tooltip content={request.internal_notes}>
            <span>
              <Icon source={NoteIcon} tone="success" />
            </span>
          </Tooltip>
        ) : null}
      </IndexTable.Cell>

      <IndexTable.Cell>
        <BlockStack gap="050">
          {request.orders.map((order) => (
            <Text as="p" variant="bodyXs" key={order.order_id}>
              <PolarisLink
                url={`shopify://admin/orders/${String(order.order_id).replace("gid://shopify/Order/", "")}`}
                target="_blank"
              >
                {order.order_name}
              </PolarisLink>
            </Text>
          ))}
        </BlockStack>
      </IndexTable.Cell>

      <IndexTable.Cell>
        {request.status === VerificationStatus.PENDING_VERIFICATION ? (
          <ButtonGroup>
            <Button onClick={() => onUpload(request.id)}>Add Additional Image</Button>
            <Button
              tone="success"
              variant="primary"
              onClick={() => onSelectStatus(request.id, VerificationStatus.APPROVED)}
            >
              Approve
            </Button>
            <Button
              tone="critical"
              variant="primary"
              onClick={() => onSelectStatus(request.id, VerificationStatus.DENIED)}
            >
              Deny
            </Button>
          </ButtonGroup>
        ) : null}

        {request.status === VerificationStatus.ATTEMPTS_EXCEEDED ? (
          <ButtonGroup>
            <Button
              tone="critical"
              variant="primary"
              onClick={() => onSelectStatus(request.id, VerificationStatus.DENIED)}
            >
              Deny
            </Button>
          </ButtonGroup>
        ) : null}

        {request.status === VerificationStatus.PENDING_SUBMISSION ? (
          <ButtonGroup>
            <Button onClick={() => onUpload(request.id)} variant="primary">
              Submit Manually
            </Button>
            <Button onClick={() => onResendEmail(request.id)} variant="secondary">
              Resend Email
            </Button>
            <Button
              tone="critical"
              variant="primary"
              onClick={() => onSelectStatus(request.id, VerificationStatus.DENIED, false)}
            >
              Deny
            </Button>
          </ButtonGroup>
        ) : null}
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

function VRTable({ verifications, totalCount, page, query, status, onSearch }) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const submittingRef = useRef(false);

  const isBusy = navigation.state === "submitting" || navigation.state === "loading";

  // Filters
  const { mode, setMode } = useSetIndexFiltersMode(IndexFiltersMode.Filtering);
  const [queryValue, setQueryValue] = useState(query || "");
  const [recordStatus, setRecordStatus] = useState(status || "All");
  const [debouncedQuery, isDebouncing] = useDebouncedValue(queryValue, 600);

  // Modals
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [resendModalOpen, setResendModalOpen] = useState(false);

  const [selectedId, setSelectedId] = useState(null);
  const [allowResubmit, setAllowResubmit] = useState(true);

  const [files, setFiles] = useState([]);

  const [formState, setFormState] = useState({}); // { status, internalNotes, notifyCustomer }

  // Image viewer
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerImages, setViewerImages] = useState([]);
  const [viewerIndex, setViewerIndex] = useState(0);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(totalCount / ROWS_PER_PAGE)), [totalCount]);

  const [selectedTab, setSelectedTab] = useState(0);
  const tabs = useMemo(() => [{ id: "all", content: "All" }], []);

  // keep local state in sync when URL changes
  useEffect(() => setQueryValue(query || ""), [query]);
  useEffect(() => setRecordStatus(status || "All"), [status]);

  // apply search when filters change
  useEffect(() => {
    onSearch(debouncedQuery, recordStatus || "All", 1);
  }, [debouncedQuery, recordStatus, onSearch]);

  // after a submit completes, close modals & reset
  useEffect(() => {
    if (navigation.state === "idle" && submittingRef.current) {
      submittingRef.current = false;
      setStatusModalOpen(false);
      setUploadModalOpen(false);
      setResendModalOpen(false);
      setSelectedId(null);
      setAllowResubmit(true);
      setFiles([]);
      setFormState({});
    }
  }, [navigation.state]);

  const handleFiltersClearAll = useCallback(() => {
    setQueryValue("");
    setRecordStatus("All");
  }, []);

  const filters = [
    {
      key: "recordStatus",
      label: "Status",
      filter: (
        <ChoiceList
          title="Status"
          titleHidden
          allowMultiple={false}
          choices={[
            { label: "All", value: "All" },
            { label: "Approved", value: VerificationStatus.APPROVED },
            { label: "Denied", value: VerificationStatus.DENIED },
            { label: "Pending Verification", value: VerificationStatus.PENDING_VERIFICATION },
            { label: "Pending Submission", value: VerificationStatus.PENDING_SUBMISSION },
            { label: "Attempts Exceeded", value: VerificationStatus.ATTEMPTS_EXCEEDED },
          ]}
          selected={recordStatus ? [recordStatus] : ["All"]}
          onChange={(val) => setRecordStatus(val[0] || "All")}
        />
      ),
      shortcut: true,
    },
  ];

  const appliedFilters =
    recordStatus && recordStatus !== "All"
      ? [
          {
            key: "recordStatus",
            label: `Status: ${recordStatus}`,
            onRemove: () => setRecordStatus("All"),
          },
        ]
      : [];

  const openStatusModal = (id, statusValue, allow = true) => {
    setSelectedId(id);
    setAllowResubmit(allow);
    setFormState({ status: statusValue });
    setStatusModalOpen(true);
  };

  const confirmStatus = () => {
    if (!selectedId || !formState.status) return;

    const payload = {
      id: selectedId,
      status: formState.status,
    };

    if (formState.notifyCustomer) payload.notifyCustomer = JSON.stringify(formState.notifyCustomer);
    if (formState.internalNotes) payload.internalNotes = formState.internalNotes;

    submittingRef.current = true;
    submit(payload, { method: "post" });
  };

  const openUploadModal = (id) => {
    setSelectedId(id);
    setFiles([]);
    setUploadModalOpen(true);
  };

  const confirmUpload = () => {
    if (!selectedId) return;

    const fd = new FormData();
    fd.append("id", selectedId);
    for (const f of files) fd.append("files", f);
    fd.append("action", "upload");

    submittingRef.current = true;
    submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  const openResendModal = (id) => {
    setSelectedId(id);
    setResendModalOpen(true);
  };

  const confirmResend = () => {
    if (!selectedId) return;

    const fd = new FormData();
    fd.append("id", selectedId);
    fd.append("action", "resendEmail");

    submittingRef.current = true;
    submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  const openImages = (images, startIndex = 0) => {
    setViewerImages(images);
    setViewerIndex(Math.min(Math.max(startIndex, 0), Math.max(images.length - 1, 0)));
    setViewerOpen(true);
  };

  const selectedRecord = useMemo(
    () => (selectedId ? verifications.find((v) => v.id === selectedId) : undefined),
    [selectedId, verifications]
  );

  const defaultEmailSubject = useMemo(() => {
    if (!selectedRecord) return "Message";
    const locale =
      (selectedRecord.customer_locale?.startsWith("zh") || selectedRecord.shipping_country === "CN")
        ? "zh-CN"
        : "en";
    const holdNums = holdOrderNumbers(selectedRecord.orders).join(", ");
    return locale === "zh-CN" ? `訂單 ${holdNums} 讯息` : `Message for order ${holdNums}`;
  }, [selectedRecord]);

  const shouldShowDenyFlow =
    formState.status === VerificationStatus.DENIED ||
    formState.status === VerificationStatus.PENDING_SUBMISSION;

  return (
    <>
      {/* Status modal */}
      <Modal
        open={statusModalOpen}
        onClose={() => setStatusModalOpen(false)}
        title={formState.status ? `Mark as ${formState.status}?` : "Update status"}
        primaryAction={{
          content: "Confirm",
          onAction: confirmStatus,
          disabled: isBusy,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setStatusModalOpen(false),
            disabled: isBusy,
          },
        ]}
      >
        <Modal.Section>
          {isBusy ? (
            <InlineStack align="center">
              <Spinner accessibilityLabel="Submitting..." />
            </InlineStack>
          ) : (
            <BlockStack gap="400">
              {shouldShowDenyFlow ? (
                <>
                  <ChoiceList
                    allowMultiple={false}
                    title="Choice of deny"
                    choices={[
                      {
                        label: "Cancel Orders",
                        value: VerificationStatus.DENIED,
                        helpText: "This action will cancel all associated orders with same credit card.",
                      },
                      ...(allowResubmit
                        ? [
                            {
                              label: "Require customer to resubmit",
                              value: VerificationStatus.PENDING_SUBMISSION,
                              helpText:
                                "This action will resend the email and require the user to resubmit their credit card photo.",
                            },
                          ]
                        : []),
                    ]}
                    selected={formState.status ? [formState.status] : []}
                    onChange={(val) => setFormState((s) => ({ ...s, status: val[0] }))}
                  />

                  <TextField
                    label="Internal Notes"
                    value={formState.internalNotes || ""}
                    onChange={(val) => setFormState((s) => ({ ...s, internalNotes: val }))}
                    multiline={3}
                    autoComplete="off"
                  />

                  <Checkbox
                    label={
                      formState.status === VerificationStatus.DENIED ? "Notify Customer" : "Custom Message"
                    }
                    checked={!!formState.notifyCustomer}
                    onChange={(checked) => {
                      if (!checked) {
                        setFormState((s) => ({ ...s, notifyCustomer: null }));
                        return;
                      }
                      setFormState((s) => ({
                        ...s,
                        notifyCustomer: {
                          subject: defaultEmailSubject,
                          message: "",
                        },
                      }));
                    }}
                  />

                  {formState.notifyCustomer ? (
                    <Box padding="400" borderColor="border" borderWidth="025">
                      <BlockStack gap="300">
                        <TextField
                          label="Message"
                          value={formState.notifyCustomer.message}
                          onChange={(val) =>
                            setFormState((s) => ({
                              ...s,
                              notifyCustomer: { ...(s.notifyCustomer || {}), message: val },
                            }))
                          }
                          autoComplete="off"
                          multiline={3}
                        />
                      </BlockStack>
                    </Box>
                  ) : null}
                </>
              ) : null}

              {formState.status === VerificationStatus.APPROVED ? (
                <Text as="p">This action will release all associated orders currently on hold.</Text>
              ) : null}
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>

      {/* Upload modal */}
      <Modal
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        title={selectedId ? `Upload photo for ${selectedId}?` : "Upload photo"}
        primaryAction={{
          content: "Confirm",
          onAction: confirmUpload,
          disabled: isBusy || !selectedId,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setUploadModalOpen(false),
            disabled: isBusy,
          },
        ]}
      >
        <Modal.Section>
          {isBusy ? (
            <InlineStack align="center">
              <Spinner accessibilityLabel="Uploading..." />
            </InlineStack>
          ) : (
            <DropZoneArea files={files} setFiles={setFiles} />
          )}
        </Modal.Section>
      </Modal>

      {/* Resend email modal */}
      <Modal
        open={resendModalOpen}
        onClose={() => setResendModalOpen(false)}
        title={selectedId ? `Resend email for ${selectedId}?` : "Resend email"}
        primaryAction={{
          content: "Confirm",
          onAction: confirmResend,
          disabled: isBusy || !selectedId,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setResendModalOpen(false),
            disabled: isBusy,
          },
        ]}
      >
        <Modal.Section>
          {isBusy ? (
            <InlineStack align="center">
              <Spinner accessibilityLabel="Resending..." />
            </InlineStack>
          ) : (
            <Text as="p">Resend the credit card verification request email to customer.</Text>
          )}
        </Modal.Section>
      </Modal>

      {/* Image viewer modal */}
      <Modal
        open={viewerOpen}
        onClose={() => {
          setViewerOpen(false);
          setViewerImages([]);
          setViewerIndex(0);
        }}
        title={`Photos (${viewerImages.length ? viewerIndex + 1 : 0}/${viewerImages.length})`}
        primaryAction={
          viewerImages.length > 0
            ? {
                content: "Next",
                onAction: () => setViewerIndex((i) => Math.min(i + 1, viewerImages.length - 1)),
                disabled: viewerIndex >= viewerImages.length - 1,
              }
            : undefined
        }
        secondaryActions={[
          ...(viewerImages.length > 0
            ? [
                {
                  content: "Previous",
                  onAction: () => setViewerIndex((i) => Math.max(i - 1, 0)),
                  disabled: viewerIndex <= 0,
                },
              ]
            : []),
          { content: "Close", onAction: () => setViewerOpen(false) },
        ]}
      >
        <Modal.Section>
          {viewerImages[viewerIndex] ? (
            <Box>
              {/* eslint-disable-next-line jsx-a11y/alt-text */}
              <img
                src={viewerImages[viewerIndex]}
                style={{ maxWidth: "100%", maxHeight: "70vh", display: "block", margin: "0 auto" }}
              />
            </Box>
          ) : (
            <Text as="p" tone="subdued">
              No images
            </Text>
          )}
        </Modal.Section>
      </Modal>

      {/* Filters */}
      <IndexFilters
        tabs={tabs}
        selected={selectedTab}
        onSelect={setSelectedTab}
        queryValue={queryValue}
        queryPlaceholder="Searching in customer email, credit card..."
        onQueryChange={setQueryValue}
        onQueryClear={() => setQueryValue("")}
        mode={mode}
        setMode={setMode}
        filters={filters}
        appliedFilters={appliedFilters}
        onClearAll={handleFiltersClearAll}
      />

      {/* Table */}
      <IndexTable
        condensed={useBreakpoints().smDown}
        resourceName={{ singular: "Verification Request", plural: "Verification Requests" }}
        itemCount={verifications.length}
        selectable={false}
        loading={isDebouncing}
        headings={[
          { title: "Customer" },
          { title: "Credit Card No." },
          { title: "Bank Info" },
          { title: "Request Date" },
          { title: "No. of Days" },
          { title: "Reminded" },
          { title: "Pics Proof" },
          { title: "Submission time" },
          { title: "Status" },
          { title: "Risk" },
          { title: "Note", alignment: "center" },
          { title: "Orders" },
          { title: "Actions" },
        ]}
      >
        {verifications.map((request, idx) => (
          <VRTableRow
            key={request.id}
            request={request}
            position={idx}
            onOpenImages={openImages}
            onUpload={openUploadModal}
            onResendEmail={openResendModal}
            onSelectStatus={openStatusModal}
          />
        ))}
      </IndexTable>

      {/* Pagination */}
      <Box padding="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" variant="bodySm" tone="subdued">
            Page {page} of {totalPages} • {totalCount} total
          </Text>

          <Pagination
            hasPrevious={page > 1}
            onPrevious={() => onSearch(queryValue, recordStatus || "All", page - 1)}
            hasNext={page < totalPages}
            onNext={() => onSearch(queryValue, recordStatus || "All", page + 1)}
          />
        </InlineStack>
      </Box>
    </>
  );
}

export default function VerificationsRoute() {
  const { verifications, totalCount, page, query, status } = useLoaderData();

  const actionData = useActionData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!actionData?.message) return;
    // If you have app-bridge toast wired:
    // window.shopify?.toast?.show(actionData.message, { isError: !actionData.success, duration: 5000 });
  }, [actionData]);

  const handleSearch = useCallback(
    (q, s, p = 1) => {
      const params = new URLSearchParams();
      params.set("status", s || "All");
      params.set("page", String(p));
      if (q) params.set("query", q);
      navigate(`/app/credit-card-verifications?${params.toString()}`);
    },
    [navigate]
  );

  return (
    <Page
      fullWidth
      title="Verification Records"
      secondaryActions={[
        {
          content: "Request Order Verification",
          onAction: () => navigate("/app/new-verification"),
        },
        {
          content: "Refresh",
          onAction: () => revalidator.revalidate(),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <VRTable
              verifications={verifications}
              totalCount={totalCount}
              page={page}
              query={query}
              status={status}
              onSearch={handleSearch}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
