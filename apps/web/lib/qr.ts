export function badgePayload(badge: string) {
  return `OE-BADGE:${badge.trim()}`;
}

export function badgeFromScan(raw: string) {
  const text = raw.trim();
  const match = /^OE-BADGE:(.+)$/i.exec(text);
  return (match?.[1] ?? text).trim();
}
