// src/CollectionLogPlugin.ts
import { Plugin } from "@evillite/core/src/interfaces/highlite/plugin/plugin.class";
import { SettingsTypes } from "@evillite/core/src/interfaces/highlite/plugin/pluginSettings.interface";
import { ModelIconCache } from "@evillite/core/src/utilities/modelIconCache";
var ICON_BASE = "https://evilquest.net/items/";
var DROP_MATCH_TILES = 2;
var DROP_WINDOW_MS = 6e3;
var ENGAGED_TTL_MS = 15e3;
var REWARD_WINDOW_MS = 5e3;
var REWARD_CATEGORIES = /* @__PURE__ */ new Set(["chest", "stall"]);
var GROUPS = [
  { key: "npc", label: "NPCs", emoji: "\u2694\uFE0F", types: ["npc", "other"] },
  { key: "object", label: "Stalls & Chests", emoji: "\u{1F4E6}", types: ["chest", "stall"] },
  { key: "quest", label: "Quest Rewards", emoji: "\u{1F4DC}", types: ["quest"] }
];
function groupKeyForType(t) {
  return GROUPS.find((g) => g.types.includes(t))?.key ?? "npc";
}
var _CollectionLogPlugin = class _CollectionLogPlugin extends Plugin {
  constructor() {
    super();
    this.pluginName = "Collection Log";
    this.author = "atapifire";
    this.menuIcon = null;
    this.ui = null;
    this.engineId = null;
    this.engaged = /* @__PURE__ */ new Map();
    // npc id -> last-seen while I targeted it
    this.liveNpcIds = /* @__PURE__ */ new Set();
    this.pending = [];
    this.seenGround = /* @__PURE__ */ new Set();
    // ground-item instance ids already processed
    this.selectedSource = "";
    // chest/stall reward detection (rewards land straight in the inventory, no ground item)
    this.invSnapshot = /* @__PURE__ */ new Map();
    // itemId -> total qty currently in inventory
    this.invReady = false;
    // first snapshot taken (don't log the starting inventory)
    this.lastSkillObj = null;
    // most-recent worldObject we were skilling on
    // Shared, core-managed model icons (rendered by the World Map plugin, read-only here).
    this.modelIcons = {};
    this.iconStore = new ModelIconCache();
    /** Press L to toggle the log (ignored while typing in chat / an input). */
    this.keyHandlerInstalled = false;
    this.settings.deathRangeTiles = { text: "Max kill distance (tiles)", type: SettingsTypes.range, value: 6, min: 2, max: 14, callback: () => {
    } };
  }
  init() {
    this.settings.enable.value = true;
    this.ensureData();
  }
  start() {
    this.ensureData();
    this.loadModelIcons();
    this.registerSidebarIcon();
    this.installKeyHandler();
    this.startEngine();
    this.info("Collection Log started.");
  }
  /** Pull the shared model-icon cache (NPC/object renders) once at startup. */
  loadModelIcons() {
    this.iconStore.load().then((m) => {
      this.modelIcons = m || {};
      if (this.ui) this.renderUI();
    }).catch(() => {
    });
  }
  stop() {
    this.stopEngine();
    if (this.ui) {
      this.ui.remove();
      this.ui = null;
    }
    if (this.menuIcon) {
      this.menuIcon.remove();
      this.menuIcon = null;
    }
  }
  installKeyHandler() {
    if (this.keyHandlerInstalled) return;
    this.keyHandlerInstalled = true;
    window.addEventListener("keydown", (e) => {
      if (!e.key || e.key.toLowerCase() !== "l" || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      this.toggleUI();
    });
  }
  get gm() {
    return this.gameHooks?.GameManager?.Instance ?? window.gm ?? null;
  }
  get em() {
    return this.gameHooks?.EntityManager?.Instance ?? null;
  }
  ensureData() {
    if (!this.data.log || typeof this.data.log !== "object") this.data.log = {};
    if (!this.data.meta || typeof this.data.meta !== "object") this.data.meta = {};
    if (!this.data.collapsed || typeof this.data.collapsed !== "object") this.data.collapsed = {};
  }
  // ── detection engine ──────────────────────────────────────────────────────
  startEngine() {
    this.stopEngine();
    this.engineId = setInterval(() => this.tick(), 120);
  }
  stopEngine() {
    if (this.engineId) {
      clearInterval(this.engineId);
      this.engineId = null;
    }
  }
  tick() {
    const gm = this.gm, em = this.em;
    if (!gm || !em) return;
    const now = Date.now();
    const p = this.playerPos();
    const live = /* @__PURE__ */ new Set();
    const npcDefs = em.npcDefs;
    const sprites = em.npcSprites;
    if (npcDefs) for (const [id] of npcDefs) live.add(id);
    const target = gm.combatTargetId | 0;
    if (target > 0 && live.has(target)) {
      const pos = this.npcPos(target, sprites);
      const name = this.npcName(target, em);
      this.engaged.set(target, { name, x: pos?.x ?? p?.x ?? 0, z: pos?.z ?? p?.z ?? 0, defId: npcDefs?.get(target) ?? -1, t: now });
    }
    for (const [id, e] of this.engaged) {
      if (live.has(id)) {
        const pos = this.npcPos(id, sprites);
        if (pos) {
          e.x = pos.x;
          e.z = pos.z;
        }
        e.t = Math.max(e.t, this.engaged.get(id).t);
      }
    }
    const maxKill = this.settings.deathRangeTiles?.value || 6;
    for (const id of this.liveNpcIds) {
      if (!live.has(id)) {
        const e = this.engaged.get(id);
        if (e && now - e.t < ENGAGED_TTL_MS && p && dist(e.x, e.z, p.x, p.z) <= maxKill) {
          this.pending.push({ name: e.name, x: e.x, z: e.z, defId: e.defId, t: now });
        }
        this.engaged.delete(id);
      }
    }
    this.liveNpcIds = live;
    this.pending = this.pending.filter((d) => now - d.t < DROP_WINDOW_MS);
    const ground = em.groundItems;
    if (ground) {
      const seenNow = /* @__PURE__ */ new Set();
      for (const [, gi] of ground) {
        const gid = gi.id | 0;
        seenNow.add(gid);
        if (this.seenGround.has(gid)) continue;
        this.seenGround.add(gid);
        const match = this.pending.find((d) => dist(d.x, d.z, gi.x, gi.z) <= DROP_MATCH_TILES && now - d.t < DROP_WINDOW_MS);
        if (match) this.logCollected(gi.itemId | 0, gi.quantity | 0 || 1, match.name, { type: "npc", defId: match.defId });
      }
      for (const id of this.seenGround) if (!seenNow.has(id)) this.seenGround.delete(id);
    }
    const soid = gm.skillingObjectId | 0;
    if (soid >= 0) {
      const info = this.worldObjectInfo(soid);
      if (info) this.lastSkillObj = { id: soid, name: info.name, category: info.category, defId: info.defId, assetId: info.assetId, t: now };
    }
    const inv = this.readInventory();
    if (!this.invReady) {
      this.invSnapshot = inv;
      this.invReady = true;
    } else {
      const so = this.lastSkillObj;
      const isReward = so && now - so.t < REWARD_WINDOW_MS && REWARD_CATEGORIES.has(so.category);
      if (isReward && so) {
        for (const [itemId, qty] of inv) {
          const gained = qty - (this.invSnapshot.get(itemId) || 0);
          if (gained > 0) this.logCollected(itemId, gained, so.name, { type: so.category, defId: so.defId, assetId: so.assetId });
        }
      }
      this.invSnapshot = inv;
    }
  }
  /** Sum the player's inventory by item id, read from the live inventory DOM. */
  readInventory() {
    const m = /* @__PURE__ */ new Map();
    document.querySelectorAll(".item-icon[data-item-id]").forEach((el) => {
      const id = parseInt(el.dataset.itemId || "", 10);
      if (!id) return;
      const q = parseInt(el.dataset.itemQuantity || "1", 10) || 1;
      m.set(id, (m.get(id) || 0) + q);
    });
    return m;
  }
  /** Resolve a worldObject instance id → def name + category + defId + model assetId.
   *  assetId (e.g. "tier 1 chest") is the shared icon key; it lives on the loaded model. */
  worldObjectInfo(id) {
    const gm = this.gm;
    if (!gm) return null;
    const wo = gm.worldObjectDefs?.get(id);
    if (!wo) return null;
    const def = gm.objectDefsCache?.get(wo.defId);
    if (!def) return null;
    const model = gm.worldObjectModels?.get(id);
    const assetId = (wo.metadata?.assetId ?? model?.metadata?.assetId ?? wo.assetId ?? "") + "";
    return { name: (def.name ?? `Object #${wo.defId}`) + "", category: (def.category ?? "") + "", defId: wo.defId | 0, assetId };
  }
  /** Generic entry point for every source (mob kill / chest / stall / quest). */
  logCollected(itemId, qty, source, meta) {
    if (!itemId || qty <= 0) return;
    this.ensureData();
    const src = source || "Unknown";
    if (!this.data.log[src]) this.data.log[src] = {};
    this.data.log[src][itemId] = (this.data.log[src][itemId] || 0) + qty;
    if (meta) {
      const cur = this.data.meta[src] || {};
      this.data.meta[src] = { type: meta.type || cur.type || "other", defId: meta.defId ?? cur.defId, assetId: meta.assetId || cur.assetId };
    }
    this.info(`+${qty} ${this.itemName(itemId)} from ${src}`);
    if (this.ui) this.renderUI();
  }
  // ── game-state helpers ────────────────────────────────────────────────────
  playerPos() {
    const gm = this.gm;
    return gm ? { x: gm.playerX, z: gm.playerZ } : null;
  }
  npcPos(id, sprites) {
    const s = sprites?.get(id);
    const pos = s?.position;
    return pos ? { x: pos.x, z: pos.z } : null;
  }
  npcName(id, em) {
    const defId = em.npcDefs?.get(id);
    const def = em.npcDefsCache?.get(defId);
    return (def?.name ?? `NPC #${defId}`) + "";
  }
  itemDef(itemId) {
    return this.em?.itemDefsCache?.get(itemId) ?? null;
  }
  itemName(itemId) {
    return (this.itemDef(itemId)?.name ?? `Item #${itemId}`) + "";
  }
  /** 2D icon if the item ships one, else the pre-rendered 3D icon (every item has one). */
  itemIcon(itemId) {
    const ic = this.itemDef(itemId)?.icon;
    return ic ? ICON_BASE + ic : this.itemIcon3d(itemId);
  }
  itemIcon3d(itemId) {
    return `${ICON_BASE}3d/${itemId}.png`;
  }
  // ── source identity / icons ───────────────────────────────────────────────
  /** Stored meta for a source, backfilling type/defId by name for pre-existing log entries. */
  sourceMeta(src) {
    const stored = this.data.meta?.[src];
    if (stored && stored.type) return stored;
    const inferred = this.inferMeta(src);
    if (inferred && this.data.meta) this.data.meta[src] = inferred;
    return inferred ?? { type: "other" };
  }
  /** Best-effort: resolve an old source name to its type/defId via the live def caches. */
  inferMeta(name) {
    const em = this.em, gm = this.gm;
    const ndc = em?.npcDefsCache;
    if (ndc) {
      for (const [defId, def] of ndc) if ((def?.name ?? "") + "" === name) return { type: "npc", defId: defId | 0 };
    }
    const odc = gm?.objectDefsCache;
    if (odc) {
      for (const [defId, def] of odc) if ((def?.name ?? "") + "" === name) {
        const cat = (def?.category ?? "") + "";
        if (cat === "chest" || cat === "stall") return { type: cat, defId: defId | 0 };
      }
    }
    return null;
  }
  /** The shared model-icon dataURL for a source, or null if not cached yet. */
  sourceIcon(src) {
    const m = this.sourceMeta(src);
    if (m.type === "npc" && m.defId != null) return ModelIconCache.resolveNpc(this.modelIcons, m.defId);
    if (m.type === "chest" || m.type === "stall") return ModelIconCache.resolveObject(this.modelIcons, m.assetId, m.defId);
    return null;
  }
  // ── UI (bank-style) ───────────────────────────────────────────────────────
  registerSidebarIcon(attempt = 0) {
    if (this.menuIcon) return;
    const pm = document.highlite?.managers?.PanelManager;
    if (!pm?.requestMenuItem) {
      if (attempt < 20) setTimeout(() => this.registerSidebarIcon(attempt + 1), 400);
      return;
    }
    try {
      const [iconEl] = pm.requestMenuItem(_CollectionLogPlugin.ICON, "Collection Log");
      this.menuIcon = iconEl;
      this.menuIcon.title = "Collection Log";
      this.menuIcon.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleUI();
      };
    } catch {
    }
  }
  toggleUI() {
    if (this.ui) {
      this.ui.remove();
      this.ui = null;
    } else {
      this.buildUI();
    }
  }
  buildUI() {
    const el = document.createElement("div");
    el.id = "eq-clog";
    Object.assign(el.style, {
      position: "fixed",
      top: "60px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483600",
      width: "520px",
      height: "640px",
      display: "flex",
      flexDirection: "column",
      background: "#3a3026",
      border: "2px solid #1a1612",
      borderTopColor: "#6b5b45",
      borderLeftColor: "#6b5b45",
      borderRadius: "4px",
      color: "#e8dfce",
      font: "13px Inter,system-ui,sans-serif",
      boxShadow: "0 8px 30px rgba(0,0,0,.6)"
    });
    el.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 12px;background:#2c241b;border-bottom:1px solid #1a1612">
            <b style="color:#ffd24a">\u{1F4D2} Collection Log</b>
            <button id="cl-close" style="background:transparent;border:none;color:#ccc;font-size:16px;cursor:pointer">\u2715</button>
          </div>
          <div style="display:flex;flex:1;min-height:0">
            <div id="cl-tabs" style="width:150px;flex:none;overflow:auto;background:#2c241b;border-right:1px solid #1a1612;padding:4px"></div>
            <div id="cl-grid" style="flex:1;overflow:auto;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,48px);grid-auto-rows:48px;gap:8px;align-content:start"></div>
          </div>
          <div id="cl-foot" style="padding:5px 12px;background:#2c241b;border-top:1px solid #1a1612;font-size:11px;color:#b3a890"></div>`;
    document.body.appendChild(el);
    this.ui = el;
    el.querySelector("#cl-close").onclick = () => this.toggleUI();
    this.renderUI();
  }
  /** A small left-aligned source icon: the model render if cached, else a category glyph. */
  sourceIconHtml(src, size) {
    const url = this.sourceIcon(src);
    if (url) return `<img src="${url}" style="width:${size}px;height:${size}px;object-fit:contain;flex:none">`;
    const glyph = { npc: "\u2694\uFE0F", chest: "\u{1F4E6}", stall: "\u{1F4E6}", quest: "\u{1F4DC}", other: "\u2022" }[this.sourceMeta(src).type] ?? "\u2022";
    return `<span style="width:${size}px;height:${size}px;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:${Math.floor(size * 0.7)}px">${glyph}</span>`;
  }
  renderUI() {
    if (!this.ui) return;
    const log = this.data.log || {};
    const sources = Object.keys(log);
    if (!this.selectedSource || !log[this.selectedSource]) this.selectedSource = sources.sort()[0] || "";
    const byGroup = /* @__PURE__ */ new Map();
    for (const g of GROUPS) byGroup.set(g.key, []);
    for (const src of sources) byGroup.get(groupKeyForType(this.sourceMeta(src).type)).push(src);
    for (const arr of byGroup.values()) arr.sort();
    const tabs = this.ui.querySelector("#cl-tabs");
    tabs.innerHTML = "";
    for (const g of GROUPS) {
      const members = byGroup.get(g.key);
      if (!members.length) continue;
      const collapsed = !!this.data.collapsed[g.key];
      const header = document.createElement("div");
      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 6px",
        cursor: "pointer",
        color: "#ffd24a",
        fontWeight: "600",
        fontSize: "12px",
        borderRadius: "3px",
        userSelect: "none"
      });
      header.innerHTML = `<span style="width:10px;flex:none">${collapsed ? "\u25B8" : "\u25BE"}</span><span>${g.emoji} ${g.label}</span><span style="margin-left:auto;color:#8a8070;font-size:11px">${members.length}</span>`;
      header.onclick = () => {
        this.data.collapsed[g.key] = !collapsed;
        this.renderUI();
      };
      tabs.appendChild(header);
      if (collapsed) continue;
      for (const src of members) {
        const n = Object.keys(log[src]).length;
        const row = document.createElement("div");
        Object.assign(row.style, {
          display: "flex",
          alignItems: "center",
          gap: "7px",
          padding: "4px 6px 4px 14px",
          cursor: "pointer",
          borderRadius: "3px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          background: src === this.selectedSource ? "#4a3d2c" : "transparent",
          color: src === this.selectedSource ? "#ffd24a" : "#d8cdb6"
        });
        row.innerHTML = `${this.sourceIconHtml(src, 22)}<span style="overflow:hidden;text-overflow:ellipsis">${src}</span><span style="margin-left:auto;color:#8a8070;font-size:11px">${n}</span>`;
        row.onclick = () => {
          this.selectedSource = src;
          this.renderUI();
        };
        tabs.appendChild(row);
      }
    }
    if (!sources.length) tabs.innerHTML = '<div style="padding:8px;color:#8a8070;font-size:11px">No drops yet \u2014 go kill something.</div>';
    const grid = this.ui.querySelector("#cl-grid");
    grid.innerHTML = "";
    const items = log[this.selectedSource] || {};
    let total = 0;
    for (const idStr of Object.keys(items).sort((a, b) => items[b] - items[a])) {
      const itemId = Number(idStr), count = items[idStr];
      total += count;
      const slot = document.createElement("div");
      slot.title = `${this.itemName(itemId)} \xD7${count}`;
      Object.assign(slot.style, { position: "relative", width: "48px", height: "48px", background: "#2a2219", border: "1px solid #1a1612", borderRadius: "3px" });
      const url = this.itemIcon(itemId), fb = this.itemIcon3d(itemId);
      slot.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:contain" onerror="if(this.dataset.fb){this.style.display='none'}else{this.dataset.fb=1;this.src='${fb}'}"><span style="position:absolute;right:1px;bottom:0;font-size:11px;color:#fff;text-shadow:0 0 3px #000,1px 1px 2px #000">${count > 999 ? Math.floor(count / 1e3) + "k" : count}</span>`;
      grid.appendChild(slot);
    }
    this.ui.querySelector("#cl-foot").textContent = sources.length ? `${this.selectedSource}: ${Object.keys(items).length} unique \xB7 ${total} total` : "Tracks kills, stalls, chests & quest rewards.";
  }
};
_CollectionLogPlugin.ICON = "\u{1F4D2}";
var CollectionLogPlugin = _CollectionLogPlugin;
function dist(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}
export {
  CollectionLogPlugin as default
};
