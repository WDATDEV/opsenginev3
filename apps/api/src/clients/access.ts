import { ConflictException, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { ClientService } from "@opsengine/contracts";
import { clientRecords, type Database } from "@opsengine/db";

const labels: Record<ClientService, string> = {
  jobs: "Jobs",
  receiving: "Receiving",
  unloading: "Unloading",
  packing: "Packing",
  picking: "Picking",
  sorting: "Sorting",
  activities: "Activities",
  equipment: "Equipment",
  people: "People",
  checkin: "Check-in",
};

export function enabledServiceList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function assertClientService(db: Database, clientId: string, service: ClientService) {
  const [client] = await db.select().from(clientRecords).where(eq(clientRecords.id, clientId)).limit(1);
  if (!client) throw new NotFoundException("That client is not on file.");
  if (!enabledServiceList(client.enabledServices).includes(service)) {
    throw new ConflictException(`${labels[service]} is turned off for ${client.name}.`);
  }
  return client;
}
