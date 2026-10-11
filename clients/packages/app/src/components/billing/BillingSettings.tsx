import { formatNumber, messages, type CommaLocale } from "@comma/i18n";
import { useCommaLocale, useCommaMessages } from "@comma/i18n/react";
import { Button, InputField } from "@comma/ui";
import type { CommaBillingPlan, CommaBillingSummary } from "../../api";
import { panelTabButton } from "../panelTabButton";

export type BillingPeriod = "month" | "year";

export const billingPeriods: readonly BillingPeriod[] = ["month", "year"];

export interface CreditAllowance {
  percent: number;
  total: number;
}

/** Measure remaining credits only when every active grant has a known original amount. */
export function creditAllowance(
  summary: CommaBillingSummary | undefined,
  plans: readonly CommaBillingPlan[]
): CreditAllowance | undefined {
  if (!summary) return undefined;
  let total = 0;
  for (const grant of summary.active_grants) {
    const currentPlan = summary.active_subscription?.plan;
    const plan = [currentPlan, ...plans].find(
      (item) =>
        item &&
        item.package_code === grant.package_code &&
        item.package_version === grant.package_version
    );
    if (!plan) return undefined;
    total += plan.grant_credits;
  }
  if (total <= 0) return undefined;
  const percent = Math.round(
    Math.max(0, Math.min(1, summary.current_credits / total)) * 100
  );
  return { percent, total };
}

/** The amount in the plan's own currency, written the way the locale writes money. */
export function formatPrice(plan: CommaBillingPlan, locale: CommaLocale): string {
  return formatNumber(plan.amount_minor / 100, locale, {
    style: "currency",
    currency: plan.currency.toUpperCase(),
  });
}

export function billingPeriodLabel(
  period: string | null | undefined,
  locale: CommaLocale
): string {
  switch (period) {
    case "day":
      return messages.settings_billing_period_day(undefined, { locale });
    case "week":
      return messages.settings_billing_period_week(undefined, { locale });
    case "month":
      return messages.settings_billing_period_month(undefined, { locale });
    case "year":
      return messages.settings_billing_period_year(undefined, { locale });
    default:
      return messages.settings_billing_period_other(undefined, { locale });
  }
}

export function subscriptionStatusLabel(status: string, locale: CommaLocale): string {
  switch (status) {
    case "active":
      return messages.settings_billing_status_active(undefined, { locale });
    case "trialing":
      return messages.settings_billing_status_trialing(undefined, { locale });
    case "past_due":
      return messages.settings_billing_status_past_due(undefined, { locale });
    default:
      return status;
  }
}

/** "$20.00 / month" — the price as a plan row or the plan summary says it. */
export function subscriptionPrice(plan: CommaBillingPlan, locale: CommaLocale): string {
  return messages.settings_billing_price_per_period(
    {
      price: formatPrice(plan, locale),
      period: billingPeriodLabel(plan.billing_period, locale),
    },
    { locale }
  );
}

export function subscriptionPlanDetail(
  plan: CommaBillingPlan,
  locale: CommaLocale
): string {
  return messages.settings_billing_plan_detail(
    {
      price: subscriptionPrice(plan, locale),
      credits: formatNumber(plan.grant_credits, locale),
    },
    { locale }
  );
}

export function subscriptionActionLabel(
  plan: CommaBillingPlan,
  activePlan: CommaBillingPlan | undefined,
  locale: CommaLocale
): string {
  // The row already says the period twice (pill and price), so the button does not.
  if (!activePlan) return messages.settings_billing_subscribe(undefined, { locale });
  if (plan.grant_credits > activePlan.grant_credits) {
    return messages.settings_billing_upgrade_to({ name: plan.name }, { locale });
  }
  if (plan.grant_credits < activePlan.grant_credits) {
    return messages.settings_billing_downgrade_to({ name: plan.name }, { locale });
  }
  return messages.settings_billing_switch_period(undefined, { locale });
}

/**
 * The period switch is a view over one list, so it takes the same pill the
 * Drive panels use, not a form control. It sits as the first row of the plans
 * card, the way the reference puts its tabs inside the card; the row backs out
 * of the pill's own px-md so the first label starts on the rows' text edge.
 */
export function BillingPeriodTabs({
  available,
  onChange,
  period,
}: {
  available: readonly BillingPeriod[];
  onChange: (period: BillingPeriod) => void;
  period: BillingPeriod;
}) {
  const m = useCommaMessages();
  return (
    <fieldset
      aria-label={m.settings_billing_period()}
      className="m-0 -ml-xs flex min-w-0 items-center gap-xs border-0 p-0"
    >
      {billingPeriods.map((item) => (
        <button
          aria-pressed={period === item}
          className={panelTabButton(period === item)}
          disabled={!available.includes(item)}
          key={item}
          onClick={() => onChange(item)}
          type="button"
        >
          {item === "year" ? m.settings_billing_annual() : m.settings_billing_monthly()}
        </button>
      ))}
    </fieldset>
  );
}

/** Remaining credits across active grants, including subscription credits and packs. */
export function BillingAllowanceMeter({ allowance }: { allowance: CreditAllowance }) {
  const m = useCommaMessages();
  const locale = useCommaLocale();
  return (
    <div className="flex items-center gap-lg">
      <progress
        aria-label={m.settings_billing_credits_remaining()}
        className="h-1.5 w-[var(--spacing-11xl)] appearance-none [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-brand-solid [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-tertiary [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-brand-solid"
        max={100}
        value={allowance.percent}
      />
      <span className="min-w-[7ch] text-right text-sm text-tertiary tabular-nums">
        {m.settings_billing_percent_left({
          percent: formatNumber(allowance.percent / 100, locale, { style: "percent" }),
        })}
      </span>
    </div>
  );
}

export interface BillingRedeemFormProps {
  code: string;
  disabled: boolean;
  error: string | undefined;
  notice: string | undefined;
  onCodeChange: (code: string) => void;
  onSubmit: () => void;
  pending: boolean;
}

/** The redeem row: one field and its button, the outcome under them. */
export function BillingRedeemForm({
  code,
  disabled,
  error,
  notice,
  onCodeChange,
  onSubmit,
  pending,
}: BillingRedeemFormProps) {
  const m = useCommaMessages();
  return (
    <form
      className="flex w-full flex-col gap-md"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-wrap items-center gap-md">
        <div className="min-w-0 flex-[1_1_16rem]">
          <InputField
            aria-label={m.settings_redeem_code()}
            className="w-full"
            fieldSize="sm"
            onChange={(event) => onCodeChange(event.target.value)}
            placeholder={m.settings_billing_redeem_placeholder()}
            value={code}
          />
        </div>
        <Button
          hierarchy="secondary-gray"
          isDisabled={disabled || pending || code.trim().length < 3}
          size="sm"
          type="submit"
        >
          {pending ? m.settings_billing_redeeming() : m.settings_billing_redeem()}
        </Button>
      </div>
      {notice ? (
        <output className="text-sm text-success-primary">{notice}</output>
      ) : null}
      {error ? (
        <p className="m-0 text-sm text-error-primary" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
