import type { ComposioAccount } from "../../api";

function accountName(account: ComposioAccount) {
  const suffix = ` (${account.id})`;
  return account.name.endsWith(suffix)
    ? account.name.slice(0, -suffix.length)
    : account.name;
}

// Legacy labels may include the exact public connection reference. Keep that
// reference in account details and distinguish duplicate identities compactly.
export function composioAccountPresentation(
  account: ComposioAccount,
  accounts: ComposioAccount[]
) {
  const name = accountName(account);
  const duplicates = accounts
    .filter((item) => accountName(item) === name && item.email === account.email)
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return {
    name,
    email: account.email,
    number:
      duplicates.length > 1
        ? duplicates.findIndex((item) => item.id === account.id) + 1
        : null,
  };
}
