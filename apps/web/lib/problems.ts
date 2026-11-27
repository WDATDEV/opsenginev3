/** A link to the Problems page with a new problem already filled in from a shipment, load, or bin. */
export function problemHref(fields: Record<string, string | null | undefined>) {
  const query = new URLSearchParams({ new: "1" });
  for (const [key, value] of Object.entries(fields)) if (value) query.set(key, value);
  return `/problems?${query.toString()}`;
}
