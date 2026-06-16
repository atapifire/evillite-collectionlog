// src/CollectionLogPlugin.ts
import { Plugin } from "@evillite/core/src/interfaces/highlite/plugin/plugin.class";
import { SettingsTypes } from "@evillite/core/src/interfaces/highlite/plugin/pluginSettings.interface";
var ICON_BASE = "https://evilquest.net/items/";
var DROP_MATCH_TILES = 2;
var DROP_WINDOW_MS = 6e3;
var ENGAGED_TTL_MS = 15e3;
var REWARD_WINDOW_MS = 5e3;
var REWARD_CATEGORIES = /* @__PURE__ */ new Set(["chest", "stall"]);
var _CollectionLogPlugin = class _CollectionLogPlugin extends Plugin {
  // most-recent worldObject we were skilling on
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
    this.registerSidebarIcon();
    this.installKeyHandler();
    this.startEngine();
    this.info("Collection Log started.");
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
          this.pending.push({ name: e.name, x: e.x, z: e.z, t: now });
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
        if (match) this.logCollected(gi.itemId | 0, gi.quantity | 0 || 1, match.name);
      }
      for (const id of this.seenGround) if (!seenNow.has(id)) this.seenGround.delete(id);
    }
    const soid = gm.skillingObjectId | 0;
    if (soid >= 0) {
      const info = this.worldObjectInfo(soid);
      if (info) this.lastSkillObj = { id: soid, name: info.name, category: info.category, t: now };
    }
    const inv = this.readInventory();
    if (!this.invReady) {
      this.invSnapshot = inv;
      this.invReady = true;
    } else {
      const so = this.lastSkillObj;
      const rewardSrc = so && now - so.t < REWARD_WINDOW_MS && REWARD_CATEGORIES.has(so.category) ? so.name : null;
      if (rewardSrc) {
        for (const [itemId, qty] of inv) {
          const gained = qty - (this.invSnapshot.get(itemId) || 0);
          if (gained > 0) this.logCollected(itemId, gained, rewardSrc);
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
  /** Resolve a worldObject instance id → its def name + category (chest/stall/rock/…). */
  worldObjectInfo(id) {
    const gm = this.gm;
    if (!gm) return null;
    const wo = gm.worldObjectDefs?.get(id);
    if (!wo) return null;
    const def = gm.objectDefsCache?.get(wo.defId);
    if (!def) return null;
    return { name: (def.name ?? `Object #${wo.defId}`) + "", category: (def.category ?? "") + "" };
  }
  /** Generic entry point — also used for stall/chest/quest rewards once inventory hooks land. */
  logCollected(itemId, qty, source) {
    if (!itemId || qty <= 0) return;
    this.ensureData();
    const src = source || "Unknown";
    if (!this.data.log[src]) this.data.log[src] = {};
    this.data.log[src][itemId] = (this.data.log[src][itemId] || 0) + qty;
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
  renderUI() {
    if (!this.ui) return;
    const log = this.data.log || {};
    const sources = Object.keys(log).sort();
    if (!this.selectedSource || !log[this.selectedSource]) this.selectedSource = sources[0] || "";
    const tabs = this.ui.querySelector("#cl-tabs");
    tabs.innerHTML = "";
    for (const src of sources) {
      const n = Object.keys(log[src]).length;
      const t = document.createElement("div");
      t.textContent = `${src} (${n})`;
      Object.assign(t.style, {
        padding: "5px 8px",
        cursor: "pointer",
        borderRadius: "3px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        background: src === this.selectedSource ? "#4a3d2c" : "transparent",
        color: src === this.selectedSource ? "#ffd24a" : "#d8cdb6"
      });
      t.onclick = () => {
        this.selectedSource = src;
        this.renderUI();
      };
      tabs.appendChild(t);
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
