"use client";

import { ClientService } from "@/components/client-service";
import { PickingBoard } from "@/components/boards/picking-board";

export default function ClientPickingPage() {
  return <ClientService service="picking">{(client) => <PickingBoard client={client} />}</ClientService>;
}
