"use client";

import { FloorDevicesPanel } from "@/components/floor-access";
import { PageTitle } from "@/components/ui";

export default function FloorDevicesPage() {
  return (
    <div className="max-w-3xl">
      <PageTitle kicker="Time tracking" title="Floor devices" detail="Approve the phones, kiosks, and gates that can record floor work." />
      <FloorDevicesPanel />
    </div>
  );
}
