"use client";

import { CheckInBoard } from "@/components/boards/checkin-board";
import { ClientService } from "@/components/client-service";

export default function ClientCheckInPage() {
  return <ClientService service="checkin">{(client) => <CheckInBoard client={client} />}</ClientService>;
}