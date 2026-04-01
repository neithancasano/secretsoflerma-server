import fs from "node:fs";

export function loadMap() {
  const raw = JSON.parse(fs.readFileSync(new URL("./map.json", import.meta.url)));
  return { w: raw.w, h: raw.h, blocked: new Set(raw.blocked || []) };
}

export function isBlocked(map, x, y) {
  return map.blocked.has(`${x},${y}`);
}
