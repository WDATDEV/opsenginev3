const TITLE_WORDS: [string, RegExp][] = [
  ["unload_trailer", /\b(unload|unloads|unloading|unloaded|offload|offloading)\b/],
  ["pack_orders", /\b(pack|packs|packing|packed)\b/],
  ["pick_batch", /\b(pick|picks|picking|picked)\b/],
  ["receive_shipment", /\b(receive|receives|receiving|received|count|counts|counting)\b/],
  ["inspect", /\b(inspect|inspects|inspecting|inspection)\b/],
  ["putaway", /\b(putaway|put away)\b/],
  ["sort_gaylord", /\b(sort|sorts|sorting|sorted)\b/],
  ["kitting", /\b(kit|kits|kitting)\b/],
  ["labeling", /\b(label|labels|labeling|labelling|relabel|relabels|relabeling|relabelling)\b/],
  ["returns", /\b(return|returns)\b/],
];

/**
 * The kinds of work a job is for, from its tasks and its title.
 * Null means the job does not say, so any work the client has turned on may be used.
 */
export function jobWorkCodes(title: string, taskCodes: (string | null | undefined)[] = []) {
  const said = title.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const codes = new Set(TITLE_WORDS.filter(([, words]) => words.test(said)).map(([code]) => code));
  for (const code of taskCodes) if (code) codes.add(code);
  return codes.size > 0 ? [...codes] : null;
}

export function workFitsJob(code: string, codes: string[] | null) {
  return !codes || codes.includes(code);
}
