"use client";

import { ClientService } from "@/components/client-service";
import { PackingBoard } from "@/components/boards/packing-board";

export default function ClientPackingPage() {
  return <ClientService service="packing">{(client) => <PackingBoard client={client} />}</ClientService>;
}
