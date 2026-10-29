"use client";

import { EquipmentBoard } from "@/components/boards/equipment-board";
import { ClientService } from "@/components/client-service";

export default function ClientEquipmentPage() {
  return <ClientService service="equipment">{(client) => <EquipmentBoard client={client} />}</ClientService>;
}
