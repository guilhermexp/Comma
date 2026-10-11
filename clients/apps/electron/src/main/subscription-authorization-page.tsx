import { authorizationReturnScript } from "./authorization-return";
import { defaultLocale, messages, type CommaLocale } from "@comma/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { CommaMark } from "../../../../packages/ui/src/components/login/BrandMarks";
import { fontFamily } from "../../../../packages/ui/src/tokens/typography";
import {
  text,
  background,
  border,
} from "../../../../packages/ui/src/tokens/colors/semantic";
import { brand } from "../../../../packages/ui/src/tokens/colors/brand";

import { semanticDark } from "../../../../packages/ui/src/tokens/colors/semantic-dark";

type AuthorizationPageState = "received" | "denied" | "invalid" | "notFound";

// Received and denied pages close themselves, so only the other states carry a
// footer detail.
function pageCopy(state: AuthorizationPageState, locale: CommaLocale) {
  const options = { locale };
  switch (state) {
    case "received":
      return {
        label: messages.subscription_auth_received_label({}, options),
        title: messages.subscription_auth_return({}, options),
        description: messages.subscription_auth_received_description({}, options),
      };
    case "denied":
      return {
        label: messages.subscription_auth_denied_label({}, options),
        title: messages.subscription_auth_denied_title({}, options),
        description: messages.subscription_auth_denied_description({}, options),
      };
    case "invalid":
      return {
        label: messages.subscription_auth_invalid_label({}, options),
        title: messages.subscription_auth_invalid_title({}, options),
        description: messages.subscription_auth_invalid_description({}, options),
        detail: messages.subscription_auth_invalid_detail({}, options),
      };
    case "notFound":
      return {
        label: messages.subscription_auth_not_found_label({}, options),
        title: messages.subscription_auth_not_found_title({}, options),
        description: messages.subscription_auth_not_found_description({}, options),
        detail: messages.subscription_auth_close_tab({}, options),
      };
  }
}

// A self-contained document: the temporary listener closes after the callback,
// so the page cannot depend on later asset requests or status polling.
export function subscriptionAuthorizationPage(
  state: AuthorizationPageState,
  source: "subscription" | "byok" = "subscription",
  returnUrl?: string,
  locale: CommaLocale = defaultLocale
): string {
  const options = { locale };
  const copy = pageCopy(state, locale);
  const content =
    source === "byok"
      ? {
          ...copy,
          description:
            state === "received"
              ? messages.subscription_auth_byok_received_description({}, options)
              : messages.subscription_auth_byok_retry_description({}, options),
          detail: messages.subscription_auth_close_tab({}, options),
        }
      : copy;
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <html lang={locale}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <meta name="referrer" content="no-referrer" />
          <title>{`${content.label} · Comma`}</title>
          <style>{`
          :root { color-scheme: light dark; --page: ${background.secondary}; --surface: ${background.primary}; --text: ${text.primary}; --muted: ${text.tertiary}; --line: ${border.secondary}; --brand: ${brand[500]}; }
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100svh; padding: 32px 20px; display: grid; place-items: center; background: var(--page); color: var(--text); font-family: ${fontFamily.sans}; -webkit-font-smoothing: antialiased; }
          main { width: 100%; max-width: 440px; text-align: center; }
          .brand { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 32px; font-size: 24px; font-weight: 600; letter-spacing: -.02em; }
          .brand svg { width: 36px; height: 36px; }
          .panel { padding: 40px 32px 32px; border-radius: 24px; background: var(--surface); box-shadow: 0 0 0 1px var(--line), 0 8px 24px #00000005; }
          .label { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 20px; font-size: 13px; line-height: 20px; color: var(--muted); }
          .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--brand); }
          h1 { margin: 0 0 12px; font-size: 28px; line-height: 36px; font-weight: 600; letter-spacing: -.025em; text-wrap: balance; }
          .description { margin: 0; font-size: 15px; line-height: 24px; color: var(--muted); text-wrap: pretty; }
          .return { display: block; margin-top: 24px; padding: 12px 16px; border-radius: 8px; background: ${brand[600]}; color: #fff; font-size: 15px; font-weight: 500; text-decoration: none; }
          .return:focus-visible { outline: 2px solid var(--text); outline-offset: 3px; }
          .next { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--line); font-size: 13px; line-height: 20px; color: var(--muted); }
          .next strong { display: block; margin-bottom: 4px; color: var(--text); font-weight: 500; }
          footer { margin: 24px auto 0; max-width: 340px; color: var(--muted); font-size: 12px; line-height: 20px; text-wrap: pretty; }
          @media (prefers-color-scheme: dark) { :root { --page: ${semanticDark.background.secondary}; --surface: ${semanticDark.background.primary}; --text: ${semanticDark.text.primary}; --muted: ${semanticDark.text.tertiary}; --line: ${semanticDark.border.secondary}; --brand: ${brand[200]}; } }
          @media (max-width: 400px) { .panel { padding: 32px 24px 24px; } h1 { font-size: 24px; line-height: 32px; } }
        `}</style>
        </head>
        <body data-auto-close={state === "received" || state === "denied"}>
          <main>
            <div className="brand">
              <CommaMark />
              <span>Comma</span>
            </div>
            <section className="panel" aria-labelledby="title">
              <p className="label">
                <span className="dot" aria-hidden="true" />
                {content.label}
              </p>
              <h1 id="title">{content.title}</h1>
              <p className="description">{content.description}</p>
              {returnUrl && (
                <a id="comma-return" className="return" href={returnUrl}>
                  {messages.subscription_auth_return({}, options)}
                </a>
              )}
              <div className="next">
                <strong>{messages.subscription_auth_in_app({}, options)}</strong>
                {messages.subscription_auth_settings_path(
                  {
                    section:
                      source === "byok"
                        ? messages.settings_providers_models({}, options)
                        : messages.subscription_auth_section_subscribe_proxy(
                            {},
                            options
                          ),
                  },
                  options
                )}
              </div>
            </section>
            <footer>
              {state === "received" || state === "denied"
                ? messages.subscription_auth_auto_close({}, options)
                : content.detail}
            </footer>
          </main>
          <script dangerouslySetInnerHTML={{ __html: authorizationReturnScript }} />
        </body>
      </html>
    )
  );
}
