/** Agent response hierarchy — lower rank = respond first.
 *
 * There is deliberately no built-in default. This used to hardcode three agent names belonging to
 * one fleet (the fleet whose supervisor session this repo was developed in), so every OTHER
 * installation ranked those strangers first and its own agents last — a fleet artifact presented
 * as a sensible default. Set OPENCADRE_HIERARCHY to the names you want answered first; unset,
 * every agent ties and entries keep the order they arrived in.
 *
 * Do not reintroduce the old names, even in a comment: tests/watcher-scripts.test.ts greps this
 * file for them and fails, because a default that ships to every customer must name nobody. */
const DEFAULT_HIERARCHY = [];

export function hierarchyList() {
  const raw = process.env.OPENCADRE_HIERARCHY ?? DEFAULT_HIERARCHY.join(",");
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function hierarchyRank(agentName) {
  const list = hierarchyList();
  const idx = list.indexOf(agentName);
  return idx === -1 ? list.length + 1 : idx;
}

export function sortByHierarchy(entries) {
  return [...entries].sort((a, b) => {
    const fromA = a.from ?? a.inbound?.from ?? "";
    const fromB = b.from ?? b.inbound?.from ?? "";
    const rankDiff = hierarchyRank(fromA) - hierarchyRank(fromB);
    if (rankDiff !== 0) return rankDiff;
    return (a.at ?? a.inbound?.at ?? "").localeCompare(b.at ?? b.inbound?.at ?? "");
  });
}
