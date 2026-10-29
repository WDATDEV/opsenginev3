"use client";

import { ClientService } from "@/components/client-service";
import { ReceivingBoard } from "@/components/boards/receiving-board";

export default function ClientReceivingPage() {
  return <ClientService service="receiving">{(client) => <ReceivingBoard client={client} />}</ClientService>;
}
