function key(x, y) { return `${x},${y}`; }
function h(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  const min = Math.min(dx, dy);
  const max = Math.max(dx, dy);
  return (Math.SQRT2 * min) + (max - min);
}

export function findPathAStar(map, sx, sy, tx, ty, maxExpand = 600) {
  if (sx === tx && sy === ty) return [{ x: sx, y: sy }];
  if (map.isBlocked(tx, ty)) return null;

  const open = [{ x: sx, y: sy, g: 0, f: h(sx, sy, tx, ty) }];
  const came = new Map();
  const gScore = new Map([[key(sx, sy), 0]]);
  const inOpen = new Set([key(sx, sy)]);

  let expanded = 0;

  while (open.length && expanded < maxExpand) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    inOpen.delete(key(cur.x, cur.y));
    expanded++;

    if (cur.x === tx && cur.y === ty) {
      const out = [{ x: tx, y: ty }];
      let ck = key(tx, ty);
      while (came.has(ck)) {
        const prev = came.get(ck);
        out.push({ x: prev.x, y: prev.y });
        ck = key(prev.x, prev.y);
      }
      out.reverse();
      return out;
    }

    const neigh = [
      { x: cur.x + 1, y: cur.y, cost: 1 },
      { x: cur.x - 1, y: cur.y, cost: 1 },
      { x: cur.x, y: cur.y + 1, cost: 1 },
      { x: cur.x, y: cur.y - 1, cost: 1 },
      { x: cur.x + 1, y: cur.y + 1, cost: Math.SQRT2 },
      { x: cur.x + 1, y: cur.y - 1, cost: Math.SQRT2 },
      { x: cur.x - 1, y: cur.y + 1, cost: Math.SQRT2 },
      { x: cur.x - 1, y: cur.y - 1, cost: Math.SQRT2 },
    ];

    for (const n of neigh) {
      if (n.x < 0 || n.y < 0 || n.x >= map.w || n.y >= map.h) continue;
      if (map.isBlocked(n.x, n.y)) continue;
      const isDiagonal = n.x !== cur.x && n.y !== cur.y;
      if (isDiagonal) {
        const blockHorizontal = map.isBlocked(n.x, cur.y);
        const blockVertical = map.isBlocked(cur.x, n.y);
        if (blockHorizontal || blockVertical) continue;
      }

      const nk = key(n.x, n.y);
      const tentative = cur.g + n.cost;
      const best = gScore.get(nk);

      if (best === undefined || tentative < best) {
        came.set(nk, { x: cur.x, y: cur.y });
        gScore.set(nk, tentative);
        const f = tentative + h(n.x, n.y, tx, ty);
        if (!inOpen.has(nk)) {
          open.push({ x: n.x, y: n.y, g: tentative, f });
          inOpen.add(nk);
        }
      }
    }
  }

  return null;
}
