"use client";

import { ClientService } from "@/components/client-service";
import { SortingBoard } from "@/components/boards/sorting-board";

export default function ClientSortingPage() {
  return <ClientService service="sorting">{(client) => <SortingBoard client={client} />}</ClientService>;
}