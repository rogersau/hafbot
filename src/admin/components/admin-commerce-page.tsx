import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import type { CommerceOfferingDashboard } from "../../commerce/offering-service";
import type { CommerceControlType } from "../../commerce/safeguards";
import type { CommerceLoaderData } from "../lib/admin-route-loaders";
import { createAdminLoaderClient } from "../lib/admin-loader-client";
import { parseAdminApiError } from "../lib/api";
import { buildCommerceTabHref, type CommerceTab } from "../lib/admin-route-state";
import { useAdminRouteContext } from "../routes/page-context";
import { AdminTabs } from "./admin-tabs";
import { AdminPageHeader } from "./admin-page-header";
import type { CommerceSupportForm } from "./admin-commerce-support-settings";
import type { CommerceBrandingDraft } from "./admin-commerce-branding-settings";
import { NavigationGuard } from "./navigation-guard";
import { UnsavedChangesIndicator } from "./unsaved-changes-indicator";
import { FormField, SectionHeader, SettingsBlock } from "./admin-form-layout";
import { NoGuildSelected } from "./no-guild-selected";
import { PageFeedback } from "./page-feedback";
import { useToast } from "./toast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useConfirmDialog } from "./ui/confirm-dialog";
import { Input } from "./ui/input";
import { ResponsiveTable, type ResponsiveTableColumn } from "./ui/responsive-table";
import { Textarea } from "./ui/textarea";

type OfferingRow = CommerceOfferingDashboard["offerings"][number];

interface DraftForm {
  name: string;
  description: string;
  benefits: string;
  discordRoleId: string;
  currency: "AUD" | "USD";
  amount: string;
  recurringInterval: "month" | "year";
}

interface OfferingEditForm {
  offeringId: string;
  name: string;
  description: string;
  benefits: string;
  discordRoleId: string;
  currency: "AUD" | "USD";
  amount: string;
  recurringInterval: "month" | "year";
}

interface SellerOnboardingForm {
  supportContact: string;
  twoFactorEvidence: "discord_verified" | "seller_attested";
  adultAttested: boolean;
  termsAccepted: boolean;
  sellerAcknowledged: boolean;
  feesAcknowledged: boolean;
}

const EMPTY_DRAFT: DraftForm = {
  name: "",
  description: "",
  benefits: "",
  discordRoleId: "",
  currency: "AUD",
  amount: "5.00",
  recurringInterval: "month",
};

const AdminCommerceBrandingSettings = lazy(() => import("./admin-commerce-branding-settings"));
const AdminCommerceSalesPanelSettings = lazy(() => import("./admin-commerce-sales-panel-settings"));
const AdminCommerceGameAccess = lazy(() => import("./admin-commerce-game-access"));
const AdminCommerceSafetySettings = lazy(() => import("./admin-commerce-safety-settings"));
const AdminCommerceSupportSettings = lazy(() => import("./admin-commerce-support-settings"));

const COMMERCE_TABS: Array<{ id: CommerceTab; label: string }> = [
  { id: "offerings", label: "Offerings" },
  { id: "storefront", label: "Storefront" },
  { id: "support", label: "Support payments" },
  { id: "seller", label: "Seller & finance" },
  { id: "safety", label: "Safety" },
];

export function isCommerceTabOnlyNavigation({
  current,
  next,
}: {
  current: unknown;
  next: unknown;
}) {
  const from = current as { pathname?: string; search?: Record<string, unknown> };
  const to = next as { pathname?: string; search?: Record<string, unknown> };
  if (!from.pathname || from.pathname !== to.pathname) return false;
  const withoutTab = (search: Record<string, unknown> = {}) =>
    Object.entries(search)
      .filter(([key]) => key !== "tab")
      .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(withoutTab(from.search)) === JSON.stringify(withoutTab(to.search));
}

export function AdminCommercePage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: CommerceLoaderData | null;
}) {
  const { commerceTab, currentSearch } = useAdminRouteContext();
  const activeTab =
    initialData && !initialData.dashboard?.seller && !new URLSearchParams(currentSearch).has("tab")
      ? "seller"
      : commerceTab;
  const navigate = useNavigate();
  const trimmedGuildId = selectedGuildId.trim();

  function handleTabChange(nextTab: CommerceTab) {
    if (typeof window === "undefined") return;
    if (
      window.location.pathname.replace(/\/$/, "") !==
      `/admin/${encodeURIComponent(trimmedGuildId)}/commerce`
    )
      return;
    void navigate({
      href: buildCommerceTabHref(`${window.location.pathname}${window.location.search}`, nextTab),
    });
  }

  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="Commerce"
        description="Configure paid Discord roles and monitor seller operations."
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
      />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="commerce" />
      ) : (
        <CommerceDashboard
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={trimmedGuildId}
          initialData={initialData ?? null}
          activeTab={activeTab}
          onTabChange={handleTabChange}
        />
      )}
    </section>
  );
}

function CommerceDashboard({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  activeTab,
  onTabChange,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData: CommerceLoaderData | null;
  activeTab: CommerceTab;
  onTabChange: (tab: CommerceTab) => void;
}) {
  const [data, setData] = useState(initialData);
  const [branding, setBranding] = useState<CommerceBrandingDraft>(() => ({
    accentColor: initialData?.branding?.accentColor ?? 0x5865f2,
    tagline: initialData?.branding?.tagline ?? "",
  }));
  const [panelTitle, setPanelTitle] = useState(initialData?.salesPanel?.title ?? "");
  const [panelDescription, setPanelDescription] = useState(
    initialData?.salesPanel?.description ?? "",
  );
  const [panelChannelId, setPanelChannelId] = useState(
    initialData?.salesPanel?.channelId ?? initialData?.panelChannels?.[0]?.id ?? "",
  );
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editing, setEditing] = useState<OfferingEditForm | null>(null);
  const [support, setSupport] = useState<CommerceSupportForm>(() => ({
    enabled: initialData?.support?.config.enabled ?? false,
    explanation:
      initialData?.support?.config.explanation ??
      "Helps cover the ongoing tools and services used to operate this community.",
    currency: initialData?.support?.config.currency ?? "AUD",
    suggestedAmounts: (initialData?.support?.config.suggestedAmountsMinor ?? [500, 1_000, 2_000])
      .map((amount) => (amount / 100).toFixed(2))
      .join(", "),
    supportContact:
      initialData?.support?.config.supportContact ??
      initialData?.sellerProfile?.supportContact ??
      "",
  }));
  const [onboarding, setOnboarding] = useState<SellerOnboardingForm>(() => ({
    supportContact:
      initialData?.sellerProfile?.supportContact ??
      initialData?.sellerSuggestedSupportContact ??
      "",
    twoFactorEvidence: "seller_attested",
    adultAttested: false,
    termsAccepted: false,
    sellerAcknowledged: false,
    feesAcknowledged: false,
  }));
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const toast = useToast();
  const { dialog, confirm } = useConfirmDialog();
  const client = useMemo(() => createAdminLoaderClient(), []);
  const retryKeys = useRef(new Map<string, string>());

  // Stripe returns through a browser URL, so synchronizing that external state requires an effect.
  // oxlint-disable-next-line custom/no-use-effect
  useEffect(() => {
    const url = new URL(window.location.href);
    const connectState = url.searchParams.get("commerceConnect");
    if (connectState !== "return" && connectState !== "refresh") return;
    url.searchParams.delete("commerceConnect");
    window.history.replaceState(window.history.state, "", url);
    if (connectState === "refresh") {
      setMessage("Your Stripe onboarding link expired. Confirm the seller details to continue.");
      return;
    }

    setBusyAction("seller:refresh");
    setError(null);
    void client
      .postJson(
        "/admin/api/commerce/seller/refresh",
        {},
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      )
      .then(() =>
        client.getJson<CommerceLoaderData>("/admin/api/commerce", {
          workspaceId: selectedWorkspaceId,
          guildId: selectedGuildId,
        }),
      )
      .then((next) => {
        setData(next);
        setMessage("Stripe onboarding status refreshed.");
        toast.success("Stripe onboarding status refreshed.");
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : "Could not refresh Stripe status.";
        setError(detail);
        toast.error(detail);
      })
      .finally(() => setBusyAction(null));
  }, [client, selectedGuildId, selectedWorkspaceId, toast]);

  async function refresh() {
    const next = await client.getJson<CommerceLoaderData>("/admin/api/commerce", {
      workspaceId: selectedWorkspaceId,
      guildId: selectedGuildId,
    });
    setData(next);
  }

  async function mutate(
    action: string,
    path: string,
    body: Record<string, unknown> = {},
    success = "Commerce settings updated.",
    durableAction = false,
  ): Promise<boolean> {
    setBusyAction(action);
    setError(null);
    setMessage(null);
    const idempotencyKey = durableAction
      ? (retryKeys.current.get(action) ?? crypto.randomUUID())
      : undefined;
    if (idempotencyKey) retryKeys.current.set(action, idempotencyKey);
    try {
      if (idempotencyKey) {
        const response = await fetch(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            ...body,
            workspaceId: selectedWorkspaceId,
            guildId: selectedGuildId,
          }),
        });
        if (!response.ok) {
          throw await parseAdminApiError(response, `${response.status} ${response.statusText}`);
        }
      } else {
        await client.postJson(path, body, {
          workspaceId: selectedWorkspaceId,
          guildId: selectedGuildId,
        });
      }
      retryKeys.current.delete(action);
      await refresh();
      setMessage(success);
      toast.success(success);
      return true;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Commerce update failed.";
      setError(detail);
      toast.error(detail);
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function createDraft() {
    const amount = Number.parseFloat(draft.amount);
    const includedBenefits = draft.benefits
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!Number.isFinite(amount) || amount < 5) {
      setError("The pilot minimum is A$5.00 or US$5.00.");
      return;
    }
    if (includedBenefits.length === 0) {
      setError("Add at least one included benefit.");
      return;
    }
    const created = await mutate(
      "create",
      "/admin/api/commerce/offerings",
      {
        name: draft.name,
        description: draft.description || null,
        includedBenefits,
        discordRoleId: draft.discordRoleId,
        currency: draft.currency,
        unitAmountMinor: Math.round(amount * 100),
        recurringInterval: draft.recurringInterval,
      },
      "Offering draft created.",
    );
    if (created) {
      setDraft(EMPTY_DRAFT);
      setShowCreateForm(false);
    }
  }

  async function transition(
    row: OfferingRow,
    action: "publish" | "unpublish" | "retire" | "archive",
  ) {
    if (action === "retire") {
      const accepted = await confirm({
        title: `Retire ${row.offering.name}?`,
        description:
          "New purchases will stop and every current subscription will be scheduled to cancel at the end of its paid period.",
        confirmLabel: "Retire offering",
        variant: "destructive",
      });
      if (!accepted) return;
    }
    if (action === "unpublish") {
      const accepted = await confirm({
        title: `Make ${row.offering.name} unavailable?`,
        description:
          "New purchases will stop. Existing subscriptions and paid role access will continue.",
        confirmLabel: "Make unavailable",
      });
      if (!accepted) return;
    }
    await mutate(
      `${action}:${row.offering.id}`,
      `/admin/api/commerce/offerings/${action}`,
      {
        offeringId: row.offering.id,
        ...(action === "retire" ? { reasonCode: "seller_requested" } : {}),
      },
      action === "publish"
        ? "Offering made available."
        : action === "unpublish"
          ? "Offering made unavailable."
          : action === "archive"
            ? "Offering archived."
            : "Offering retired.",
      action === "retire",
    );
  }

  async function publishSalesPanel(title: string, description: string) {
    if (!panelChannelId) {
      setError("Select a Discord text channel for the sales panel.");
      return;
    }
    const refreshing = Boolean(data?.salesPanel?.messageId);
    await mutate(
      refreshing ? "sales-panel:refresh" : "sales-panel:publish",
      refreshing ? "/admin/api/commerce/panel/refresh" : "/admin/api/commerce/panel/publish",
      { channelId: panelChannelId, title, description },
      refreshing ? "Sales panel updated." : "Sales panel published.",
    );
  }

  async function unpublishSalesPanel() {
    const accepted = await confirm({
      title: "Remove the sales panel?",
      description:
        "The canonical HAF Bot sales message will be deleted. Your offerings and existing buyer access will not be changed.",
      confirmLabel: "Remove sales panel",
      variant: "destructive",
    });
    if (!accepted) return;
    await mutate(
      "sales-panel:unpublish",
      "/admin/api/commerce/panel/unpublish",
      {},
      "Sales panel removed.",
    );
  }

  function beginEdit(row: OfferingRow) {
    const price = row.activePrices[0];
    setEditing({
      offeringId: row.offering.id,
      name: row.offering.name,
      description: row.offering.description ?? "",
      benefits: row.offering.includedBenefits.join("\n"),
      discordRoleId: row.offering.discordRoleId,
      currency: price?.currency ?? "AUD",
      amount: price ? (price.unitAmountMinor / 100).toFixed(2) : "5.00",
      recurringInterval: price?.recurringInterval === "year" ? "year" : "month",
    });
  }

  async function saveOfferingEdits() {
    if (!editing) return;
    const includedBenefits = editing.benefits
      .split("\n")
      .map((benefit) => benefit.trim())
      .filter(Boolean);
    await mutate(
      `edit:${editing.offeringId}`,
      "/admin/api/commerce/offerings/edit",
      {
        offeringId: editing.offeringId,
        name: editing.name,
        description: editing.description || null,
        includedBenefits,
        discordRoleId: editing.discordRoleId,
      },
      "Offering details updated.",
    );
    setEditing(null);
  }

  async function replaceOfferingPrice() {
    if (!editing) return;
    const amount = Number.parseFloat(editing.amount);
    if (!Number.isFinite(amount) || amount < 5) {
      setError("The pilot minimum is A$5.00 or US$5.00.");
      return;
    }
    const accepted = await confirm({
      title: "Create a replacement price?",
      description:
        "Only new buyers will use this price. Existing subscribers remain grandfathered on their current Stripe Price.",
      confirmLabel: "Replace price",
    });
    if (!accepted) return;
    await mutate(
      `price:${editing.offeringId}`,
      "/admin/api/commerce/offerings/replace-price",
      {
        offeringId: editing.offeringId,
        currency: editing.currency,
        unitAmountMinor: Math.round(amount * 100),
        recurringInterval: editing.recurringInterval,
      },
      "New price created for future buyers.",
    );
    setEditing(null);
  }

  async function openStripe() {
    setBusyAction("stripe");
    try {
      const result = await client.postJson<{ url: string }>(
        "/admin/api/commerce/seller/stripe-dashboard",
        {},
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      window.location.assign(result.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open Stripe.");
      setBusyAction(null);
    }
  }

  async function connectSeller() {
    if (onboarding.supportContact.trim().length < 3) {
      setError("Enter a seller support contact.");
      return;
    }
    if (
      !onboarding.adultAttested ||
      !onboarding.termsAccepted ||
      !onboarding.sellerAcknowledged ||
      !onboarding.feesAcknowledged
    ) {
      setError("Confirm every seller acknowledgement before continuing to Stripe.");
      return;
    }
    setBusyAction("seller:connect");
    setError(null);
    try {
      const result = await client.postJson<{ onboardingUrl: string }>(
        "/admin/api/commerce/seller/connect",
        onboarding,
        { workspaceId: selectedWorkspaceId, guildId: selectedGuildId },
      );
      window.location.assign(result.onboardingUrl);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Could not start Stripe onboarding.";
      setError(detail);
      toast.error(detail);
      setBusyAction(null);
    }
  }

  async function saveSupport() {
    const suggestedAmountsMinor = support.suggestedAmounts
      .split(",")
      .map((value) => Math.round(Number.parseFloat(value.trim()) * 100))
      .filter((value) => Number.isSafeInteger(value));
    if (
      suggestedAmountsMinor.length < 1 ||
      suggestedAmountsMinor.length > 3 ||
      suggestedAmountsMinor.some((amount) => amount < 200 || amount > 50_000 || amount % 20 !== 0)
    ) {
      setError("Enter one to three amounts from 2.00 to 500.00 in exact 0.20 increments.");
      return;
    }
    await mutate(
      "support",
      "/admin/api/commerce/support",
      {
        enabled: support.enabled,
        explanation: support.explanation,
        currency: support.currency,
        suggestedAmountsMinor,
        supportContact: support.supportContact,
      },
      "Community support settings updated.",
    );
  }

  async function startOffboarding() {
    const accepted = await confirm({
      title: "Start seller offboarding?",
      description:
        "New purchases and support payments will stop immediately. Active subscriptions will cancel at period end and buyers keep access through their paid period.",
      confirmLabel: "Start offboarding",
      variant: "destructive",
    });
    if (!accepted) return;
    await mutate(
      "offboarding:start",
      "/admin/api/commerce/offboarding/start",
      { reasonCode: "seller_requested" },
      "Offboarding started. Disconnection will remain blocked until subscriptions end.",
      true,
    );
  }

  async function completeOffboarding() {
    const accepted = await confirm({
      title: "Disconnect the Stripe seller?",
      description:
        "This archives Commerce offerings and disconnects the Stripe account. Financial and audit history is retained.",
      confirmLabel: "Disconnect seller",
      variant: "destructive",
    });
    if (!accepted) return;
    await mutate(
      "offboarding:complete",
      "/admin/api/commerce/offboarding/complete",
      { reasonCode: "seller_requested" },
      "Seller disconnected and Commerce records archived.",
      true,
    );
  }

  async function setSafeguard(controlType: CommerceControlType, enabled: boolean) {
    if (enabled && controlType === "renewal_shutdown") {
      const accepted = await confirm({
        title: "Stop all subscription renewals?",
        description:
          "New purchases will stop and every active subscription will be scheduled to cancel at period end. Already-paid access remains active.",
        confirmLabel: "Stop renewals",
        variant: "destructive",
      });
      if (!accepted) return;
    }
    await mutate(
      `safeguard:${controlType}:${enabled}`,
      "/admin/api/commerce/safeguards/control",
      {
        scopeType: "guild",
        controlType,
        enabled,
        reasonCode: "seller_safety_control",
      },
      enabled ? "Commerce safeguard enabled." : "Commerce safeguard disabled.",
      enabled && (controlType === "renewal_shutdown" || controlType === "commerce_kill"),
    );
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">Commerce dashboard is not loaded.</p>;
  }

  const seller = data.dashboard?.seller ?? null;
  const hasStorefrontChanges =
    branding.accentColor !== (data.branding?.accentColor ?? 0x5865f2) ||
    branding.tagline.trim() !== (data.branding?.tagline ?? "") ||
    panelTitle.trim() !== (data.salesPanel?.title ?? "") ||
    panelDescription.trim() !== (data.salesPanel?.description ?? "") ||
    panelChannelId !== (data.salesPanel?.channelId ?? data.panelChannels?.[0]?.id ?? "");
  const rows = data.dashboard?.offerings ?? [];
  const publishedCount = rows.filter((row) => row.offering.state === "published").length;
  const salesBlockReasons = data.safeguards?.blockReasons ?? [];
  const operationalIssueCount = rows.reduce(
    (count, row) => count + row.roleFailures + row.reconciliationIncidents,
    0,
  );
  const sellerReady = Boolean(
    seller?.status === "active" &&
    seller?.detailsSubmitted &&
    seller?.chargesEnabled &&
    seller?.payoutsEnabled &&
    data.sellerProfile?.lifecycleState === "active" &&
    data.sellerProfile?.approvalState === "approved",
  );
  const salesStatus = !seller
    ? "Setup required"
    : salesBlockReasons.length > 0
      ? "Paused"
      : sellerReady
        ? "Accepting sales"
        : "Action required";
  const attentionStatus = !seller
    ? "Seller setup"
    : salesBlockReasons.length > 0
      ? `${salesBlockReasons.length} sales block${salesBlockReasons.length === 1 ? "" : "s"}`
      : operationalIssueCount > 0
        ? `${operationalIssueCount} issue${operationalIssueCount === 1 ? "" : "s"}`
        : sellerReady
          ? "All clear"
          : "Account action required";
  const columns: ResponsiveTableColumn<OfferingRow>[] = [
    {
      header: "Offering",
      cell: (row) => (
        <div>
          <p className="font-medium">{row.offering.name}</p>
          <p className="text-xs text-muted-foreground">
            Role {roleName(data, row.offering.discordRoleId)}
          </p>
        </div>
      ),
    },
    {
      header: "State",
      cell: (row) => <LifecycleBadge state={row.offering.state} />,
    },
    {
      header: "Retirement",
      cell: (row) => <RetirementProgress progress={row.retirement} />,
    },
    {
      header: "Price",
      cell: (row) => {
        const price = row.activePrices[0];
        return price
          ? `${formatMoney(price.unitAmountMinor, price.currency)} / ${price.recurringInterval}`
          : "No active price";
      },
    },
    {
      header: "Subscribers",
      cell: (row) =>
        `${row.subscribers.active} active · ${row.subscribers.canceling} canceling · ${row.subscribers.pastDue} past due`,
    },
    {
      header: "Operations",
      cell: (row) => (
        <span
          className={row.roleFailures + row.reconciliationIncidents > 0 ? "text-destructive" : ""}
        >
          {row.roleFailures} delivery · {row.reconciliationIncidents} reconciliation
        </span>
      ),
    },
    {
      header: "Actions",
      cell: (row) => (
        <div className="flex flex-wrap gap-2">
          {["draft", "unpublished", "repair_required"].includes(row.offering.state) ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => beginEdit(row)}
                disabled={Boolean(busyAction)}
              >
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void transition(row, "publish")}
                disabled={Boolean(busyAction)}
              >
                Make available
              </Button>
            </>
          ) : null}
          {row.offering.state === "published" ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void transition(row, "unpublish")}
              disabled={Boolean(busyAction)}
            >
              Make unavailable
            </Button>
          ) : null}
          {["published", "unpublished", "suspended"].includes(row.offering.state) ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => void transition(row, "retire")}
              disabled={Boolean(busyAction)}
            >
              Retire
            </Button>
          ) : null}
          {canArchive(row) ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void transition(row, "archive")}
              disabled={Boolean(busyAction)}
            >
              Archive
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageFeedback message={message} error={error} />
      <SettingsBlock className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Commerce status
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Review seller readiness and any urgent operational issues before making changes.
            </p>
          </div>
          {seller && data.sellerOwner && data.stripeDashboardAvailable ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void openStripe()}
              disabled={Boolean(busyAction)}
            >
              Open Stripe Dashboard
            </Button>
          ) : null}
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Seller"
            value={data.sellerProfile?.lifecycleState ?? seller?.status ?? "Not connected"}
          />
          <Metric label="Sales" value={salesStatus} />
          <Metric
            label="Offerings"
            value={`${publishedCount} / ${data.activeOfferingLimit} published`}
          />
          <Metric label="Attention" value={attentionStatus} />
        </div>
        {salesBlockReasons.length > 0 ? (
          <p className="text-sm text-destructive" role="status">
            Sales are paused: {salesBlockReasons.join(", ")}
          </p>
        ) : null}
      </SettingsBlock>

      <NavigationGuard
        hasChanges={hasStorefrontChanges}
        allowNavigation={isCommerceTabOnlyNavigation}
      />
      <AdminTabs
        tabs={COMMERCE_TABS}
        activeTab={activeTab}
        ariaLabel="Commerce settings"
        className="commerce-tabs -mt-4 bg-background md:-mt-7"
        onTabChange={onTabChange}
      />

      <UnsavedChangesIndicator hasChanges={hasStorefrontChanges} />

      <div
        role="tabpanel"
        aria-label={`${COMMERCE_TABS.find((tab) => tab.id === activeTab)?.label ?? "Commerce"} settings`}
        className="space-y-5"
      >
        {activeTab === "seller" ? (
          <SettingsBlock>
            <SectionHeader
              title="Seller account"
              description="Your guild is the merchant of record. Stripe holds funds and is authoritative for balances, payouts, bank details, and dispute evidence."
            />
            {!seller ? (
              <p className="text-sm text-muted-foreground">
                No connected seller account is available for this guild. The verified Guild owner
                can connect a seller account below.
              </p>
            ) : null}
            {data.sellerOnboardingAvailable &&
            data.sellerOwner &&
            (!seller || !seller.detailsSubmitted) ? (
              <div className="grid gap-4 rounded-[3px] border border-border bg-muted/20 p-4">
                <div>
                  <h3 className="text-sm font-semibold">
                    {seller ? "Continue Stripe onboarding" : "Connect a Stripe seller account"}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Only the current Discord Guild owner can connect the account. Stripe collects
                    and stores identity, bank, payout, and tax details.
                  </p>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField
                    label="Seller support contact"
                    htmlFor="commerce-seller-support"
                    hint="Shown to buyers for support and refund questions."
                    required
                  >
                    <Input
                      id="commerce-seller-support"
                      value={onboarding.supportContact}
                      maxLength={320}
                      placeholder="seller@example.com"
                      onChange={(event) =>
                        setOnboarding({ ...onboarding, supportContact: event.target.value })
                      }
                    />
                  </FormField>
                  <FormField label="Two-factor evidence" htmlFor="commerce-seller-2fa" required>
                    <select
                      id="commerce-seller-2fa"
                      className="h-9 w-full rounded-[3px] border border-input bg-background px-3 text-sm"
                      value={onboarding.twoFactorEvidence}
                      onChange={(event) =>
                        setOnboarding({
                          ...onboarding,
                          twoFactorEvidence:
                            event.target.value === "discord_verified"
                              ? "discord_verified"
                              : "seller_attested",
                        })
                      }
                    >
                      <option value="seller_attested">I attest 2FA is enabled</option>
                      <option value="discord_verified">Verified through Discord</option>
                    </select>
                  </FormField>
                </div>
                <div className="grid gap-2 text-sm">
                  <SellerAcknowledgement
                    id="commerce-seller-adult"
                    checked={onboarding.adultAttested}
                    onChange={(checked) => setOnboarding({ ...onboarding, adultAttested: checked })}
                  >
                    I am at least 18 years old and authorised to operate this seller account.
                  </SellerAcknowledgement>
                  <SellerAcknowledgement
                    id="commerce-seller-owner"
                    checked={onboarding.sellerAcknowledged}
                    onChange={(checked) =>
                      setOnboarding({ ...onboarding, sellerAcknowledged: checked })
                    }
                  >
                    I acknowledge that the Discord Guild owner is the accountable seller.
                  </SellerAcknowledgement>
                  <SellerAcknowledgement
                    id="commerce-seller-fees"
                    checked={onboarding.feesAcknowledged}
                    onChange={(checked) =>
                      setOnboarding({ ...onboarding, feesAcknowledged: checked })
                    }
                  >
                    I acknowledge HAF's 5% fee and Stripe's separate processing fees.
                  </SellerAcknowledgement>
                  <SellerAcknowledgement
                    id="commerce-seller-terms"
                    checked={onboarding.termsAccepted}
                    onChange={(checked) => setOnboarding({ ...onboarding, termsAccepted: checked })}
                  >
                    I accept seller terms {data.currentTermsVersion}.
                  </SellerAcknowledgement>
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    onClick={() => void connectSeller()}
                    disabled={Boolean(busyAction)}
                  >
                    {busyAction === "seller:connect" ? "Opening Stripe…" : "Continue to Stripe"}
                  </Button>
                </div>
              </div>
            ) : null}
            {seller?.detailsSubmitted && data.sellerProfile?.approvalState === "pending" ? (
              <p
                className="rounded-[3px] border border-border bg-muted/20 p-3 text-sm"
                role="status"
              >
                Your seller application has been submitted and is being reviewed by HAF Bot. Sales
                stay disabled until it is approved.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              HAF charges 5% of each successful commerce payment. Stripe processing fees are
              separate. AUD and USD settle according to your Stripe account; bank or Stripe FX costs
              may apply. HAF does not estimate conversion proceeds.
            </p>
          </SettingsBlock>
        ) : null}

        {activeTab === "storefront" ? (
          <>
            <Suspense fallback={null}>
              <AdminCommerceBrandingSettings
                sellerConnected={Boolean(seller)}
                branding={branding}
                onChange={setBranding}
                busyAction={busyAction}
                onValidationError={setError}
                onReset={() =>
                  mutate(
                    "branding:reset",
                    "/admin/api/commerce/branding/reset",
                    {},
                    "Storefront branding reset.",
                  )
                }
                onSave={(accentColor, tagline) =>
                  mutate(
                    "branding",
                    "/admin/api/commerce/branding",
                    { accentColor, tagline },
                    "Storefront branding saved.",
                  )
                }
              />
            </Suspense>

            {seller ? (
              <Suspense fallback={null}>
                <AdminCommerceSalesPanelSettings
                  salesPanel={data.salesPanel}
                  panelChannels={data.panelChannels ?? []}
                  panelChannelId={panelChannelId}
                  panelTitle={panelTitle}
                  panelDescription={panelDescription}
                  busyAction={busyAction}
                  onTitleChange={setPanelTitle}
                  onDescriptionChange={setPanelDescription}
                  onChannelChange={setPanelChannelId}
                  onPublish={(title, description) => void publishSalesPanel(title, description)}
                  onUnpublish={() => void unpublishSalesPanel()}
                />
              </Suspense>
            ) : null}
          </>
        ) : null}

        {activeTab === "safety" && seller ? (
          <Suspense
            fallback={<p className="text-sm text-muted-foreground">Loading safety controls…</p>}
          >
            <AdminCommerceGameAccess
              guildId={selectedGuildId}
              workspaceId={selectedWorkspaceId}
              offerings={rows
                .filter((row) => row.offering.purchaseType === "subscription")
                .map((row) => ({ id: row.offering.id, name: row.offering.name }))}
            />
            <AdminCommerceSafetySettings
              safeguards={data.safeguards}
              busyAction={busyAction}
              onSetSafeguard={(controlType, enabled) => void setSafeguard(controlType, enabled)}
            />
          </Suspense>
        ) : null}

        {activeTab === "safety" && !seller ? (
          <SellerSetupRequired
            feature="safety controls"
            onOpenSeller={() => onTabChange("seller")}
          />
        ) : null}

        {activeTab === "seller" && seller ? <FinancialSummary rows={rows} /> : null}

        {activeTab === "seller" && seller ? (
          <SettingsBlock className="border-destructive/40">
            <SectionHeader
              title="Seller offboarding"
              description="Disconnect safely without ending buyer access before the paid-through date."
            />
            {data.offboarding ? (
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <Metric label="Status" value={data.offboarding.status.replaceAll("_", " ")} />
                <Metric
                  label="Active subscriptions"
                  value={String(data.offboarding.activeSubscriptionCount)}
                />
                <Metric
                  label="Latest paid through"
                  value={
                    data.offboarding.latestPaidThroughAtMs
                      ? new Date(data.offboarding.latestPaidThroughAtMs).toLocaleString()
                      : "None"
                  }
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Normal disconnection first stops new sales and schedules current subscriptions to
                cancel at period end.
              </p>
            )}
            <div className="flex justify-end gap-2">
              {!data.offboarding ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={Boolean(busyAction)}
                  onClick={() => void startOffboarding()}
                >
                  {busyAction === "offboarding:start" ? "Starting…" : "Start offboarding"}
                </Button>
              ) : data.offboarding.status !== "completed" ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={Boolean(busyAction) || data.offboarding.activeSubscriptionCount > 0}
                  onClick={() => void completeOffboarding()}
                >
                  {busyAction === "offboarding:complete"
                    ? "Disconnecting…"
                    : "Complete disconnection"}
                </Button>
              ) : null}
            </div>
          </SettingsBlock>
        ) : null}

        {activeTab === "support" && seller ? (
          <Suspense
            fallback={<p className="text-sm text-muted-foreground">Loading support payments…</p>}
          >
            <AdminCommerceSupportSettings
              support={support}
              supportReport={data.supportReport}
              busyAction={busyAction}
              onChange={setSupport}
              onSave={() => void saveSupport()}
            />
          </Suspense>
        ) : null}

        {activeTab === "support" && !seller ? (
          <SellerSetupRequired
            feature="support payments"
            onOpenSeller={() => onTabChange("seller")}
          />
        ) : null}

        {activeTab === "offerings" && seller && !showCreateForm ? (
          <div className="flex justify-end">
            <Button
              type="button"
              onClick={() => setShowCreateForm(true)}
              disabled={Boolean(busyAction)}
            >
              New offering
            </Button>
          </div>
        ) : null}

        {activeTab === "offerings" && seller && showCreateForm ? (
          <SettingsBlock>
            <SectionHeader
              title="New paid role"
              description="Prices are immutable. A later price change creates a new Stripe Price while existing subscribers remain grandfathered."
              actions={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCreateForm(false)}
                >
                  Cancel
                </Button>
              }
            />
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Name" htmlFor="commerce-name" required>
                <Input
                  id="commerce-name"
                  value={draft.name}
                  maxLength={100}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </FormField>
              <FormField label="Discord role" htmlFor="commerce-role" required>
                <select
                  id="commerce-role"
                  className="h-9 w-full rounded-[3px] border border-input bg-background px-3 text-sm"
                  value={draft.discordRoleId}
                  onChange={(event) => setDraft({ ...draft, discordRoleId: event.target.value })}
                >
                  <option value="">Select a manageable role</option>
                  {data.manageableRoles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Description" htmlFor="commerce-description">
                <Textarea
                  id="commerce-description"
                  value={draft.description}
                  maxLength={2_000}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </FormField>
              <FormField
                label="Included benefits"
                htmlFor="commerce-benefits"
                hint="Enter one buyer-facing benefit per line."
                required
              >
                <Textarea
                  id="commerce-benefits"
                  value={draft.benefits}
                  onChange={(event) => setDraft({ ...draft, benefits: event.target.value })}
                />
              </FormField>
              <FormField label="Currency" htmlFor="commerce-currency" required>
                <select
                  id="commerce-currency"
                  className="h-9 w-full rounded-[3px] border border-input bg-background px-3 text-sm"
                  value={draft.currency}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      currency: event.target.value === "USD" ? "USD" : "AUD",
                    })
                  }
                >
                  <option value="AUD">AUD</option>
                  <option value="USD">USD</option>
                </select>
              </FormField>
              <FormField
                label="Price"
                htmlFor="commerce-price"
                hint="Minimum 5.00 in the selected currency."
                required
              >
                <Input
                  id="commerce-price"
                  type="number"
                  min="5"
                  step="0.01"
                  value={draft.amount}
                  onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                />
              </FormField>
              <FormField label="Billing interval" htmlFor="commerce-interval" required>
                <select
                  id="commerce-interval"
                  className="h-9 w-full rounded-[3px] border border-input bg-background px-3 text-sm"
                  value={draft.recurringInterval}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      recurringInterval: event.target.value === "year" ? "year" : "month",
                    })
                  }
                >
                  <option value="month">Monthly</option>
                  <option value="year">Yearly</option>
                </select>
              </FormField>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => void createDraft()}
                disabled={
                  Boolean(busyAction) ||
                  !draft.name.trim() ||
                  !draft.discordRoleId ||
                  !draft.benefits.trim()
                }
              >
                {busyAction === "create" ? "Creating…" : "Create draft"}
              </Button>
            </div>
          </SettingsBlock>
        ) : null}

        {activeTab === "offerings" && !seller ? (
          <SellerSetupRequired
            feature="paid role offerings"
            onOpenSeller={() => onTabChange("seller")}
          />
        ) : null}

        {activeTab === "offerings" && seller ? (
          <SettingsBlock>
            <SectionHeader
              title="Offerings and subscribers"
              description="Manual role holders are not counted as paid subscribers. Repair and reconciliation failures require seller action."
            />
            <ResponsiveTable
              rows={rows}
              rowKey={(row) => row.offering.id}
              columns={columns}
              emptyMessage="No commerce offerings have been created."
            />
            {editing ? (
              <div className="space-y-4 rounded-[4px] border border-dashed p-4">
                <SectionHeader
                  title="Edit offering"
                  description="Details and role changes require an unpublished offering. Price replacement affects new buyers only."
                />
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField label="Name" htmlFor="commerce-edit-name" required>
                    <Input
                      id="commerce-edit-name"
                      value={editing.name}
                      onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Discord role" htmlFor="commerce-edit-role" required>
                    <select
                      id="commerce-edit-role"
                      className="h-9 w-full rounded-[3px] border border-input bg-background px-3 text-sm"
                      value={editing.discordRoleId}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          discordRoleId: event.target.value,
                        })
                      }
                    >
                      {data.manageableRoles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Description" htmlFor="commerce-edit-description">
                    <Textarea
                      id="commerce-edit-description"
                      value={editing.description}
                      onChange={(event) =>
                        setEditing({ ...editing, description: event.target.value })
                      }
                    />
                  </FormField>
                  <FormField label="Included benefits" htmlFor="commerce-edit-benefits" required>
                    <Textarea
                      id="commerce-edit-benefits"
                      value={editing.benefits}
                      onChange={(event) => setEditing({ ...editing, benefits: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Replacement currency" htmlFor="commerce-edit-currency">
                    <select
                      id="commerce-edit-currency"
                      className="h-9 w-full rounded-[3px] border border-input bg-background px-3 text-sm"
                      value={editing.currency}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          currency: event.target.value === "USD" ? "USD" : "AUD",
                        })
                      }
                    >
                      <option value="AUD">AUD</option>
                      <option value="USD">USD</option>
                    </select>
                  </FormField>
                  <FormField label="Replacement price" htmlFor="commerce-edit-price">
                    <Input
                      id="commerce-edit-price"
                      type="number"
                      min="5"
                      step="0.01"
                      value={editing.amount}
                      onChange={(event) => setEditing({ ...editing, amount: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Replacement interval" htmlFor="commerce-edit-interval">
                    <select
                      id="commerce-edit-interval"
                      className="h-9 w-full rounded-[3px] border border-input bg-background px-3 text-sm"
                      value={editing.recurringInterval}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          recurringInterval: event.target.value === "year" ? "year" : "month",
                        })
                      }
                    >
                      <option value="month">Monthly</option>
                      <option value="year">Yearly</option>
                    </select>
                  </FormField>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void replaceOfferingPrice()}
                    disabled={Boolean(busyAction)}
                  >
                    Replace price
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void saveOfferingEdits()}
                    disabled={
                      Boolean(busyAction) ||
                      !editing.name.trim() ||
                      !editing.discordRoleId ||
                      !editing.benefits.trim()
                    }
                  >
                    Save details
                  </Button>
                </div>
              </div>
            ) : null}
          </SettingsBlock>
        ) : null}
      </div>
      {dialog}
    </>
  );
}

function FinancialSummary({ rows }: { rows: OfferingRow[] }) {
  const totals = rows.reduce(
    (sum, row) => {
      for (const currency of ["AUD", "USD"] as const) {
        sum.gross[currency] += row.grossByCurrency[currency];
        sum.refunds[currency] += row.refundsByCurrency[currency];
        sum.disputes[currency] += row.disputesByCurrency[currency];
        sum.proceeds[currency] += row.estimatedProceedsByCurrency[currency];
      }
      return sum;
    },
    {
      gross: { AUD: 0, USD: 0 },
      refunds: { AUD: 0, USD: 0 },
      disputes: { AUD: 0, USD: 0 },
      proceeds: { AUD: 0, USD: 0 },
    },
  );
  return (
    <SettingsBlock>
      <SectionHeader
        title="Financial activity"
        description="Estimated proceeds are operational estimates only. Stripe Dashboard is authoritative for fees, balances, settlements, and payouts."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Gross" value={formatPair(totals.gross)} />
        <Metric
          label="HAF fee (5%)"
          value={formatPair({
            AUD: Math.round(totals.gross.AUD * 0.05),
            USD: Math.round(totals.gross.USD * 0.05),
          })}
        />
        <Metric
          label="Refunds / disputes"
          value={`${formatPair(totals.refunds)} / ${formatPair(totals.disputes)}`}
        />
        <Metric label="Estimated proceeds" value={formatPair(totals.proceeds)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Stripe fees appear in Stripe where exposed reliably. This dashboard is not a HAF wallet and
        does not provide withdrawals or an available payout balance.
      </p>
    </SettingsBlock>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

function SellerSetupRequired({
  feature,
  onOpenSeller,
}: {
  feature: string;
  onOpenSeller: () => void;
}) {
  return (
    <SettingsBlock>
      <SectionHeader
        title="Seller setup required"
        description={`Connect and complete Stripe onboarding before configuring ${feature}.`}
        actions={
          <Button type="button" size="sm" onClick={onOpenSeller}>
            Set up seller account
          </Button>
        }
      />
    </SettingsBlock>
  );
}

function LifecycleBadge({ state }: { state: OfferingRow["offering"]["state"] }) {
  const variant =
    state === "published"
      ? "success"
      : state === "repair_required" || state === "retiring"
        ? "warning"
        : state === "suspended"
          ? "danger"
          : "default";
  return <Badge variant={variant}>{state.replaceAll("_", " ")}</Badge>;
}

function canArchive(row: OfferingRow): boolean {
  const visibleSubscriptions =
    row.subscribers.active + row.subscribers.canceling + row.subscribers.pastDue;
  if (row.offering.state === "draft") return row.retirement === null && visibleSubscriptions === 0;
  return (
    row.offering.state === "retiring" &&
    row.retirement?.status === "complete" &&
    row.retirement.activeSubscriptionCount === 0
  );
}

function RetirementProgress({ progress }: { progress: OfferingRow["retirement"] }) {
  if (!progress) return <span className="text-muted-foreground">Not started</span>;
  return (
    <div className={progress.failedCancellationCount > 0 ? "text-destructive" : ""}>
      <p>{progress.status.replaceAll("_", " ")}</p>
      <p className="text-xs">
        {progress.activeSubscriptionCount} active · {progress.scheduledCancellationCount} scheduled
        {progress.failedCancellationCount > 0
          ? ` · ${progress.failedCancellationCount} failed`
          : ""}
      </p>
      {progress.latestPeriodEndMs ? (
        <p className="text-xs text-muted-foreground">
          Through {new Date(progress.latestPeriodEndMs).toLocaleDateString()}
        </p>
      ) : null}
      {progress.completedAtMs ? (
        <p className="text-xs text-muted-foreground">
          Completed {new Date(progress.completedAtMs).toLocaleDateString()}
        </p>
      ) : null}
    </div>
  );
}

function roleName(data: CommerceLoaderData, id: string): string {
  return data.manageableRoles.find((role) => role.id === id)?.name ?? id;
}

function SellerAcknowledgement({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

function formatMoney(valueMinor: number, currency: "AUD" | "USD"): string {
  const amount = new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(valueMinor / 100);
  return `${currency} $${amount}`;
}

function formatPair(value: Record<"AUD" | "USD", number>): string {
  return `${formatMoney(value.AUD, "AUD")} · ${formatMoney(value.USD, "USD")}`;
}
