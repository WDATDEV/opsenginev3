"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { api, canOpenService, CLIENT_SERVICES, post, type User } from "@/lib/api";

const SessionContext = createContext<User | null>(null);
const ClientNavContext = createContext<() => void>(() => {});

export function useSession() {
  return useContext(SessionContext);
}

export function useReloadClientNav() {
  return useContext(ClientNavContext);
}

type NavClient = { id: string; name: string; code: string; enabledServices: string[] };

function clientIdFromPath(pathname: string) {
  const match = pathname.match(/^\/clients\/([^/]+)/);
  return match?.[1] ?? null;
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

function MenuIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
    </svg>
  );
}

export function DesktopShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [navClients, setNavClients] = useState<NavClient[] | null>(null);
  const [navTick, setNavTick] = useState(0);
  const clientId = clientIdFromPath(pathname);
  const reloadClientNav = () => setNavTick((tick) => tick + 1);

  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user || !clientId) return;
    let cancelled = false;
    api<NavClient[]>("/clients")
      .then((rows) => {
        if (!cancelled) setNavClients(rows);
      })
      .catch(() => {
        if (!cancelled) setNavClients([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user, clientId, navTick]);

  async function logout() {
    await post("/auth/logout", {});
    router.push("/login");
    router.refresh();
  }

  const insideClient = navClients?.find((client) => client.id === clientId) ?? null;
  const clientServices = insideClient
    ? CLIENT_SERVICES.filter(([service]) => insideClient.enabledServices.includes(service) && canOpenService(user?.role, service))
    : [];

  return (
    <SessionContext.Provider value={user}>
      <ClientNavContext.Provider value={reloadClientNav}>
      <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
        <aside className="border-b border-black/10 bg-surface md:min-h-screen md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-4 py-4 md:block">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">Ops Engine</p>
              <p className="text-lg font-semibold">Work tracking</p>
            </div>
            <button className="btn btn-ghost md:mt-4" onClick={logout} type="button">
              Sign out
            </button>
          </div>
          <nav className="flex gap-2 overflow-auto px-3 pb-3 md:block md:px-3">
            {clientId ? (
              <>
                <Link href="/" className="mb-1 flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm text-ink hover:bg-black/5">
                  <MenuIcon />
                  Main menu
                </Link>
                {insideClient ? (
                  <>
                <p className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{insideClient.name}</p>
                <Link
                  href={`/clients/${insideClient.id}`}
                  className={`mb-1 block whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                    pathname === `/clients/${insideClient.id}` ? "bg-moss text-paper" : "text-ink hover:bg-black/5"
                  }`}
                >
                  Services
                </Link>
                {clientServices.map(([service, label]) => {
                  const href = `/clients/${insideClient.id}/${service}`;
                  const active = pathname === href || pathname.startsWith(`${href}/`);
                  return (
                    <Link
                      key={service}
                      href={href}
                      className={`mb-1 block whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                        active ? "bg-moss text-paper" : "text-ink hover:bg-black/5"
                      }`}
                    >
                      {label}
                    </Link>
                  );
                })}
                  </>
                ) : (
                  <p className="px-3 py-2 text-sm text-muted">{navClients ? "That client is not on your list." : "Loading…"}</p>
                )}
              </>
            ) : (
              linksFor(user?.role).map(([href, label]) => {
                const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
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
              })
            )}
          </nav>
          <div className="hidden space-y-2 px-4 pb-6 text-sm text-muted md:block">
            <p>{user ? user.name : "Loading session"}</p>
            {user && !clientId && user.role !== "external_customer" && user.role !== "client_services" ? (
              <>
                <Link className="block text-moss" href="/phone">
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
      </ClientNavContext.Provider>
    </SessionContext.Provider>
  );
}
