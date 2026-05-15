/**
 * Verification script for issues #4 and #5.
 *
 * Scenario A (issue #5): Rectangle split by a vertical wall in the middle.
 *   Expected: 2 rooms detected, total area = original area (not doubled).
 *
 * Scenario B (issue #4): The 2-Bedroom House template wall layout.
 *   Expected per the issue's resolution comment: multiple rooms detected
 *   (including the hallway, which is what the user reported as missing),
 *   totalling ~80 m². The exact count depends on the template's geometry
 *   (small connector strips between rooms count as their own enclosed faces).
 *
 * Run with: npx tsx test-room-detection.ts
 */
import { detectRooms } from './src/lib/utils/roomDetection.js';

interface Wall { id: string; start: { x: number; y: number }; end: { x: number; y: number }; thickness: number; }

let wallCount = 0;
function wall(x1: number, y1: number, x2: number, y2: number): Wall {
  wallCount++;
  return { id: `w${wallCount}`, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 10 };
}

function rectWalls(x: number, y: number, w: number, h: number): Wall[] {
  return [
    wall(x, y, x + w, y),         // top
    wall(x + w, y, x + w, y + h), // right
    wall(x + w, y + h, x, y + h), // bottom
    wall(x, y + h, x, y),         // left
  ];
}

let allPassed = true;
function check(label: string, ok: boolean, details: string) {
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${label}: ${details}`);
  if (!ok) allPassed = false;
}

// ─────────────────────────────────────────────────────────────────
// Scenario A — issue #5: split rectangle
// ─────────────────────────────────────────────────────────────────
console.log('\n=== Scenario A: rectangle 500x400 split vertically (issue #5) ===');
{
  // 500 x 400 rectangle = 200,000 cm² = 20 m²
  // Split with vertical wall at x=250
  // Expected: 2 rooms of 10 m² each (total 20 m²)
  wallCount = 0;
  const outer = rectWalls(0, 0, 500, 400);
  const split = wall(250, 0, 250, 400);
  const walls = [...outer, split] as any;

  const rooms = detectRooms(walls);
  const totalArea = rooms.reduce((s, r) => s + r.area, 0);

  console.log(`  Detected ${rooms.length} rooms, total area = ${totalArea.toFixed(2)} m²`);
  for (const r of rooms) console.log(`    - ${r.name}: ${r.area} m² (walls: ${r.walls.length})`);

  check('room count', rooms.length === 2, `expected 2, got ${rooms.length}`);
  check('total area', Math.abs(totalArea - 20) < 0.5, `expected ~20 m², got ${totalArea.toFixed(2)} m²`);
  check('not doubled', totalArea < 30, `total should not exceed original area`);
}

// ─────────────────────────────────────────────────────────────────
// Scenario B — issue #4: 2-bedroom template
// ─────────────────────────────────────────────────────────────────
console.log('\n=== Scenario B: 2-Bedroom House template (issue #4) ===');
{
  // Mirrors src/lib/utils/houseTemplates.ts createTwoBedroom() wall layout
  wallCount = 0;
  const outer = rectWalls(0, 0, 1000, 800);
  const hallLeft = wall(400, 0, 400, 500);
  const hallRight = wall(520, 0, 520, 500);
  const bed1Bottom = wall(0, 400, 400, 400);
  const bed2Bottom = wall(520, 400, 1000, 400);
  const bathLeft = wall(750, 500, 750, 800);
  const bathTop = wall(750, 500, 1000, 500);
  const livingTop = wall(0, 500, 750, 500);

  const walls = [...outer, hallLeft, hallRight, bed1Bottom, bed2Bottom, bathLeft, bathTop, livingTop] as any;

  const rooms = detectRooms(walls);
  const totalArea = rooms.reduce((s, r) => s + r.area, 0);

  console.log(`  Detected ${rooms.length} rooms, total area = ${totalArea.toFixed(2)} m²`);
  for (const r of rooms) console.log(`    - ${r.name}: ${r.area} m² (walls: ${r.walls.length})`);

  check('multiple rooms detected', rooms.length >= 5, `expected ≥5 rooms, got ${rooms.length}`);
  check('total area sums to outer envelope', Math.abs(totalArea - 80) < 0.5, `expected ~80 m², got ${totalArea.toFixed(2)} m²`);

  // Hallway-specific check for #4: 120cm wide × 500cm tall = 6 m²
  const hallway = rooms.find(r => Math.abs(r.area - 6) < 0.5);
  check('hallway detected (the actual #4 complaint)', !!hallway, hallway ? `${hallway.area} m²` : 'no room with ~6 m² area found');

  // No giant single "outer perimeter" room (the original #4/#5 bug symptom)
  const giantRoom = rooms.find(r => r.area > 50);
  check('no outer-perimeter room', !giantRoom, giantRoom ? `found suspicious ${giantRoom.area} m² room` : 'none');
}

console.log(allPassed ? '\n✓ All checks passed\n' : '\n✗ Some checks failed\n');
process.exit(allPassed ? 0 : 1);
