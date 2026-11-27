"use client";

import { Suspense } from "react";
import { FloorWorkBoard } from "@/components/boards/floor-work-board";
import { SkeletonList } from "@/components/ui";

export default function FloorWorkPage() {
  return (
    <Suspense fallback={<SkeletonList rows={3} />}>
      <FloorWorkBoard />
    </Suspense>
  );
}
