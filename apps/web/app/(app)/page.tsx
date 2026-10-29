"use client";

import { ClientDashboard } from "@/components/client-dashboard";
import { FloorBoard } from "@/components/floor-board";
import { useSession } from "@/components/shell";

export default function HomePage() {
  const user = useSession();
  if (!user) return <p className="text-muted">Loading…</p>;
  if (user.role === "warehouse_employee") return <FloorBoard />;
  return <ClientDashboard />;
}
