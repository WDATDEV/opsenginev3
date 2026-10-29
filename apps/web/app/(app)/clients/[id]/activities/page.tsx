"use client";

import { ActivitiesBoard } from "@/components/boards/activities-board";
import { ClientService } from "@/components/client-service";

export default function ClientActivitiesPage() {
  return <ClientService service="activities">{(client) => <ActivitiesBoard client={client} />}</ClientService>;
}
