"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PackingBoard } from "@/components/boards/packing-board";
import { PickingBoard } from "@/components/boards/picking-board";
import { ReceivingBoard } from "@/components/boards/receiving-board";
import { SortingBoard } from "@/components/boards/sorting-board";
import { UnloadingBoard } from "@/components/boards/unloading-board";
import { EmptyRow, Segmented } from "@/components/ui";

// One page for all floor work on jobs. A filter picks which kind of work to show.
export const FLOOR_WORK_KINDS = [
  ["receiving", "Receiving"],
  ["unloading", "Unloading"],
  ["packing", "Packing"],
  ["picking", "Picking"],
  ["sorting", "Sorting"],
] as const;

type Kind = (typeof FLOOR_WORK_KINDS)[number][0];

export function FloorWorkBoard({ client, services }: { client?: { id: string; name: string }; services?: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const options = FLOOR_WORK_KINDS.filter(([kind]) => !services || services.includes(kind));

  if (options.length === 0) {
    return (
      <div className="card">
        <EmptyRow title="No floor work is turned on">Turn on receiving, unloading, packing, picking or sorting in this client&apos;s settings.</EmptyRow>
      </div>
    );
  }

  const asked = params.get("type");
  const kind: Kind = options.find(([code]) => code === asked)?.[0] ?? options[0][0];

  function choose(next: Kind) {
    const query = new URLSearchParams(params.toString());
    query.set("type", next);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  return (
    <div>
      <div className="mb-4">
        <Segmented label="Kind of work" options={options} value={kind} onChange={choose} />
      </div>
      {kind === "receiving" ? <ReceivingBoard client={client} /> : null}
      {kind === "unloading" ? <UnloadingBoard client={client} /> : null}
      {kind === "packing" ? <PackingBoard client={client} /> : null}
      {kind === "picking" ? <PickingBoard client={client} /> : null}
      {kind === "sorting" ? <SortingBoard client={client} /> : null}
    </div>
  );
}
