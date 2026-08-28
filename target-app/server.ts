import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getMember } from "./data.js";
import {
  consumeSticky,
  consumeTransient,
  injectionModes,
  resetInjection,
  setInjection,
  type InjectionMode,
} from "./inject.js";
import {
  renderConfirmation,
  renderFrameset,
  renderInterstitial,
  renderLogin,
  renderMember,
  renderNav,
  renderNotFound,
  renderPermissionDenied,
  renderSearch,
  renderSubaccountNew,
  renderValidation,
  renderReview,
} from "./render.js";
import { getTenant, type TenantName } from "./tenants.js";

const app = express();
const sessions = new Map<string, { createdAt: string }>();
const referenceCounters = new Map<string, number>();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function textField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return "";
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie ?? "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) {
      return valueParts.join("=");
    }
  }
  return undefined;
}

function sessionId(req: Request): string | undefined {
  const value = cookieValue(req, "msc_sid");
  return value && sessions.has(value) ? value : undefined;
}

function tenantFor(req: Request): { name: TenantName; config: NonNullable<ReturnType<typeof getTenant>> } {
  const name = req.params.tenant as TenantName;
  const config = getTenant(name);
  if (!config) {
    throw new Error("Unknown tenant");
  }
  return { name, config };
}

function requireSession(
  req: Request,
  res: Response,
  tenantName: TenantName,
  tenant: NonNullable<ReturnType<typeof getTenant>>,
): string | undefined {
  const id = sessionId(req);
  if (!id) {
    res.status(200).send(renderLogin(tenant, tenantName, "Your session has expired."));
    return undefined;
  }
  return id;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function applyTransientInjection(
  req: Request,
  res: Response,
  tenantName: TenantName,
  tenant: NonNullable<ReturnType<typeof getTenant>>,
  session: string,
): Promise<boolean> {
  const mode = consumeTransient();
  if (!mode) {
    return false;
  }

  if (mode === "slow") {
    await delay(6000);
    return false;
  }

  if (mode === "session_expired") {
    sessions.delete(session);
    res.status(200).send(renderLogin(tenant, tenantName, "Your session has expired."));
    return true;
  }

  if (mode === "app_error") {
    res.status(500).send("APPLICATION ERROR - REF 0x5A2");
    return true;
  }

  if (mode === "interstitial") {
    const fields: Record<string, string> = {};
    for (const field of ["q", "f1", "f2", "f3"]) {
      const value = textField(req.body?.[field]);
      if (value) {
        fields[field] = value;
      }
    }
    res.status(200).send(renderInterstitial(tenant, req.method, req.originalUrl, fields));
    return true;
  }

  return false;
}

function nextReference(memberId: string): string {
  const next = (referenceCounters.get(memberId) ?? 0) + 1;
  referenceCounters.set(memberId, next);
  return `SA-${memberId}-${String(next).padStart(4, "0")}`;
}

// Demo entry point, deliberately outside the /t/:tenant/msc surface that capabilities
// automate: nothing recorded or replayed ever navigates here.
app.get("/", (_req, res) => {
  res.sendFile(resolve(dirname(fileURLToPath(import.meta.url)), "public", "index.html"));
});

app.get("/_health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/_inject", (req, res) => {
  const mode = textField(req.body?.mode) as InjectionMode;
  if (!injectionModes.includes(mode)) {
    res.status(400).json({ error: "Unknown injection mode" });
    return;
  }
  const ttlValue = req.body?.ttlRequests;
  const ttlRequests = typeof ttlValue === "number" ? ttlValue : undefined;
  res.json(setInjection(mode, ttlRequests));
});

// Clears injection state (and reference counters) but NOT sessions by default, so a test can
// reset the error-injection between cases without silently logging the live browser out.
// Pass {sessions:true} to clear operator sessions as well.
app.post("/_reset", (req, res) => {
  resetInjection();
  referenceCounters.clear();
  if (req.body?.sessions === true) {
    sessions.clear();
  }
  res.json({ ok: true, sessionsCleared: req.body?.sessions === true });
});

app.use("/t/:tenant/msc", (req, res, next) => {
  if (!getTenant(req.params.tenant)) {
    res.status(404).send("Not found");
    return;
  }
  next();
});

app.get("/t/:tenant/msc/login", (req, res) => {
  const { name, config } = tenantFor(req);
  res.send(renderLogin(config, name));
});

app.post("/t/:tenant/msc/login", (req, res) => {
  const { name, config } = tenantFor(req);
  const user = process.env.APP_USER ?? "OPER01";
  const password = process.env.APP_PASSWORD ?? "demo-pass-01";
  if (textField(req.body?.u) !== user || textField(req.body?.p) !== password) {
    res.status(200).send(renderLogin(config, name, "Invalid operator credentials."));
    return;
  }
  const id = randomUUID();
  sessions.set(id, { createdAt: new Date().toISOString() });
  res.setHeader("Set-Cookie", `msc_sid=${id}; Path=/; HttpOnly`);
  res.redirect(`/t/${name}/msc/console`);
});

app.get("/t/:tenant/msc/console", (req, res) => {
  const { name, config } = tenantFor(req);
  if (!sessionId(req)) {
    res.redirect(`/t/${name}/msc/login`);
    return;
  }
  res.send(renderFrameset(config, name));
});

app.get("/t/:tenant/msc/nav", (req, res) => {
  const { name, config } = tenantFor(req);
  if (!requireSession(req, res, name, config)) {
    return;
  }
  res.send(renderNav(config, name));
});

app.get("/t/:tenant/msc/search", async (req, res) => {
  const { name, config } = tenantFor(req);
  const session = requireSession(req, res, name, config);
  if (!session) {
    return;
  }
  if (await applyTransientInjection(req, res, name, config, session)) {
    return;
  }
  res.send(renderSearch(config, name));
});

app.post("/t/:tenant/msc/search", async (req, res) => {
  const { name, config } = tenantFor(req);
  const session = requireSession(req, res, name, config);
  if (!session) {
    return;
  }
  if (await applyTransientInjection(req, res, name, config, session)) {
    return;
  }
  const id = textField(req.body?.q);
  if (consumeSticky("not_found") || !getMember(id)) {
    res.send(renderNotFound(config, id));
    return;
  }
  res.redirect(`/t/${name}/msc/member/${encodeURIComponent(id)}`);
});

app.get("/t/:tenant/msc/member/:id", async (req, res) => {
  const { name, config } = tenantFor(req);
  const session = requireSession(req, res, name, config);
  if (!session) {
    return;
  }
  if (await applyTransientInjection(req, res, name, config, session)) {
    return;
  }
  const member = getMember(req.params.id);
  if (!member) {
    res.send(renderNotFound(config, req.params.id));
    return;
  }
  if (member.restricted || consumeSticky("permission_denied")) {
    res.send(renderPermissionDenied(config));
    return;
  }
  res.send(renderMember(config, member));
});

app.get("/t/:tenant/msc/subaccount/new", async (req, res) => {
  const { name, config } = tenantFor(req);
  const session = requireSession(req, res, name, config);
  if (!session) {
    return;
  }
  if (await applyTransientInjection(req, res, name, config, session)) {
    return;
  }
  const memberId = textField(req.query.member);
  const member = getMember(memberId);
  if (!member) {
    res.send(renderNotFound(config, memberId));
    return;
  }
  if (member.restricted) {
    res.send(renderPermissionDenied(config));
    return;
  }
  res.send(renderSubaccountNew(config, name, member));
});

app.post("/t/:tenant/msc/subaccount/review", async (req, res) => {
  const { name, config } = tenantFor(req);
  const session = requireSession(req, res, name, config);
  if (!session) {
    return;
  }
  if (await applyTransientInjection(req, res, name, config, session)) {
    return;
  }
  const memberId = textField(req.query.member);
  const member = getMember(memberId);
  if (!member) {
    res.send(renderNotFound(config, memberId));
    return;
  }
  if (member.restricted) {
    res.send(renderPermissionDenied(config));
    return;
  }
  const accountType = textField(req.body?.f1);
  const deposit = textField(req.body?.f2);
  const purpose = textField(req.body?.f3);
  const parsedDeposit = Number(deposit.replaceAll(",", "").replace("$", ""));
  if (consumeSticky("validation") || !Number.isFinite(parsedDeposit) || parsedDeposit < 25) {
    res.send(renderValidation(config));
    return;
  }
  res.send(renderReview(config, name, memberId, accountType, deposit, purpose));
});

app.post("/t/:tenant/msc/subaccount/confirm", async (req, res) => {
  const { name, config } = tenantFor(req);
  const session = requireSession(req, res, name, config);
  if (!session) {
    return;
  }
  if (await applyTransientInjection(req, res, name, config, session)) {
    return;
  }
  const memberId = textField(req.query.member);
  const member = getMember(memberId);
  if (!member) {
    res.send(renderNotFound(config, memberId));
    return;
  }
  if (member.restricted) {
    res.send(renderPermissionDenied(config));
    return;
  }
  res.send(renderConfirmation(config, nextReference(memberId)));
});

app.get("/t/:tenant/msc/signoff", (req, res) => {
  const { name, config } = tenantFor(req);
  if (!requireSession(req, res, name, config)) {
    return;
  }
  const id = cookieValue(req, "msc_sid");
  if (id) {
    sessions.delete(id);
  }
  res.redirect(`/t/${name}/msc/login`);
});

app.use((_req, res) => {
  res.status(404).send("Not found");
});

export { app };

// Accepts an explicit port so tests can bind a dedicated one without mutating process.env
// (which would race across parallel test files).
export function startServer(port = Number(process.env.TARGET_APP_PORT ?? "4599")): ReturnType<typeof app.listen> {
  return app.listen(port, (error?: Error) => {
    if (error) throw error;
    console.log(`Ledgerhand target app listening on port ${port}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
