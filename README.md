# Collection Log / Drop Log (EvilLite plugin)

A **read-only** Collection Log for EvilQuest, in a bank-style UI, organised by **source** (the mob /
stall / chest / quest that gave the item). It only observes game state — no input automation.

## What counts as "collected"
- A drop from a **mob you killed**.
- A **stall / chest / quest reward**.
- *Not* random items picked up off the ground (not from your kill).

## How it works
- **Mob drops:** ground items have no owner field, so we track who you're fighting (`gm.combatTargetId`);
  when an NPC you were engaged with dies near you, the items that spawn at its tile within a short window
  are logged as your loot for that mob.
- **Items:** `EntityManager.itemDefsCache` → `{name, icon}`. Icons: 2D at `https://evilquest.net/items/<icon>`,
  falling back to the per-id 3D render `https://evilquest.net/items/3d/<id>.png` for items with no 2D icon.
- **Per-user:** stored in `plugin.data` (the core scopes it by logged-in username), so each account has its
  own log; switching accounts loads that account's data.
- **UI:** bank-style window — source tabs + a grid of item icons with count badges. Open via the **📒
  sidebar icon** or the **L** key.

Stall/chest/quest rewards add straight to inventory (no ground item); that path is wired through the same
`logCollected()` once the inventory hooks are finished.

## Build / load
```bash
yarn build   # -> dist/collection-log.js (esbuild, externalizes @evillite/core)
```
Until the Plugin Hub lands it's bundled as a temp core plugin in the client (like the World Map). Later
the Hub loads it from this repo.
