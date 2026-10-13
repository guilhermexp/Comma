import type { ComposioAccount } from "../../api";

function accountIdentity(account: ComposioAccount) {
  const suffix = ` (${account.id})`;
  const label = account.name.endsWith(suffix)
    ? account.name.slice(0, -suffix.length)
    : account.name;
  // Presentation of previously saved composed labels only. This does not
  // establish provider identity, write metadata, or authorize an account.
  const composed = /^(.+) <([^<>\s]+@[^<>\s]+)>$/.exec(label);
  return {
    name: composed?.[1] ?? label,
    email: account.email ?? composed?.[2] ?? null,
  };
}

// Legacy labels may include the exact public connection reference. Keep that
// reference in account details and distinguish duplicate identities compactly.
export function composioAccountPresentation(
  account: ComposioAccount,
  accounts: ComposioAccount[]
) {
  const { name, email } = accountIdentity(account);
  const duplicates = accounts
    .filter((item) => {
      const identity = accountIdentity(item);
      return identity.name === name && identity.email === email;
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return {
    name,
    email,
    number:
      duplicates.length > 1
        ? duplicates.findIndex((item) => item.id === account.id) + 1
        : null,
  };
}
