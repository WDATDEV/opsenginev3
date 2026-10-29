"use client";

import { ClientService } from "@/components/client-service";
import { JobsBoard } from "@/components/boards/jobs-board";

export default function ClientJobsPage() {
  return <ClientService service="jobs">{(client) => <JobsBoard client={client} />}</ClientService>;
}
