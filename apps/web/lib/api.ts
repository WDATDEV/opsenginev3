const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Pages that work without a sign-in. A 401 there is not an expired session.
const OPEN_PAGES = ["/login", "/station"];

// When the saved sign-in is no longer accepted (it expired, or the server's secret changed), the
// page used to show a bare 401 and stay stuck. Clear the stale cookie and go to sign-in instead.
async function endExpiredSession(path: string) {
  if (typeof window === "undefined" || path === "/auth/login" || path === "/auth/logout") return;
  const here = window.location.pathname;
  if (OPEN_PAGES.some((page) => here === page || here.startsWith(`${page}/`))) return;
  await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => undefined);
  window.location.assign(`/login?next=${encodeURIComponent(here)}`);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 401) await endExpiredSession(path);

  if (!res.ok) {
    let message = "Something went wrong.";
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message.join(" ");
      else if (body.message) message = body.message;
    } catch {
      /* keep default */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function post<T>(path: string, body: unknown) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  clientIds: string[] | null;
  sections: string[];
};

export const APP_SECTIONS = [
  ["time", "Time tracking"],
  ["mail", "Mail"],
  ["chat", "Chat"],
  ["users", "Users"],
  ["settings", "Settings"],
] as const;

export function hasSection(user: User | null | undefined, section: string) {
  if (!user) return false;
  if (user.role === "owner") return true;
  return Array.isArray(user.sections) && user.sections.includes(section);
}

export function canManage(role?: string) {
  return role === "owner" || role === "warehouse_manager";
}

export const CLIENT_SERVICES = [
  ["jobs", "Jobs"],
  ["receiving", "Receiving"],
  ["unloading", "Unloading"],
  ["packing", "Packing"],
  ["picking", "Picking"],
  ["sorting", "Sorting"],
  ["qc", "Quality control"],
  ["putaway", "Putaway"],
  ["returns", "Returns"],
  ["replenishment", "Replenishment"],
  ["cycle_count", "Cycle counts"],
  ["people", "People"],
  ["checkin", "Check-in"],
  ["reports", "Report"],
  ["invoices", "Invoices"],
] as const;

// Billed work with no page of its own: it runs as tasks on Jobs. It is turned on in client settings,
// but never gets a menu link.
export const WORK_ONLY_SERVICES = new Set(["qc", "putaway", "returns", "replenishment", "cycle_count"]);

export function hasServicePage(service: string) {
  return !WORK_ONLY_SERVICES.has(service);
}

export const BILL_BASES = [
  ["mixed", "Time and quantity"],
  ["time", "Time only"],
  ["pallet", "Pallet count"],
  ["carton", "Carton count"],
  ["sku", "Each SKU"],
] as const;

export function billBasisLabel(basis: string) {
  return BILL_BASES.find(([code]) => code === basis)?.[1] ?? "Time and quantity";
}

export function canOpenService(role: string | undefined, service: string) {
  if (service === "jobs" || service === "reports" || service === "invoices") {
    return (
      role === "owner" ||
      role === "warehouse_manager" ||
      role === "client_services" ||
      role === "hr_finance" ||
      role === "external_customer"
    );
  }
  return role === "owner" || role === "warehouse_manager" || role === "hr_finance" || role === "warehouse_employee";
}

export function canManageJobs(role?: string) {
  return role === "owner" || role === "warehouse_manager" || role === "client_services";
}

export function canApproveCharges(role?: string) {
  return role === "owner" || role === "warehouse_manager" || role === "hr_finance";
}

export function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

// Today shows only the time. Any other day also shows the date, so old records are not mistaken for today.
export function when(value: string) {
  const date = new Date(value);
  const today = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat("en", {
    ...(today ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
