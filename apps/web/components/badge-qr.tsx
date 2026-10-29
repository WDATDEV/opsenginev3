"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { badgePayload } from "@/lib/qr";

export function BadgeQr({ badge, size = 168 }: { badge: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(badgePayload(badge), { margin: 1, width: size, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [badge, size]);

  if (!src) {
    return <div className="grid place-items-center bg-white text-xs text-muted" style={{ width: size, height: size }} />;
  }

  return <img src={src} alt={`QR ID for ${badge}`} width={size} height={size} />;
}
