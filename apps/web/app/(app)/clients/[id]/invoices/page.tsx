"use client";

import { ClientService } from "@/components/client-service";
import { InvoicesBoard } from "@/components/boards/invoices-board";

export default function ClientInvoicesPage() {
  return <ClientService service="invoices">{(client) => <InvoicesBoard clientId={client.id} />}</ClientService>;
}
