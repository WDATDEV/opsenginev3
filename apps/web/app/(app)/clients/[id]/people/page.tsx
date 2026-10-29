"use client";

import { PeopleBoard } from "@/components/boards/people-board";
import { ClientService } from "@/components/client-service";

export default function ClientPeoplePage() {
  return <ClientService service="people">{(client) => <PeopleBoard client={client} />}</ClientService>;
}
