import type { Wall, Point, Room } from '$lib/models/types';

const EPSILON = 5; // snap distance for matching endpoints

function ptEq(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
}

interface Edge {
  wallId: string;
  start: Point;
  end: Point;
}

/**
 * Result of planar face detection: one entry per detected cycle.
 * `signedArea` follows the shoelace convention used by `detectRooms`:
 * interior faces are positive, the unbounded outer face is negative.
 */
interface Face {
  vertices: Point[];
  wallIds: string[];   // ordered as traversed (may include duplicates when a wall is split)
  uniqueWallIds: string[];
  signedArea: number;
}

/**
 * Split walls at T-junctions so shared-wall rooms are properly separated
 */
function splitWallsAtTJunctions(walls: Wall[]): Edge[] {
  // Collect all endpoints
  const endpoints: Point[] = [];
  for (const w of walls) {
    endpoints.push(w.start, w.end);
  }

  // For each wall, find any endpoints (from other walls) that lie on its interior
  interface SplitWall {
    wallId: string;
    start: Point;
    end: Point;
    splitPoints: { point: Point; t: number }[];
  }

  const splitWalls: SplitWall[] = walls.map(w => ({
    wallId: w.id,
    start: w.start,
    end: w.end,
    splitPoints: [],
  }));

  for (let wi = 0; wi < walls.length; wi++) {
    const w = walls[wi];
    const dx = w.end.x - w.start.x;
    const dy = w.end.y - w.start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < EPSILON * EPSILON) continue;

    for (const ep of endpoints) {
      // Skip if this endpoint is one of the wall's own endpoints
      if (ptEq(ep, w.start) || ptEq(ep, w.end)) continue;

      // Project ep onto the wall segment
      const t = ((ep.x - w.start.x) * dx + (ep.y - w.start.y) * dy) / lenSq;
      if (t <= EPSILON / Math.sqrt(lenSq) || t >= 1 - EPSILON / Math.sqrt(lenSq)) continue;

      // Check distance from ep to the projected point
      const projX = w.start.x + t * dx;
      const projY = w.start.y + t * dy;
      const dist = Math.sqrt((ep.x - projX) ** 2 + (ep.y - projY) ** 2);
      if (dist < EPSILON) {
        // Check we haven't already added a point at this location
        const already = splitWalls[wi].splitPoints.some(sp => ptEq(sp.point, ep));
        if (!already) {
          splitWalls[wi].splitPoints.push({ point: { x: ep.x, y: ep.y }, t });
        }
      }
    }
  }

  // Build edges: for walls with split points, create sub-segments
  const edges: Edge[] = [];
  for (const sw of splitWalls) {
    if (sw.splitPoints.length === 0) {
      edges.push({ wallId: sw.wallId, start: sw.start, end: sw.end });
    } else {
      // Sort split points by t
      sw.splitPoints.sort((a, b) => a.t - b.t);
      let prev = sw.start;
      for (const sp of sw.splitPoints) {
        edges.push({ wallId: sw.wallId, start: prev, end: sp.point });
        prev = sp.point;
      }
      edges.push({ wallId: sw.wallId, start: prev, end: sw.end });
    }
  }

  return edges;
}

/**
 * Run planar face detection on a wall set. Splits T-junctions, then traces
 * minimal cycles using leftmost-turn traversal. Returns every closed face
 * found, including the outer (unbounded) face — callers filter by
 * `signedArea > 0` to keep interior rooms.
 *
 * This is the shared core used by both `detectRooms` and `getRoomPolygon`,
 * which guarantees consistent geometry: the polygon rendered for a room
 * matches the face the auto-detector would have produced.
 */
function findFaces(walls: Wall[]): Face[] {
  if (walls.length < 3) return [];

  const splitEdges = splitWallsAtTJunctions(walls);

  // Build adjacency: collect unique vertices & edges
  const vertices: Point[] = [];

  function findOrAddVertex(p: Point): number {
    for (let i = 0; i < vertices.length; i++) {
      if (ptEq(vertices[i], p)) return i;
    }
    vertices.push({ x: p.x, y: p.y });
    return vertices.length - 1;
  }

  interface IndexedEdge { si: number; ei: number; wallId: string; }
  const edges: IndexedEdge[] = [];
  for (const e of splitEdges) {
    const si = findOrAddVertex(e.start);
    const ei = findOrAddVertex(e.end);
    if (si !== ei) {
      edges.push({ si, ei, wallId: e.wallId });
    }
  }

  // Build adjacency list, sorted by outgoing angle for each vertex
  const adj = new Map<number, { to: number; wallId: string; angle: number }[]>();
  for (const e of edges) {
    const angle1 = Math.atan2(vertices[e.ei].y - vertices[e.si].y, vertices[e.ei].x - vertices[e.si].x);
    const angle2 = Math.atan2(vertices[e.si].y - vertices[e.ei].y, vertices[e.si].x - vertices[e.ei].x);
    if (!adj.has(e.si)) adj.set(e.si, []);
    if (!adj.has(e.ei)) adj.set(e.ei, []);
    adj.get(e.si)!.push({ to: e.ei, wallId: e.wallId, angle: angle1 });
    adj.get(e.ei)!.push({ to: e.si, wallId: e.wallId, angle: angle2 });
  }
  for (const [, neighbors] of adj) {
    neighbors.sort((a, b) => a.angle - b.angle);
  }

  // Trace each directed edge once using leftmost-turn (smallest CW delta) traversal
  const usedDirected = new Set<string>();
  const faces: Face[] = [];
  const maxCycleSteps = edges.length + 1;

  for (const e of edges) {
    for (const [from, to] of [[e.si, e.ei], [e.ei, e.si]]) {
      const startKey = `${from}-${to}`;
      if (usedDirected.has(startKey)) continue;

      const cycle: number[] = [from];
      const wallIds: string[] = [];
      let cur = from;
      let next = to;
      let valid = true;

      for (let step = 0; step < maxCycleSteps; step++) {
        const dk = `${cur}-${next}`;
        if (usedDirected.has(dk)) { valid = false; break; }
        usedDirected.add(dk);
        cycle.push(next);

        const neighbors = adj.get(cur);
        const edgeInfo = neighbors?.find(n => n.to === next);
        if (edgeInfo) wallIds.push(edgeInfo.wallId);

        if (next === from && cycle.length > 3) break;

        const inAngle = Math.atan2(vertices[cur].y - vertices[next].y, vertices[cur].x - vertices[next].x);
        const neighbors2 = adj.get(next);
        if (!neighbors2 || neighbors2.length === 0) { valid = false; break; }

        let bestIdx = -1;
        let bestDelta = Infinity;
        for (let i = 0; i < neighbors2.length; i++) {
          const n = neighbors2[i];
          if (n.to === cur && neighbors2.length > 1) continue;
          let delta = inAngle - n.angle;
          if (delta <= 1e-9) delta += Math.PI * 2;
          if (delta < bestDelta) {
            bestDelta = delta;
            bestIdx = i;
          }
        }
        if (bestIdx === -1) { valid = false; break; }

        cur = next;
        next = neighbors2[bestIdx].to;
      }

      if (!valid || cycle[cycle.length - 1] !== from || cycle.length < 4) continue;

      const poly = cycle.slice(0, -1).map(i => vertices[i]);
      const signedArea = shoelace(poly);
      const uniqueWallIds = [...new Set(wallIds)];

      faces.push({
        vertices: poly,
        wallIds,
        uniqueWallIds,
        signedArea,
      });
    }
  }

  return faces;
}

/**
 * Detect enclosed rooms from a set of walls using planar face detection.
 * Returns detected interior rooms with wall ids and area.
 */
export function detectRooms(walls: Wall[]): Room[] {
  const faces = findFaces(walls);
  const rooms: Room[] = [];
  let roomCount = 0;

  for (const f of faces) {
    // Skip outer (unbounded) face
    if (f.signedArea <= 0) continue;
    const area = f.signedArea;
    // Skip very large or tiny areas
    if (area < 1000 || area > 10000000) continue;

    // Dedup against rooms already produced this run (same unique wall set)
    const dup = rooms.some(r => {
      const rw = new Set(r.walls);
      return f.uniqueWallIds.length === rw.size && f.uniqueWallIds.every(w => rw.has(w));
    });
    if (dup) continue;

    roomCount++;
    rooms.push({
      id: `room-${roomCount}-${Date.now()}`,
      name: `Room ${roomCount}`,
      walls: f.uniqueWallIds,
      floorTexture: 'hardwood',
      area: Math.round(area / 10000 * 100) / 100, // cm² to m²
    });
  }

  return rooms;
}

function shoelace(pts: Point[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return sum / 2;
}

/**
 * Get polygon vertices for a room from its walls.
 *
 * Uses the same planar face detection as `detectRooms` so that:
 *  - Self-touching polygons render correctly (the simple endpoint chain
 *    used previously broke at any vertex where 3+ walls met).
 *  - T-junctions are handled (walls get split into sub-segments).
 *  - The rendered polygon matches what the auto-detector would have found.
 *
 * Matching strategy: pick the interior face whose unique wall-id set has
 * the highest Jaccard overlap with the room's walls. Exact match wins
 * immediately; partial matches fall back gracefully so rooms with a stale
 * or slightly-wrong wall list still render something reasonable.
 */
export function getRoomPolygon(room: Room, walls: Wall[]): Point[] {
  if (!room.walls || room.walls.length < 3) return [];

  const roomSet = new Set(room.walls);
  const faces = findFaces(walls);

  let best: Point[] = [];
  let bestScore = -1;

  for (const f of faces) {
    if (f.signedArea <= 0) continue; // skip outer face
    const faceSet = new Set(f.uniqueWallIds);
    let intersection = 0;
    for (const w of faceSet) {
      if (roomSet.has(w)) intersection++;
    }
    const union = faceSet.size + roomSet.size - intersection;
    const score = union > 0 ? intersection / union : 0;
    // Exact match wins immediately
    if (intersection === roomSet.size && faceSet.size === roomSet.size) {
      return f.vertices;
    }
    if (score > bestScore) {
      bestScore = score;
      best = f.vertices;
    }
  }

  // If nothing overlapped at all, fall back to the old endpoint-chain
  // behaviour so rooms with broken wall lists still produce some shape.
  if (bestScore <= 0) {
    return legacyChain(room, walls);
  }

  return best;
}

function legacyChain(room: Room, walls: Wall[]): Point[] {
  const roomWalls = walls.filter(w => room.walls.includes(w.id));
  if (roomWalls.length < 3) return [];
  const verts: Point[] = [];
  const used = new Set<string>();
  let current = roomWalls[0];
  verts.push(current.start);
  used.add(current.id);
  let tip = current.end;
  for (let i = 0; i < roomWalls.length - 1; i++) {
    verts.push(tip);
    const next = roomWalls.find(w => !used.has(w.id) && (ptEq(w.start, tip) || ptEq(w.end, tip)));
    if (!next) break;
    used.add(next.id);
    tip = ptEq(next.start, tip) ? next.end : next.start;
    current = next;
  }
  return verts;
}

export function roomCentroid(polygon: Point[]): Point {
  const cx = polygon.reduce((s, p) => s + p.x, 0) / polygon.length;
  const cy = polygon.reduce((s, p) => s + p.y, 0) / polygon.length;
  return { x: cx, y: cy };
}
