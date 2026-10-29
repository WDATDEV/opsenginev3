import { DesktopShell } from "@/components/shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <DesktopShell>{children}</DesktopShell>;
}
