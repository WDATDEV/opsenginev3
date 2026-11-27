"use client";

import { Suspense } from "react";
import { ClientService } from "@/components/client-service";
import { FLOOR_WORK_KINDS, FloorWorkBoard } from "@/components/boards/floor-work-board";
import { SkeletonList } from "@/components/ui";

const KINDS = FLOOR_WORK_KINDS.map(([kind]) => kind);

export default function ClientFloorWorkPage() {
  return (
    <ClientService service="jobs" anyOf={KINDS} title="Floor work">
      {(client) => (
        <Suspense fallback={<SkeletonList rows={3} />}>
          <FloorWorkBoard client={client} services={client.enabledServices} />
        </Suspense>
      )}
    </ClientService>
  );
}
