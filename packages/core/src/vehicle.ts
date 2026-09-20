/**
 * The vehicle a paint job targets.
 *
 * A vehicle description supplies the three things the game needs and the
 * texture alone cannot:
 *
 * - the `def/vehicle/truck/<path>/` the definitions must land in;
 * - which cabin variants exist, and whether each needs its own mask (SCS
 *   trucks unwrap different cabins onto the same template; most mod trucks
 *   do not);
 * - which painted accessories exist, so a `simple_paint_job_data` override
 *   can point each one at its own mask.
 *
 * These can be written by hand for a truck already in the game, or drafted
 * from a `.blend` by the Blender inspector.
 */

import { z } from "zod";

import { ConfigError } from "./errors.js";
import { toAssetName, toDisplayName } from "./naming.js";

export const VEHICLE_TYPES = ["truck", "trailer_owned"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

const cabinSchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    units: z.union([z.string(), z.array(z.string())]).optional(),
    unit: z.union([z.string(), z.array(z.string())]).optional(),
  }),
]);

export const vehicleSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  game: z.string().default("ets2"),
  type: z.enum(VEHICLE_TYPES).default("truck"),
  author: z.string().default("SCS"),
  mod: z.boolean().default(false),
  alternate_uvset: z.boolean().default(false),
  separate_paintjobs: z.boolean().default(false),
  template_size: z.union([z.number(), z.tuple([z.number(), z.number()])]).default([4096, 4096]),
  paint_uv_layer: z.string().nullish(),
  cabins: z.record(cabinSchema).default({}),
  accessories: z.record(z.union([z.string(), z.array(z.string())])).default({}),
});

export type VehicleInput = z.input<typeof vehicleSchema>;

export interface Cabin {
  readonly key: string;
  readonly displayName: string;
  /**
   * Accessory unit names of the cabin(s) this entry covers. Several cabins can
   * share one mask -- they then all appear as `suitable_for[]` entries.
   */
  readonly units: readonly string[];
  /** File name of this cabin's mask inside the archive. */
  readonly textureName: string;
}

export interface AccessoryGroup {
  readonly label: string;
  readonly units: readonly string[];
  readonly textureName: string;
}

/** The plain data a Vehicle holds, separate from its derived path helpers. */
export interface VehicleFields {
  readonly path: string;
  readonly name: string;
  readonly game: string;
  readonly type: VehicleType;
  readonly author: string;
  readonly isMod: boolean;
  /**
   * True when the paint job UVs live on the third UV layer (the mirrored
   * layout). Must match how the model was exported, or the livery lands on
   * the wrong side of the cab.
   */
  readonly alternateUvset: boolean;
  /** True when each cabin has its own UV layout and therefore its own mask. */
  readonly separatePaintjobs: boolean;
  readonly cabins: readonly Cabin[];
  readonly accessories: readonly AccessoryGroup[];
  readonly templateSize: readonly [number, number];
  readonly paintUvLayer: string | null;
}

export class Vehicle implements VehicleFields {
  readonly path!: string;
  readonly name!: string;
  readonly game!: string;
  readonly type!: VehicleType;
  readonly author!: string;
  readonly isMod!: boolean;
  readonly alternateUvset!: boolean;
  readonly separatePaintjobs!: boolean;
  readonly cabins!: readonly Cabin[];
  readonly accessories!: readonly AccessoryGroup[];
  readonly templateSize!: readonly [number, number];
  readonly paintUvLayer!: string | null;

  private constructor(fields: VehicleFields) {
    Object.assign(this, fields);
  }

  static parse(input: unknown, source = "vehicle"): Vehicle {
    const parsed = vehicleSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new ConfigError(`${source}: ${issue.path.join(".") || "vehicle"} ${issue.message}`);
    }
    const data = parsed.data;

    const cabins: Cabin[] = Object.entries(data.cabins).map(([key, entry]) => {
      const record = typeof entry === "string" ? { name: entry } : entry;
      const rawUnits = record.units ?? record.unit;
      const units = typeof rawUnits === "string" ? [rawUnits] : (rawUnits ?? []);
      if (units.length === 0) {
        throw new ConfigError(
          `${source}: cabin '${key}' has no 'units' -- this is the cabin accessory unit name, ` +
            `e.g. 'highline' for highline.${data.path}.cabin`,
        );
      }
      const displayName = toDisplayName(record.name ?? `Cabin ${key}`);
      return { key, displayName, units, textureName: toAssetName(displayName) };
    });

    const accessories: AccessoryGroup[] = Object.entries(data.accessories)
      .map(([label, rawUnits]) => {
        const units = typeof rawUnits === "string" ? [rawUnits] : rawUnits;
        const displayLabel = toDisplayName(label);
        return { label: displayLabel, units, textureName: toAssetName(displayLabel) };
      })
      .filter((group) => group.units.length > 0);

    const size = typeof data.template_size === "number"
      ? ([data.template_size, data.template_size] as const)
      : ([data.template_size[0], data.template_size[1]] as const);

    const vehicle = new Vehicle({
      path: data.path,
      name: toDisplayName(data.name),
      game: data.game,
      type: data.type,
      author: toDisplayName(data.author),
      isMod: data.mod,
      alternateUvset: data.alternate_uvset,
      separatePaintjobs: data.separate_paintjobs,
      cabins,
      accessories,
      templateSize: size,
      paintUvLayer: data.paint_uv_layer ?? null,
    });

    if (vehicle.separatePaintjobs && vehicle.cabins.length === 0) {
      throw new ConfigError(
        `${source}: separate_paintjobs is set but no cabins are listed, ` +
          `so there is nothing to make separate masks for`,
      );
    }
    return vehicle;
  }

  /**
   * Folder name under `vehicle/<type>/upgrade/paintjob/<skin>/`.
   *
   * Mod trucks get the author appended, matching the convention the community
   * template packs for mod trucks already use.
   */
  get assetDir(): string {
    const base = toAssetName(this.name);
    return this.isMod ? `${base} [${toAssetName(this.author)}]` : base;
  }

  get defDir(): string {
    return `def/vehicle/${this.type}/${this.path}/paint_job`;
  }

  get usesAccessories(): boolean {
    return this.accessories.length > 0;
  }

  textureDir(skinAssetName: string): string {
    return `vehicle/${this.type}/upgrade/paintjob/${skinAssetName}/${this.assetDir}`;
  }

  /** Name of the single whole-vehicle mask when cabins share a layout. */
  mainTextureName(): string {
    if (this.type === "trailer_owned") return toAssetName(this.name);
    return this.usesAccessories ? "Cabin" : toAssetName(this.name);
  }

  toJSON(): VehicleInput {
    return {
      path: this.path,
      name: this.name,
      game: this.game,
      type: this.type,
      author: this.author,
      mod: this.isMod,
      alternate_uvset: this.alternateUvset,
      separate_paintjobs: this.separatePaintjobs,
      template_size: [this.templateSize[0], this.templateSize[1]],
      ...(this.paintUvLayer ? { paint_uv_layer: this.paintUvLayer } : {}),
      cabins: Object.fromEntries(
        this.cabins.map((cabin) => [cabin.key, { name: cabin.displayName, units: [...cabin.units] }]),
      ),
      accessories: Object.fromEntries(this.accessories.map((acc) => [acc.label, [...acc.units]])),
    };
  }
}
