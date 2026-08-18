import type { Account, Member } from "./data.js";
import type { TenantConfig, TenantName } from "./tenants.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function appPath(tenant: TenantName, path: string): string {
  return `/t/${tenant}/msc${path}`;
}

function legacyFont(text: string, size = "2", color?: string): string {
  const colorAttribute = color ? ` color="${escapeHtml(color)}"` : "";
  return `<font face="Verdana" size="${size}"${colorAttribute}>${text}</font>`;
}

function page(tenant: TenantConfig, title: string, content: string): string {
  return `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title></head><body bgcolor="#f5f5f5"><table border="0" cellpadding="4" cellspacing="0" width="100%" bgcolor="${tenant.chrome}"><tr><td>${legacyFont(escapeHtml(tenant.brand), "2", "#ffffff")}</td></tr></table><br>${content}</body></html>`;
}

function messageRow(message: string, color = "#7a1f2b"): string {
  return `<table border="1" cellpadding="3" cellspacing="0" bgcolor="#fff4f4"><tr><td>${legacyFont(escapeHtml(message), "2", color)}</td></tr></table><br>`;
}

export function renderLogin(
  tenant: TenantConfig,
  tenantName: TenantName,
  message?: string,
): string {
  const notice = message ? messageRow(message) : "";
  const form = `<form method="post" action="${appPath(tenantName, "/login")}"><table border="1" cellpadding="3" cellspacing="0"><tr><td bgcolor="#e8e8e8">${legacyFont("Operator ID:")}</td><td><input type="text" name="u" size="14"></td></tr><tr><td bgcolor="#e8e8e8">${legacyFont("Password:")}</td><td><input type="password" name="p" size="14"></td></tr><tr><td></td><td><input type="submit" value="Sign On"></td></tr></table></form>`;
  return page(tenant, "Operator Sign On", `${notice}${legacyFont("Please sign on to continue.")}<br><br>${form}`);
}

export function renderFrameset(
  tenant: TenantConfig,
  tenantName: TenantName,
): string {
  const nav = appPath(tenantName, "/nav");
  const search = appPath(tenantName, "/search");
  return `<!DOCTYPE html><html><head><title>${escapeHtml(tenant.brand)}</title></head><frameset cols="200,*"><frame name="nav" src="${nav}"><frame name="content" src="${search}"></frameset></html>`;
}

export function renderNav(
  tenant: TenantConfig,
  tenantName: TenantName,
): string {
  const links = [
    `<a target="content" href="${appPath(tenantName, "/search")}">${legacyFont(escapeHtml(tenant.navSearch))}</a>`,
    `<a target="content" href="${appPath(tenantName, "/subaccount/new?member=10001")}">${legacyFont("New Sub-Account")}</a>`,
    `<a target="content" href="${appPath(tenantName, "/signoff")}">${legacyFont("Sign Off")}</a>`,
  ];
  const rows = links.map((link) => `<tr><td>${link}</td></tr>`).join("");
  return page(tenant, "Navigation", `<table border="1" cellpadding="3" cellspacing="0" bgcolor="#eefafa" width="100%"><tr><td bgcolor="${tenant.chrome}">${legacyFont("Menu", "2", "#ffffff")}</td></tr>${rows}</table>`);
}

export function renderSearch(
  tenant: TenantConfig,
  tenantName: TenantName,
): string {
  const form = `<form method="post" action="${appPath(tenantName, "/search")}"><table border="1" cellpadding="3" cellspacing="0"><tr><td bgcolor="#e8e8e8">${legacyFont(escapeHtml(tenant.fieldLabel))}</td><td><input type="text" name="q" size="14"></td></tr><tr><td></td><td><input type="submit" value="${escapeHtml(tenant.searchSubmit)}"></td></tr></table></form>`;
  return page(tenant, tenant.navSearch, `${legacyFont("Enter an identifier and retrieve the member record.")}<br><br>${form}`);
}

export function renderNotFound(
  tenant: TenantConfig,
  query: string,
): string {
  return page(tenant, "Member Search", messageRow(`No member record found for ID ${query}.`));
}

export function renderPermissionDenied(tenant: TenantConfig): string {
  return page(tenant, "Account Access", messageRow("You are not authorized to view this account."));
}

function money(value: number): string {
  return value.toFixed(2);
}

function accountRows(accounts: Account[], balanceColumn: string): string {
  const header = `<tr bgcolor="#d0d0d0"><th>${legacyFont("Account No.")}</th><th>${legacyFont("Type")}</th><th>${legacyFont("Status")}</th><th>${legacyFont(escapeHtml(balanceColumn))}</th></tr>`;
  const rows = accounts.map((account) => `<tr><td>${legacyFont(escapeHtml(account.accountNo))}</td><td>${legacyFont(escapeHtml(account.type))}</td><td>${legacyFont(escapeHtml(account.status))}</td><td>${legacyFont(escapeHtml(money(account.balance)))}</td></tr>`).join("");
  return `<table border="1" cellpadding="3" cellspacing="0">${header}${rows}</table>`;
}

export function renderMember(
  tenant: TenantConfig,
  member: Member,
): string {
  const headerTable = `<table border="1" cellpadding="3" cellspacing="0"><tr><td bgcolor="#e8e8e8">${legacyFont("Member ID:")}</td><td>${legacyFont(escapeHtml(member.id))}</td></tr><tr><td bgcolor="#e8e8e8">${legacyFont("Name:")}</td><td>${legacyFont(escapeHtml(member.name))}</td></tr><tr><td bgcolor="#e8e8e8">${legacyFont("Branch:")}</td><td>${legacyFont(escapeHtml(member.branch))}</td></tr><tr><td bgcolor="#e8e8e8">${legacyFont("Status:")}</td><td>${legacyFont(escapeHtml(member.status))}</td></tr></table><br>`;
  return page(tenant, `Member ${member.id}`, `${legacyFont("Member Details", "3")}<br><br>${headerTable}${legacyFont("Accounts", "3")}<br><br>${accountRows(member.accounts, tenant.balanceColumn)}`);
}

export function renderSubaccountNew(
  tenant: TenantConfig,
  tenantName: TenantName,
  member: Member,
): string {
  const action = appPath(tenantName, `/subaccount/review?member=${encodeURIComponent(member.id)}`);
  const form = `<form method="post" action="${action}"><table border="1" cellpadding="3" cellspacing="0"><tr><td bgcolor="#e8e8e8">${legacyFont("Account Type:")}</td><td><select name="f1"><option value="Savings">Savings</option><option value="Money Market">Money Market</option><option value="Holiday Club">Holiday Club</option></select></td></tr><tr><td bgcolor="#e8e8e8">${legacyFont("Initial Deposit:")}</td><td><input type="text" name="f2" size="14"></td></tr><tr><td bgcolor="#e8e8e8">${legacyFont("Purpose:")}</td><td><input type="text" name="f3" size="30"></td></tr><tr><td></td><td><input type="submit" value="Review"></td></tr></table></form>`;
  return page(tenant, "New Sub-Account", `${legacyFont(`New Sub-Account for Member ${escapeHtml(member.id)}`, "3")}<br><br>${form}`);
}

export function renderReview(
  tenant: TenantConfig,
  tenantName: TenantName,
  memberId: string,
  accountType: string,
  deposit: string,
  purpose: string,
): string {
  const action = appPath(tenantName, `/subaccount/confirm?member=${encodeURIComponent(memberId)}`);
  const values = `<table border="1" cellpadding="3" cellspacing="0"><tr><td bgcolor="#e8e8e8">${legacyFont("Member ID:")}</td><td>${legacyFont(escapeHtml(memberId))}</td></tr><tr><td bgcolor="#e8e8e8">${legacyFont("Account Type:")}</td><td>${legacyFont(escapeHtml(accountType))}</td></tr><tr><td bgcolor="#e8e8e8">${legacyFont("Initial Deposit:")}</td><td>${legacyFont(escapeHtml(deposit))}</td></tr><tr><td bgcolor="#e8e8e8">${legacyFont("Purpose:")}</td><td>${legacyFont(escapeHtml(purpose))}</td></tr></table>`;
  const form = `<form method="post" action="${action}"><input type="hidden" name="f1" value="${escapeHtml(accountType)}"><input type="hidden" name="f2" value="${escapeHtml(deposit)}"><input type="hidden" name="f3" value="${escapeHtml(purpose)}"><br><input type="submit" value="Confirm"></form>`;
  return page(tenant, "Review Sub-Account", `${legacyFont("Review New Sub-Account", "3")}<br><br>${values}${form}`);
}

export function renderValidation(tenant: TenantConfig): string {
  return page(tenant, "Validation Error", messageRow("Initial deposit must be at least $25.00"));
}

export function renderConfirmation(
  tenant: TenantConfig,
  reference: string,
): string {
  return page(tenant, "Sub-Account Created", `<table border="1" cellpadding="3" cellspacing="0" bgcolor="#efffee"><tr><td>${legacyFont("SUB-ACCOUNT CREATED", "3", "#0b6b6b")}</td></tr><tr><td>${legacyFont(`Reference Number: ${escapeHtml(reference)}`)}</td></tr></table>`);
}

export function renderInterstitial(
  tenant: TenantConfig,
  method: string,
  action: string,
  body: Record<string, string>,
): string {
  const hidden = Object.entries(body)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const form = `<form method="${method.toLowerCase() === "post" ? "post" : "get"}" action="${escapeHtml(action)}">${hidden}<input type="submit" value="Continue"></form>`;
  return page(tenant, "SYSTEM MAINTENANCE NOTICE", `${messageRow("SYSTEM MAINTENANCE NOTICE", "#7a1f2b")}${legacyFont("The system is ready to continue your request.")}<br><br>${form}`);
}
