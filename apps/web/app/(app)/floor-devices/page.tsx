"use client";

import { FloorDevicesPanel } from "@/components/floor-access";
import { PageTitle } from "@/components/ui";

export default function FloorDevicesPage() {
  return (
    <div className="max-w-3xl">
      <PageTitle kicker="Time tracking" title="Floor devices" detail="Approve the iPads your staff use as the floor phone. Open this page on the iPad itself, approve it, then sign out. From then on anyone can check in on it with their badge, without signing in." />
      <FloorDevicesPanel />
    </div>
  );
}
