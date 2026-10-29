"use client";

import { ClientService } from "@/components/client-service";
import { UnloadingBoard } from "@/components/boards/unloading-board";

export default function ClientUnloadingPage() {
  return <ClientService service="unloading">{(client) => <UnloadingBoard client={client} />}</ClientService>;
}
