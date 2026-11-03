"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { api, canOpenService, CLIENT_SERVICES, post, type User } from "@/lib/api";
import { initials } from "@/components/ui";

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

function linkActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname === "/clients";
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ---------------------------------------------------------------- icons

type IconName = "clock" | "mail" | "settings" | "menu" | "close" | "logout" | "grid";

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  clock: (
    <>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 5.8V10l2.8 1.8" />
    </>
  ),
  mail: (
    <>
      <rect x="2.75" y="4.5" width="14.5" height="11" rx="2" />
      <path d="m3.5 6 6.5 4.8L16.5 6" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.75v1.7M10 15.55v1.7M17.25 10h-1.7M4.45 10h-1.7M15.1 4.9l-1.2 1.2M6.1 13.9l-1.2 1.2M15.1 15.1l-1.2-1.2M6.1 6.1 4.9 4.9" />
    </>
  ),
  menu: <path d="M3 5.5h14M3 10h14M3 14.5h14" />,
  close: <path d="m5 5 10 10M15 5 5 15" />,
  logout: <path d="M8 4.5H5.5A1.5 1.5 0 0 0 4 6v8a1.5 1.5 0 0 0 1.5 1.5H8M12 6.5 15.5 10 12 13.5M15.5 10H8" />,
  grid: (
    <>
      <rect x="3" y="3" width="5.5" height="5.5" rx="1.2" />
      <rect x="11.5" y="3" width="5.5" height="5.5" rx="1.2" />
      <rect x="3" y="11.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.2" />
    </>
  ),
};

function Icon({ name, className = "h-[18px] w-[18px]" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`${className} flex-none`} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {ICON_PATHS[name]}
    </svg>
  );
}

// ---------------------------------------------------------------- sidebar pieces

function MainTab({ href, label, icon, active }: { href: string; label: string; icon: IconName; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`mb-1 flex items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
        active ? "bg-moss text-paper shadow-sm" : "text-ink/80 hover:bg-black/5 hover:text-ink"
      }`}
    >
      <Icon name={icon} />
      {label}
    </Link>
  );
}

function SubTabs({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 ml-[1.15rem] border-l border-black/10 pl-2">{children}</div>;
}

function SubLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`mb-0.5 block whitespace-nowrap rounded-lg py-2 pl-3 pr-3 text-sm transition-colors ${
        active ? "bg-moss/10 font-semibold text-moss" : "text-ink/75 hover:bg-black/5 hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}

function roleLabel(role?: string) {
  if (!role) return "";
  const text = role.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function DesktopShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [navClients, setNavClients] = useState<NavClient[] | null>(null);
  const [navTick, setNavTick] = useState(0);
  // On a phone the menu is a drawer. It closes by itself when the page changes.
  const [drawer, setDrawer] = useState(false);
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

  useEffect(() => {
    setDrawer(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  async function logout() {
    await post("/auth/logout", {});
    router.push("/login");
    router.refresh();
  }

  const insideClient = navClients?.find((client) => client.id === clientId) ?? null;
  const clientServices = insideClient
    ? CLIENT_SERVICES.filter(([service]) => insideClient.enabledServices.includes(service) && canOpenService(user?.role, service))
    : [];
  const timeActive = !pathname.startsWith("/mail") && !pathname.startsWith("/settings");
  const mailActive = pathname.startsWith("/mail");
  const settingsActive = pathname.startsWith("/settings");
  const showMail = user?.role === "owner" || user?.role === "warehouse_manager";

  return (
    <SessionContext.Provider value={user}>
      <ClientNavContext.Provider value={reloadClientNav}>
        <div className="min-h-screen md:grid md:grid-cols-[256px_1fr]">
          {/* Phone top bar */}
          <header className="sticky top-0 z-30 flex items-center justify-between border-b border-black/10 bg-surface/90 px-4 py-3 backdrop-blur md:hidden">
            <Brand />
            <button className="btn btn-ghost btn-sm" type="button" aria-label="Open menu" aria-expanded={drawer} onClick={() => setDrawer(true)}>
              <Icon name="menu" />
            </button>
          </header>

          {drawer ? <button className="fixed inset-0 z-40 bg-ink/40 md:hidden" type="button" aria-label="Close menu" onClick={() => setDrawer(false)} /> : null}

          <aside
            className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-black/10 bg-surface transition-transform duration-200 md:sticky md:top-0 md:z-auto md:h-screen md:w-auto md:max-w-none md:translate-x-0 md:self-start ${
              drawer ? "translate-x-0 shadow-xl" : "-translate-x-full"
            }`}
          >
            <div className="flex items-center justify-between px-4 pb-2 pt-5">
              <Brand />
              <button className="btn btn-ghost btn-sm md:hidden" type="button" aria-label="Close menu" onClick={() => setDrawer(false)}>
                <Icon name="close" />
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto px-3 pb-3 pt-3" aria-label="Main">
              <div>
                <MainTab href="/" label="Time tracking" icon="clock" active={timeActive} />
                {timeActive ? (
                  <SubTabs>
                    {clientId ? (
                      <>
                        <Link href="/" className="mb-1 flex items-center gap-2 whitespace-nowrap rounded-lg py-2 pl-3 pr-3 text-sm text-ink/75 transition-colors hover:bg-black/5 hover:text-ink">
                          <Icon name="grid" className="h-4 w-4" />
                          Main menu
                        </Link>
                        {insideClient ? (
                          <>
                            <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{insideClient.name}</p>
                            {clientServices.map(([service, label]) => {
                              const href = `/clients/${insideClient.id}/${service}`;
                              return <SubLink key={service} href={href} label={label} active={pathname === href || pathname.startsWith(`${href}/`)} />;
                            })}
                            {/* Which services are on and what they cost. Set up once, so it sits apart at the bottom. */}
                            {user?.role !== "external_customer" ? (
                              <div className="mt-2 border-t border-black/10 pt-2">
                                <SubLink
                                  href={`/clients/${insideClient.id}/settings`}
                                  label="Settings"
                                  active={pathname === `/clients/${insideClient.id}/settings`}
                                />
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <p className="px-3 py-2 text-sm text-muted">{navClients ? "That client is not on your list." : "Loading…"}</p>
                        )}
                      </>
                    ) : (
                      <>
                        {linksFor(user?.role).map(([href, label]) => (
                          <SubLink key={href} href={href} label={label} active={linkActive(pathname, href)} />
                        ))}
                        {user && user.role !== "external_customer" && user.role !== "client_services" ? (
                          <div className="mt-3 space-y-1.5 px-3 text-sm">
                            <Link className="block text-moss hover:underline" href="/phone">
                              Open floor phone
                            </Link>
                            <Link className="block text-moss hover:underline" href="/gate">
                              Open QR gate
                            </Link>
                          </div>
                        ) : null}
                      </>
                    )}
                  </SubTabs>
                ) : null}
              </div>

              {showMail ? (
                <div>
                  <MainTab href="/mail" label="Mail" icon="mail" active={mailActive} />
                  {mailActive ? (
                    <SubTabs>
                      <SubLink href="/mail" label="Inbox" active={pathname === "/mail"} />
                      <SubLink href="/mail/automation" label="Email automation" active={pathname.startsWith("/mail/automation")} />
                      <SubLink href="/mail/bulk" label="Bulk email" active={pathname.startsWith("/mail/bulk")} />
                    </SubTabs>
                  ) : null}
                </div>
              ) : null}

              {user?.role === "owner" ? (
                <div>
                  <MainTab href="/settings" label="Settings" icon="settings" active={settingsActive} />
                  {settingsActive ? (
                    <SubTabs>
                      <SubLink href="/settings" label="Connectors" active />
                    </SubTabs>
                  ) : null}
                </div>
              ) : null}
            </nav>

            {/* Who is signed in, with sign out always in reach */}
            <div className="border-t border-black/10 p-3">
              <div className="flex items-center gap-3 rounded-xl px-2 py-2">
                <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-moss/15 text-sm font-semibold text-moss">
                  {user ? initials(user.name) : "…"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{user ? user.name : "Loading session"}</p>
                  <p className="truncate text-xs text-muted">{roleLabel(user?.role)}</p>
                </div>
                <button className="btn btn-ghost btn-sm !px-2" type="button" aria-label="Sign out" title="Sign out" onClick={logout}>
                  <Icon name="logout" />
                </button>
              </div>
            </div>
          </aside>

          <main className="min-w-0 px-4 py-6 md:px-10 md:py-9">{children}</main>
        </div>
      </ClientNavContext.Provider>
    </SessionContext.Provider>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-moss text-sm font-bold text-paper shadow-sm">O</span>
      <span className="text-[17px] font-semibold tracking-tight">Ops Engine</span>
    </Link>
  );
}
