const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
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
};

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
  ["activities", "Activities"],
  ["equipment", "Equipment"],
  ["people", "People"],
  ["checkin", "Check-in"],
  ["reports", "Report"],
  ["invoices", "Invoices"],
] as const;

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

export function when(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export const DEMO_BADGES = [
  ["B-10441", "Amina · own packing station"],
  ["B-10442", "Luis · shared pack station"],
  ["B-10443", "Priya · personal scanner"],
  ["B-10444", "Jonah · shared handheld"],
  ["B-10445", "Mei · receiving"],
  ["B-10446", "Andre · same shipment"],
  ["B-10447", "Rosa · on the truck"],
  ["B-10448", "Sam · join the truck"],
  ["B-10449", "Chris · sorting"],
] as const;
