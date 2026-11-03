"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession } from "@/components/shell";
import { Notice, SkeletonList, useResource } from "@/components/ui";
import { canOpenService, CLIENT_SERVICES } from "@/lib/api";
import type { ClientRecord } from "@/components/client-dashboard";

// Opening a client lands on its first service, which is Jobs when it is on. The setup page is
// under Settings in the menu. A client with nothing turned on goes to Settings so it can be set up.
export default function ClientHomePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const clients = useResource<ClientRecord[]>("/clients");
  const user = useSession();
  const client = clients.data?.find((item) => item.id === params.id);

  useEffect(() => {
    if (!client || !user) return;
    const first = CLIENT_SERVICES.find(([service]) => client.enabledServices.includes(service) && canOpenService(user.role, service));
    router.replace(first ? `/clients/${client.id}/${first[0]}` : `/clients/${client.id}/settings`);
  }, [client, user, router]);

  if (clients.error) return <Notice tone="bad">{clients.error}</Notice>;
  if (clients.data && !client) return <Notice tone="bad">That client is not on your list.</Notice>;
  return <SkeletonList rows={2} />;
}
