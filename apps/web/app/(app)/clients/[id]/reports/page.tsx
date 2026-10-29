"use client";

import { ClientService } from "@/components/client-service";
import { ReportBoard } from "@/components/boards/report-board";

export default function ClientReportPage() {
  return <ClientService service="reports">{(client) => <ReportBoard clientId={client.id} />}</ClientService>;
}
