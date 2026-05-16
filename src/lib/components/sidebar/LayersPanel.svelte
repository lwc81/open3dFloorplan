<script lang="ts">
  import { activeFloor, selectedElementId, selectedRoomId, detectedRoomsStore, layerVisibility, reorderRooms } from '$lib/stores/project';
  import { getCatalogItem } from '$lib/utils/furnitureCatalog';
  import { projectSettings, formatArea } from '$lib/stores/settings';
  import type { Floor, Room } from '$lib/models/types';

  let floor: Floor | null = $state(null);
  activeFloor.subscribe(f => { floor = f; });

  let selId: string | null = $state(null);
  selectedElementId.subscribe(id => { selId = id; });

  let selRoomId: string | null = $state(null);
  selectedRoomId.subscribe(id => { selRoomId = id; });

  let detectedRooms: Room[] = $state([]);
  detectedRoomsStore.subscribe(r => { detectedRooms = r; });

  let settings = $state($projectSettings);
  projectSettings.subscribe(s => { settings = s; });

  let vis = $state({ walls: true, doors: true, windows: true, furniture: true, stairs: true, columns: true, guides: true, measurements: true, annotations: true, rooms: true });
  layerVisibility.subscribe(v => { vis = v; });

  // Collapsed state per category — persisted across panel toggles + sessions
  const COLLAPSE_STORAGE_KEY = 'layersPanel.collapsed';
  function loadCollapsed(): Record<string, boolean> {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  let collapsed: Record<string, boolean> = $state(loadCollapsed());

  function toggle(cat: string) {
    collapsed[cat] = !collapsed[cat];
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(collapsed));
    } catch {}
  }

  function toggleVisibility(cat: keyof typeof vis) {
    layerVisibility.update(v => ({ ...v, [cat]: !v[cat] }));
  }

  function select(id: string) {
    selectedElementId.set(id);
    selectedRoomId.set(null);
  }

  function selectRoom(id: string) {
    selectedElementId.set(null);
    selectedRoomId.set(id);
  }

  // Drag-to-reorder rooms
  let dragId: string | null = $state(null);
  let dropTargetId: string | null = $state(null);
  let dropPos: 'before' | 'after' = $state('before');

  function onRoomDragStart(e: DragEvent, id: string) {
    if (!e.dataTransfer) return;
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }

  function onRoomDragOver(e: DragEvent, id: string) {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dropPos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    dropTargetId = id;
  }

  function onRoomDrop(e: DragEvent, id: string) {
    if (!dragId || dragId === id) { resetDrag(); return; }
    e.preventDefault();
    const ids = mergedRooms.map(r => r.id).filter(rid => rid !== dragId);
    let insertAt = ids.indexOf(id);
    if (insertAt === -1) { resetDrag(); return; }
    if (dropPos === 'after') insertAt += 1;
    ids.splice(insertAt, 0, dragId);
    reorderRooms(ids);
    resetDrag();
  }

  function resetDrag() {
    dragId = null;
    dropTargetId = null;
  }

  interface Category {
    key: keyof typeof vis;
    label: string;
    icon: string;
    items: { id: string; label: string; icon: string }[];
  }

  let mergedRooms: { id: string; name: string; area: number; source: 'persisted' | 'detected' }[] = $derived.by(() => {
    const persisted = (floor?.rooms ?? []).map(r => ({ id: r.id, name: r.name, area: r.area, source: 'persisted' as const }));
    const persistedIds = new Set(persisted.map(r => r.id));
    const extra = detectedRooms
      .filter(r => !persistedIds.has(r.id))
      .map(r => ({ id: r.id, name: r.name, area: r.area, source: 'detected' as const }));
    return [...persisted, ...extra];
  });

  let categories: Category[] = $derived.by(() => {
    if (!floor) return [];
    const cats: Category[] = [];

    cats.push({
      key: 'walls', label: 'Walls', icon: '🧱',
      items: floor.walls.map((w, i) => ({ id: w.id, label: `Wall ${i + 1}`, icon: '─' })),
    });

    cats.push({
      key: 'doors', label: 'Doors', icon: '🚪',
      items: floor.doors.map((d, i) => ({ id: d.id, label: `${d.type} door ${i + 1}`, icon: '🚪' })),
    });

    cats.push({
      key: 'windows', label: 'Windows', icon: '🪟',
      items: floor.windows.map((w, i) => ({ id: w.id, label: `${w.type} window ${i + 1}`, icon: '🪟' })),
    });

    cats.push({
      key: 'furniture', label: 'Furniture', icon: '🪑',
      items: floor.furniture.map((fi) => {
        const cat = getCatalogItem(fi.catalogId);
        return { id: fi.id, label: cat?.name ?? fi.catalogId, icon: cat?.icon ?? '📦' };
      }),
    });

    if (floor.stairs?.length) {
      cats.push({
        key: 'stairs', label: 'Stairs', icon: '🪜',
        items: floor.stairs.map((s, i) => ({ id: s.id, label: `Stair ${i + 1} (${s.direction})`, icon: '🪜' })),
      });
    }

    if (floor.columns?.length) {
      cats.push({
        key: 'columns', label: 'Columns', icon: '🏛️',
        items: floor.columns.map((c, i) => ({ id: c.id, label: `${c.shape} column ${i + 1}`, icon: '🏛️' })),
      });
    }

    if (floor.guides?.length) {
      cats.push({
        key: 'guides', label: 'Guides', icon: '📏',
        items: floor.guides.map((g, i) => ({ id: g.id, label: `${g.orientation} guide ${i + 1}`, icon: g.orientation === 'horizontal' ? '─' : '│' })),
      });
    }

    if (floor.measurements?.length) {
      cats.push({
        key: 'measurements', label: 'Measurements', icon: '📐',
        items: floor.measurements.map((m, i) => {
          const dist = Math.round(Math.hypot(m.x2 - m.x1, m.y2 - m.y1));
          return { id: m.id, label: `Measurement ${i + 1} (${dist} cm)`, icon: '📐' };
        }),
      });
    }

    if (floor.annotations?.length) {
      cats.push({
        key: 'annotations', label: 'Annotations', icon: '📏',
        items: floor.annotations.map((a, i) => {
          const dist = Math.round(Math.hypot(a.x2 - a.x1, a.y2 - a.y1));
          const label = a.label || `${dist} cm`;
          return { id: a.id, label: `Annotation ${i + 1} (${label})`, icon: '📏' };
        }),
      });
    }

    return cats;
  });
</script>

<div class="w-56 bg-white border-l border-gray-200 flex flex-col overflow-hidden text-xs select-none">
  <div class="px-3 py-2 border-b border-gray-100 font-semibold text-gray-700 text-sm flex items-center gap-1.5">
    🗂 Layers
  </div>
  <div class="flex-1 overflow-y-auto">
    <!-- Rooms section -->
    <div class="border-b border-gray-50 relative">
      <button
        class="w-full flex items-center gap-1.5 pl-2 pr-9 py-1.5 hover:bg-gray-50 text-left"
        onclick={() => toggle('rooms')}
      >
        <span class="text-[10px] text-gray-400 w-3">{collapsed['rooms'] ? '▸' : '▾'}</span>
        <span>🏠</span>
        <span class="font-medium text-gray-700 flex-1">Rooms</span>
        <span class="text-gray-400">{mergedRooms.length}</span>
      </button>
      <span
        role="button"
        tabindex="0"
        class="inline-flex p-0.5 rounded hover:bg-gray-200 text-sm leading-none cursor-pointer absolute right-2 top-1.5"
        class:opacity-30={!vis.rooms}
        onclick={(e) => { e.stopPropagation(); toggleVisibility('rooms'); }}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVisibility('rooms'); } }}
        title={vis.rooms ? 'Hide Rooms' : 'Show Rooms'}
      >👁</span>
      {#if !collapsed['rooms']}
        {#each mergedRooms as room (room.id)}
          <div class="relative">
            {#if dropTargetId === room.id && dropPos === 'before'}
              <div class="absolute left-7 right-2 -top-px h-0.5 bg-blue-500 pointer-events-none z-10"></div>
            {/if}
            <button
              draggable="true"
              class="w-full flex items-center gap-1.5 pl-7 pr-2 py-1 hover:bg-blue-50 text-left transition-colors cursor-grab active:cursor-grabbing"
              class:bg-blue-100={selRoomId === room.id}
              class:text-blue-700={selRoomId === room.id}
              class:opacity-40={dragId === room.id || !vis.rooms}
              onclick={() => selectRoom(room.id)}
              ondragstart={(e) => onRoomDragStart(e, room.id)}
              ondragover={(e) => onRoomDragOver(e, room.id)}
              ondrop={(e) => onRoomDrop(e, room.id)}
              ondragend={resetDrag}
              title={room.source === 'detected' ? 'Auto-detected — drag to set order' : 'Drag to reorder'}
            >
              <span class="text-[10px]">⬜</span>
              <span class="truncate flex-1">{room.name || 'Unnamed'}</span>
              <span class="text-[10px] text-gray-400 shrink-0">{formatArea(room.area, settings.units)}</span>
              {#if room.source === 'detected'}
                <span class="text-[9px] px-1 rounded bg-amber-100 text-amber-700 shrink-0">auto</span>
              {/if}
            </button>
            {#if dropTargetId === room.id && dropPos === 'after'}
              <div class="absolute left-7 right-2 -bottom-px h-0.5 bg-blue-500 pointer-events-none z-10"></div>
            {/if}
          </div>
        {/each}
        {#if mergedRooms.length === 0}
          <div class="pl-7 pr-2 py-1 text-gray-300 italic">Empty</div>
        {/if}
      {/if}
    </div>

    {#each categories as cat}
      <div class="border-b border-gray-50 relative">
        <!-- Category header -->
        <button
          class="w-full flex items-center gap-1.5 pl-2 pr-9 py-1.5 hover:bg-gray-50 text-left"
          onclick={() => toggle(cat.key)}
        >
          <span class="text-[10px] text-gray-400 w-3">{collapsed[cat.key] ? '▸' : '▾'}</span>
          <span>{cat.icon}</span>
          <span class="font-medium text-gray-700 flex-1">{cat.label}</span>
          <span class="text-gray-400">{cat.items.length}</span>
        </button>
        <!-- Visibility toggle (outside button to avoid nesting) -->
        <span
          role="button"
          tabindex="0"
          class="inline-flex p-0.5 rounded hover:bg-gray-200 text-sm leading-none cursor-pointer absolute right-2 top-1.5"
          class:opacity-30={!vis[cat.key]}
          onclick={(e) => { e.stopPropagation(); toggleVisibility(cat.key); }}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVisibility(cat.key); } }}
          title={vis[cat.key] ? `Hide ${cat.label}` : `Show ${cat.label}`}
        >👁</span>
        <!-- Items -->
        {#if !collapsed[cat.key]}
          {#each cat.items as item}
            <button
              class="w-full flex items-center gap-1.5 pl-7 pr-2 py-1 hover:bg-blue-50 text-left transition-colors"
              class:bg-blue-100={selId === item.id}
              class:text-blue-700={selId === item.id}
              class:opacity-40={!vis[cat.key]}
              onclick={() => select(item.id)}
            >
              <span class="text-[10px]">{item.icon}</span>
              <span class="truncate flex-1">{item.label}</span>
            </button>
          {/each}
          {#if cat.items.length === 0}
            <div class="pl-7 pr-2 py-1 text-gray-300 italic">Empty</div>
          {/if}
        {/if}
      </div>
    {/each}
    {#if categories.length === 0}
      <div class="p-4 text-gray-400 text-center">No elements</div>
    {/if}
  </div>
</div>
