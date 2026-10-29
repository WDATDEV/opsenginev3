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
};

export function canManage(role?: string) {
  return role === "owner" || role === "warehouse_manager";
}

export function when(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export const DEMO_BADGES = [
  ["B-10441", "Amina · own Warehance login"],
  ["B-10442", "Luis · shared pack station"],
  ["B-10443", "Priya · personal scanner"],
  ["B-10444", "Jonah · shared handheld"],
  ["B-10445", "Mei · receiving"],
  ["B-10446", "Andre · same shipment"],
  ["B-10447", "Rosa · on the truck"],
  ["B-10448", "Sam · join the truck"],
  ["B-10449", "Chris · sorting"],
] as const;
