"use client";

import { Suspense } from "react";
import { ProblemsBoard } from "@/components/boards/problems-board";
import { SkeletonList } from "@/components/ui";

export default function ProblemsPage() {
  return (
    <Suspense fallback={<SkeletonList rows={4} />}>
      <ProblemsBoard />
    </Suspense>
  );
}
