"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { api, canManage, post, type User } from "@/lib/api";

const SessionContext = createContext<User | null>(null);

export function useSession() {
  return useContext(SessionContext);
}

const FLOOR_LINKS = [
  ["/", "Floor"],
  ["/packing", "Packing"],
  ["/picking", "Picking"],
  ["/receiving", "Receiving"],
  ["/unloading", "Unloading"],
  ["/sorting", "Sorting"],
  ["/equipment", "Equipment"],
  ["/people", "People"],
  ["/checkin", "Check-in"],
  ["/work", "Follow-ups"],
] as const;

const ADMIN_LINKS = [
  ["/", "Clients"],
  ["/floor", "Floor"],
  ["/work", "Follow-ups"],
] as const;

function linksFor(role?: string): readonly (readonly [string, string])[] {
  if (role === "external_customer") return [["/", "Clients"]];
  if (role === "client_services") return [["/", "Clients"], ["/work", "Follow-ups"]];
  if (role === "hr_finance") return [["/", "Clients"], ["/floor", "Floor"], ["/work", "Follow-ups"]];
  if (role === "owner" || role === "warehouse_manager") return ADMIN_LINKS;
  return FLOOR_LINKS;
}

export function DesktopShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => setUser(null));
  }, []);

  async function logout() {
    await post("/auth/logout", {});
    router.push("/login");
    router.refresh();
  }

  return (
    <SessionContext.Provider value={user}>
      <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
        <aside className="border-b border-black/10 bg-surface md:min-h-screen md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-4 py-4 md:block">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Ops Engine</p>
              <p className="text-lg font-semibold">{canManage(user?.role) ? "Warehance" : "Work tracking"}</p>
            </div>
            <button className="btn btn-ghost md:mt-4" onClick={logout} type="button">
              Sign out
            </button>
          </div>
          <nav className="flex gap-2 overflow-auto px-3 pb-3 md:block md:px-3">
            {linksFor(user?.role).map(([href, label]) => {
              const active =
                href === "/"
                  ? pathname === "/" || pathname.startsWith("/clients")
                  : pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`mb-1 block whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                    active ? "bg-moss text-paper" : "text-ink hover:bg-black/5"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
          <div className="hidden space-y-2 px-4 pb-6 text-sm text-muted md:block">
            <p>{user ? user.name : "Loading session"}</p>
            {user && user.role !== "external_customer" && user.role !== "client_services" ? (
              <>
                <Link className="block text-moss" href="/warehouse">
                  Open floor phone
                </Link>
                <Link className="block text-moss" href="/gate">
                  Open QR gate
                </Link>
              </>
            ) : null}
          </div>
        </aside>
        <main className="px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </SessionContext.Provider>
  );
}
