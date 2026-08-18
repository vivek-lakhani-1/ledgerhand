export const tenants = {
  alpha: {
    brand: "MERIDIAN CREDIT UNION - Member Services Console",
    fieldLabel: "Member ID:",
    searchSubmit: "Retrieve",
    balanceColumn: "Current Balance",
    navSearch: "Member Search",
    chrome: "#0b6b6b",
  },
  beta: {
    brand: "NORTHBAY FCU - Account Servicing Terminal",
    fieldLabel: "Account Number:",
    searchSubmit: "Search",
    balanceColumn: "Balance (USD)",
    navSearch: "Find Member",
    chrome: "#7a1f2b",
  },
} as const;

export type TenantName = keyof typeof tenants;
export type TenantConfig = (typeof tenants)[TenantName];

export function getTenant(value: string): TenantConfig | undefined {
  if (value === "alpha" || value === "beta") {
    return tenants[value];
  }
  return undefined;
}
