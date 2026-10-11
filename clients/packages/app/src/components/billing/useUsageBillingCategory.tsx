import type { ReactNode } from "react";
import { LoadingIndicator } from "@comma/ui";
import { formatDate, formatList, formatNumber, messages } from "@comma/i18n";
import { useCommaI18n, useCommaMessages } from "@comma/i18n/react";
import { Badge, Dialog } from "@comma/ui";
import type { SettingsCategoryDefinition, SettingsPanelItem } from "@comma/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CommaApiClient,
  CommaBillingPlan,
  CommaBillingSummary,
  CommaBillingChangePreview,
  CommaWorkspace,
} from "../../api";
import { CommaApiError } from "../../api";
import {
  openNativePlatformExternalUrl,
  openNativePlatformExternalUrlFromUserAction,
} from "../../runtime-chat/nativePlatformActions";
import { readActiveWorkspaceId } from "../activeWorkspace";
import {
  BillingAllowanceMeter,
  type BillingPeriod,
  billingPeriods,
  BillingPeriodTabs,
  BillingRedeemForm,
  creditAllowance,
  formatPrice,
  subscriptionActionLabel,
  subscriptionPlanDetail,
  subscriptionPrice,
  subscriptionStatusLabel,
} from "./BillingSettings";

/**
 * The Settings › Usage & billing category, as five cards of rows: status
 * first (which plan, how many credits, how much of this cycle is left), then
 * what is for sale (subscription plans, credit packs), then the redeem code.
 *
 * Billing state lives here rather than in a mounted component so every row
 * is a registry row; the catalog and summary load when the category opens.
 */
export function useUsageBillingCategory(
  api: CommaApiClient,
  enabled: boolean
): SettingsCategoryDefinition {
  const m = useCommaMessages();
  const { locale } = useCommaI18n();
  const [workspace, setWorkspace] = useState<CommaWorkspace>();
  const [plans, setPlans] = useState<CommaBillingPlan[]>([]);
  const [summary, setSummary] = useState<CommaBillingSummary>();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<string>();
  // An error stays with the page whose action raised it.
  const [error, setError] = useState<{ key: string; message: string }>();
  const [notice, setNotice] = useState<string>();
  const [changeQuote, setChangeQuote] = useState<{
    plan: CommaBillingPlan;
    preview: CommaBillingChangePreview;
    requestId: string;
  }>();
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("month");

  const activeSubscription = summary?.active_subscription;
  const isActivePlan = (plan: CommaBillingPlan) =>
    activeSubscription?.package_code === plan.package_code &&
    activeSubscription.package_version === plan.package_version;
  const activePlan = activeSubscription?.plan ?? undefined;
  const availablePeriods = billingPeriods.filter(
    (period) =>
      (!activePlan || activePlan.billing_period === period) &&
      plans.some(
        (plan) => plan.mode === "subscription" && plan.billing_period === period
      )
  );
  // A catalog with only one period shows that period, whichever pill was last
  // chosen; the other pill stays visible but cannot be selected.
  const period = availablePeriods.includes(billingPeriod)
    ? billingPeriod
    : (availablePeriods[0] ?? billingPeriod);
  const subscriptionPlans = plans.filter(
    (plan) => plan.mode === "subscription" && plan.billing_period === period
  );
  const creditPacks = plans.filter((plan) => plan.mode === "payment");
  const allowance = useMemo(() => creditAllowance(summary, plans), [summary, plans]);
  const loading = pending === "load";
  const opening = m.settings_billing_opening();

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const options = signal ? { signal } : {};
      const [availablePlans, workspaces] = await Promise.all([
        api.listBillingPlans(options),
        api.listWorkspaces(options),
      ]);
      const activeId = readActiveWorkspaceId();
      const selected = workspaces.find((item) => item.id === activeId) ?? workspaces[0];
      if (!selected) throw new Error("workspace_missing");
      if (signal?.aborted) return;
      setWorkspace(selected);
      setPlans(availablePlans);
      const nextSummary = await api.getBillingSummary(selected.id, options);
      if (signal?.aborted) return;
      setSummary(nextSummary);
      return { baseline: nextSummary, workspaceId: selected.id };
    },
    [api]
  );

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setPending("load");
    setError(undefined);
    void reload(controller.signal)
      .then(async (loaded) => {
        if (!controller.signal.aborted) setError(undefined);
        if (!loaded || !shouldRefreshBillingReturn()) return;
        const { baseline, workspaceId } = loaded;

        // Stripe webhook delivery can trail the browser return by a few seconds.
        // Keep this client refresh deliberately bounded: four summary reads over
        // 4.2 seconds, independent of catalog/workspace cardinality.
        for (const delayMs of [600, 1_200, 2_400]) {
          await abortableDelay(delayMs, controller.signal);
          const next = await api.getBillingSummary(workspaceId, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setSummary(next);
          if (billingSummaryChanged(baseline, next)) return;
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError({
            key: "load",
            message: messages.settings_billing_load_failed(undefined, { locale }),
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(undefined);
      });
    return () => controller.abort();
  }, [api, enabled, locale, reload]);

  const run = async (key: string, action: () => Promise<void>) => {
    setPending(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (reason) {
      setError({ key, message: billingErrorMessage(reason) });
    } finally {
      setPending(undefined);
    }
  };

  const startCheckout = (plan: CommaBillingPlan) => {
    if (!workspace) return;
    void run(plan.plan_key, async () => {
      await openNativePlatformExternalUrlFromUserAction(async () => {
        const session = await api.createBillingCheckout(workspace.id, plan.plan_key);
        return session.url;
      });
    });
  };

  const startSubscriptionChange = (plan: CommaBillingPlan) => {
    if (!workspace) return;
    void run(plan.plan_key, async () => {
      const preview = await api.previewBillingSubscriptionChange(
        workspace.id,
        plan.plan_key
      );
      setChangeQuote({ plan, preview, requestId: crypto.randomUUID() });
    });
  };

  const confirmSubscriptionChange = () => {
    if (!workspace || !changeQuote) return;
    const quote = changeQuote;
    void run(quote.plan.plan_key, async () => {
      const execute = async () =>
        api.changeBillingSubscription(
          workspace.id,
          quote.plan.plan_key,
          quote.preview,
          quote.requestId
        );
      if (quote.preview.effect === "upgrade") {
        await openNativePlatformExternalUrlFromUserAction(async () => {
          const result = await execute();
          if (!result.url) throw new Error("subscription_payment_failed");
          return result.url;
        });
      } else {
        await execute();
      }
      setChangeQuote(undefined);
      await reload();
    });
  };

  const openPortal = () => {
    if (!workspace) return;
    void run("portal", async () => {
      const session = await api.createBillingPortal(workspace.id);
      await openNativePlatformExternalUrl(session.url);
    });
  };

  const redeem = () => {
    const normalized = code.trim();
    if (!workspace || normalized.length < 3) return;
    void run("redeem", async () => {
      await api.redeemBillingCode(workspace.id, normalized);
      const next = await api.getBillingSummary(workspace.id);
      setSummary(next);
      setCode("");
      setNotice(m.settings_billing_redeemed());
    });
  };

  const packKeys = new Set(creditPacks.map((plan) => plan.plan_key));
  const planKeys = new Set(
    plans.filter((plan) => plan.mode === "subscription").map((plan) => plan.plan_key)
  );
  const errorFor = (owns: (key: string) => boolean) =>
    error && owns(error.key) ? error.message : undefined;
  // An annual payment also creates monthly grants. Their expiry is not a renewal date.
  const subscriptionCreditExpiry = summary?.active_grants
    .filter((grant) => grant.source_type === "subscription_cycle" && grant.expires_at)
    .map((grant) => new Date(grant.expires_at!))
    .filter((date) => Number.isFinite(date.getTime()))
    .toSorted((left, right) => left.getTime() - right.getTime())[0];
  const creditExpiry = subscriptionCreditExpiry
    ? m.settings_billing_subscription_credits_expire({
        date: formatDate(subscriptionCreditExpiry, locale, { dateStyle: "medium" }),
      })
    : undefined;

  // Your plan: one row — what you are on, and the way to Stripe for its
  // invoices and payment method.
  const planRows: SettingsPanelItem[] = [
    {
      id: "billing.plan.current",
      title: loading
        ? "—"
        : (activePlan?.name ??
          activeSubscription?.package_code ??
          m.settings_billing_no_subscription()),
      description: activeSubscription
        ? [
            activePlan ? subscriptionPrice(activePlan, locale) : undefined,
            subscriptionStatusLabel(activeSubscription.status, locale),
          ]
            .filter(Boolean)
            .join(" · ")
        : m.settings_billing_subscribe_description(),
      keywords: [
        "subscription",
        "invoice",
        "stripe",
        "cancel",
        "订阅",
        "发票",
        "取消",
        "assinatura",
        "plano",
        "fatura",
        "cancelar",
        "pagamento",
      ],
      ...(activeSubscription
        ? {
            control: {
              type: "button" as const,
              label: pending === "portal" ? opening : m.settings_manage(),
              disabled: loading || pending === "portal",
              onPress: openPortal,
            },
          }
        : {}),
    },
    ...errorRow(
      "billing.plan.error",
      errorFor((key) => key === "load" || key === "portal")
    ),
  ];

  // The balance includes all active grants. The subscription expiry is a separate fact.
  const balanceRows: SettingsPanelItem[] = [
    {
      id: "billing.credits.balance",
      title: loading ? "—" : formatNumber(summary?.current_credits ?? 0, locale),
      description: [
        workspace?.name,
        allowance
          ? m.settings_billing_original_credits({
              credits: formatNumber(allowance.total, locale),
            })
          : m.settings_billing_current_balance(),
        creditExpiry,
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: ["credits", "balance", "余额", "créditos", "saldo"],
      ...(allowance
        ? {
            control: {
              type: "custom" as const,
              content: <BillingAllowanceMeter allowance={allowance} />,
            },
          }
        : {}),
    },
  ];

  // Subscription plans: the period switch is the card's first row, then one
  // row per plan of that period.
  const planListRows: SettingsPanelItem[] = [
    ...(availablePeriods.length > 0
      ? [
          {
            id: "billing.plans.period",
            title: m.settings_billing_period(),
            layout: "stack" as const,
            control: {
              type: "custom" as const,
              content: (
                <BillingPeriodTabs
                  available={availablePeriods}
                  onChange={setBillingPeriod}
                  period={period}
                />
              ),
            },
          },
          ...subscriptionPlans.map(
            (plan): SettingsPanelItem => ({
              id: `billing.plans.${plan.plan_key}`,
              title: plan.name,
              description: subscriptionPlanDetail(plan, locale),
              keywords: [
                "subscription",
                "upgrade",
                "订阅",
                "升级",
                "assinatura",
                "plano",
                "mudar plano",
              ],
              control: isActivePlan(plan)
                ? {
                    type: "custom",
                    content: (
                      <Badge color="success" size="sm">
                        {m.settings_billing_current_plan()}
                      </Badge>
                    ),
                  }
                : {
                    type: "button",
                    label:
                      pending === plan.plan_key
                        ? opening
                        : subscriptionActionLabel(plan, activePlan, locale),
                    disabled: loading || pending === plan.plan_key,
                    onPress: () =>
                      activeSubscription
                        ? startSubscriptionChange(plan)
                        : startCheckout(plan),
                  },
            })
          ),
        ]
      : [
          emptyRow(
            "billing.plans.empty",
            m.settings_billing_subscription_plans(),
            loading ? (
              <LoadingIndicator label={m.settings_billing_loading_plans()} />
            ) : (
              m.settings_billing_no_plans()
            )
          ),
        ]),
    ...errorRow(
      "billing.plans.error",
      errorFor((key) => planKeys.has(key))
    ),
  ];

  if (changeQuote) {
    const preview = changeQuote.preview;
    const due = formatNumber(preview.amount_minor / 100, locale, {
      style: "currency",
      currency: preview.currency,
    });
    const nextBill = formatDate(new Date(preview.period_end * 1000), locale, {
      dateStyle: "medium",
    });
    const description =
      preview.effect === "upgrade"
        ? m.settings_billing_upgrade_confirm({ due })
        : preview.effect === "downgrade"
          ? m.settings_billing_downgrade_confirm({ date: nextBill })
          : m.settings_billing_keep_plan_confirm();
    planListRows.push({
      id: "billing.plans.confirm",
      title: changeQuote.plan.name,
      control: {
        type: "custom",
        content: (
          <Dialog
            isOpen
            title={m.settings_billing_confirm_change_title()}
            description={description}
            isDismissable={!pending}
            onOpenChange={(open) => {
              if (!open && !pending) setChangeQuote(undefined);
            }}
            actions={[
              {
                label: m.settings_billing_cancel(),
                hierarchy: "secondary-gray",
                disabled: !!pending,
                onPress: () => setChangeQuote(undefined),
              },
              {
                label: m.settings_billing_confirm(),
                hierarchy: "primary",
                disabled: !!pending,
                onPress: confirmSubscriptionChange,
              },
            ]}
          />
        ),
      },
    });
  }
  const scheduled = activeSubscription?.source_metadata?.scheduled_plan;
  if (scheduled) {
    const target = plans.find(
      (plan) =>
        plan.package_code === scheduled.package_code &&
        plan.package_version === scheduled.package_version
    );
    planRows.push({
      id: "billing.plan.scheduled",
      title: m.settings_billing_scheduled_downgrade(),
      description: `${target?.name ?? scheduled.package_code} · ${formatDate(new Date(scheduled.effective_at * 1000), locale, { dateStyle: "medium" })}`,
      control: {
        type: "button",
        label: m.settings_billing_keep_current_plan(),
        disabled: !!pending || !activePlan,
        onPress: () => {
          if (activePlan) startSubscriptionChange(activePlan);
        },
      },
    });
  }

  if (activeSubscription) {
    const cancellation = activeSubscription.source_metadata?.cancel_at_period_end;
    const ends = activeSubscription.source_metadata?.current_period_end;
    planRows.push({
      id: "billing.plan.cancel",
      title: m.settings_billing_cancel_renewal(),
      ...(cancellation
        ? {
            description:
              m.settings_billing_renewal_cancelled() +
              (ends
                ? ` · ${formatDate(new Date(ends * 1000), locale, { dateStyle: "medium" })}`
                : ""),
          }
        : {}),
      control: {
        type: "button",
        label: cancellation
          ? m.settings_billing_cancelled()
          : m.settings_billing_cancel_renewal(),
        disabled: !!pending || !!cancellation,
        onPress: () => {
          if (workspace)
            void run("portal", async () => {
              await api.cancelBillingSubscriptionRenewal(workspace.id);
              await reload();
            });
        },
      },
    });
  }

  const nowUtc = new Date();
  const estimatedPackEnd = formatDate(
    Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() + 1, 0),
    locale,
    { dateStyle: "medium", timeZone: "UTC" }
  );
  // A pack expires at 00:00 UTC on its expiry date; one entry per date.
  const paidPackExpiries = [
    ...new Set(
      (summary?.active_grants ?? [])
        .filter((grant) => grant.source_type === "stripe_checkout" && grant.expires_at)
        .map((grant) => grant.expires_at!.slice(0, 10))
    ),
  ].map((day) =>
    formatDate(Date.parse(`${day}T00:00:00Z`), locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    })
  );

  // Credit packs: one row per pack.
  const packRows: SettingsPanelItem[] = [
    ...(paidPackExpiries.length > 0
      ? [
          {
            id: "billing.packs.paid-expiry",
            title: m.settings_billing_purchased_expire(),
            description: formatList(paidPackExpiries, locale),
          },
        ]
      : []),
    ...(creditPacks.length > 0
      ? creditPacks.map(
          (plan): SettingsPanelItem => ({
            id: `billing.packs.${plan.plan_key}`,
            title: plan.name,
            description: m.settings_billing_pack_description({
              credits: formatNumber(plan.grant_credits, locale),
              date: estimatedPackEnd,
            }),
            keywords: ["buy", "credits", "充值", "comprar", "créditos", "pacote"],
            control: {
              type: "button",
              label: pending === plan.plan_key ? opening : formatPrice(plan, locale),
              disabled: loading || pending === plan.plan_key,
              onPress: () => startCheckout(plan),
            },
          })
        )
      : [
          emptyRow(
            "billing.packs.empty",
            m.settings_add_credits(),
            loading ? (
              <LoadingIndicator label={m.settings_billing_loading_packs()} />
            ) : (
              m.settings_billing_no_packs()
            )
          ),
        ]),
    ...errorRow(
      "billing.packs.error",
      errorFor((key) => packKeys.has(key))
    ),
  ];

  return {
    id: "usage-billing",
    icon: "usage-billing",
    label: m.settings_usage_billing(),
    sections: [
      { id: "billing.plan", title: m.settings_your_plan(), items: planRows },
      {
        id: "billing.credits",
        title: m.settings_credits_balance(),
        items: balanceRows,
      },
      {
        id: "billing.plans",
        title: m.settings_billing_subscription_plans(),
        items: planListRows,
      },
      { id: "billing.packs", title: m.settings_add_credits(), items: packRows },
      {
        id: "billing.redeem",
        title: m.settings_redeem_credits(),
        items: [
          {
            id: "billing.redeem.code",
            title: m.settings_redeem_code(),
            description: m.settings_redeem_credits_description(),
            keywords: ["code", "coupon", "兑换码", "código", "cupom", "resgatar"],
            layout: "field",
            control: {
              type: "custom",
              content: (
                <BillingRedeemForm
                  code={code}
                  disabled={loading || !workspace}
                  error={errorFor((key) => key === "redeem")}
                  notice={notice}
                  onCodeChange={setCode}
                  onSubmit={redeem}
                  pending={pending === "redeem"}
                />
              ),
            },
          },
        ],
      },
    ],
  };
}

/** A card's last row when an action in it failed: the message, nothing else. */
function errorRow(id: string, message: string | undefined): SettingsPanelItem[] {
  return message
    ? [
        {
          id,
          title: message,
          layout: "stack",
          control: {
            type: "custom",
            content: (
              <p className="m-0 text-sm text-error-primary" role="alert">
                {message}
              </p>
            ),
          },
        },
      ]
    : [];
}

function emptyRow(id: string, title: string, text: ReactNode): SettingsPanelItem {
  return {
    id,
    title,
    layout: "stack",
    control: {
      type: "custom",
      content: <output className="text-sm text-tertiary">{text}</output>,
    },
  };
}

function shouldRefreshBillingReturn(): boolean {
  if (typeof window === "undefined") return false;
  const queryStart = window.location.hash.indexOf("?");
  if (queryStart < 0) return false;
  const status = new URLSearchParams(window.location.hash.slice(queryStart + 1)).get(
    "billing-return"
  );
  return status === "success" || status === "portal" || status === "subscription";
}

function billingSummaryChanged(
  baseline: CommaBillingSummary,
  current: CommaBillingSummary
): boolean {
  return billingSummarySnapshot(baseline) !== billingSummarySnapshot(current);
}

function billingSummarySnapshot(summary: CommaBillingSummary): string {
  return JSON.stringify({
    activeGrants: summary.active_grants
      .map((grant) => ({
        expiresAt: grant.expires_at ?? null,
        id: grant.id,
        packageCode: grant.package_code,
        packageVersion: grant.package_version,
        remainingCredits: grant.remaining_credits,
        sourceId: grant.source_id,
        sourceType: grant.source_type,
        validFrom: grant.valid_from,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    activeSubscription: summary.active_subscription
      ? {
          packageCode: summary.active_subscription.package_code,
          packageVersion: summary.active_subscription.package_version,
          sourceId: summary.active_subscription.source_id,
          status: summary.active_subscription.status,
        }
      : null,
    currentCredits: summary.current_credits,
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = window.setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function billingErrorMessage(reason: unknown) {
  const code = reason instanceof CommaApiError ? reason.body?.error : undefined;
  switch (code) {
    case "redeem_code_not_found":
      return messages.settings_billing_error_code_not_found();
    case "redeem_code_expired":
      return messages.settings_billing_error_code_expired();
    case "redeem_code_disabled":
      return messages.settings_billing_error_code_disabled();
    case "redeem_code_max_redemptions_reached":
      return messages.settings_billing_error_code_max_redemptions();
    case "redeem_code_account_limit_reached":
      return messages.settings_billing_error_code_account_limit();
    case "active_subscription_not_found":
      return messages.settings_billing_error_subscription_syncing();
    case "subscription_change_unavailable":
      return messages.settings_billing_error_change_unavailable();
    default:
      return messages.settings_billing_error_generic();
  }
}
