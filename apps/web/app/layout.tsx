import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Ops Engine",
  description: "Employee work tracking for packing, picking, receiving, unloading, and sorting.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Browser extensions add attributes to these two tags before React loads. This only silences that, not real mismatches inside the page.
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable} font-sans antialiased`} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
