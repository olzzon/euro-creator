/**
 * Vehicle definitions shipped with the service.
 *
 * Seeded once, into an empty workspace, so the first visit is not a blank page
 * with no way to try a build. The unit names are the game's own, read out of
 * `def/vehicle/truck/<path>/` in the unpacked `base.scs`.
 *
 * They are ordinary vehicles once seeded: editable and deletable, and never
 * re-added, so deleting one sticks.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { VehicleInput } from "@euro-creator/core";

import type { Workspace } from "./workspace.js";

const SEEDS_FILE = join(dirname(fileURLToPath(import.meta.url)), "seeds", "vehicles.json");

export async function seedVehicles(workspace: Workspace): Promise<number> {
  const marker = "seeded.json";
  if (await workspace.storage.has(marker)) return 0;

  let seeds: VehicleInput[];
  try {
    seeds = JSON.parse(await readFile(SEEDS_FILE, "utf8")) as VehicleInput[];
  } catch {
    return 0;
  }

  let added = 0;
  for (const seed of seeds) {
    try {
      await workspace.createVehicle(seed);
      added += 1;
    } catch {
      // A bad seed should never stop the service from starting.
    }
  }
  await workspace.storage.putJson(marker, { at: new Date().toISOString(), added });
  return added;
}
