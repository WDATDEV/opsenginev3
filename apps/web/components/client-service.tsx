"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Notice, PageTitle, SkeletonList, Spinner, useResource } from "@/components/ui";
import { CLIENT_SERVICES } from "@/lib/api";
import type { ClientRecord } from "@/components/client-dashboard";

export function ClientService({
  service,
  children,
}: {
  service: (typeof CLIENT_SERVICES)[number][0];
  children: (client: ClientRecord) => React.ReactNode;
}) {
  const params = useParams<{ id: string }>();
  const clients = useResource<ClientRecord[]>("/clients");
  const client = clients.data?.find((item) => item.id === params.id);
  const label = CLIENT_SERVICES.find(([code]) => code === service)?.[1] ?? service;

  if (clients.error) return <Notice tone="bad">{clients.error}</Notice>;
  if (clients.loading && !clients.data) {
    return (
      <div>
        <SkeletonList rows={3} />
        <p className="mt-3">
          <Spinner label="Loading this client" />
        </p>
      </div>
    );
  }
  if (!clients.data) return <Notice tone="bad">Could not load clients.</Notice>;
  if (!client) return <Notice tone="bad">That client is not on your list.</Notice>;
  if (!client.enabledServices.includes(service)) {
    return (
      <div>
        <PageTitle
          kicker={client.name}
          title={`${label} is off`}
          detail={`Turn ${label.toLowerCase()} on for ${client.name} before opening it.`}
        />
        <Link className="text-sm text-moss" href={`/clients/${client.id}/settings`}>
          Open {client.name} settings
        </Link>
      </div>
    );
  }
  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-sm text-muted">
        <Link className="hover:text-ink hover:underline" href="/">
          Clients
        </Link>
        <span aria-hidden="true">/</span>
        <span className="truncate">{client.name}</span>
        <span aria-hidden="true">/</span>
        <span className="font-medium text-ink" aria-current="page">
          {label}
        </span>
      </nav>
      {children(client)}
    </div>
  );
}
