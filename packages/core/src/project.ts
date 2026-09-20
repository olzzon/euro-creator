/**
 * A skin project: everything needed to build one mod, as plain data.
 *
 * Textures are referenced by an opaque string rather than a filesystem path,
 * because the same project shape has to work for the CLI (where a reference is
 * a path) and for the web service (where it is an upload id). Whoever calls
 * `buildMod` supplies the resolver.
 */

import { z } from "zod";

import { DDS_FORMATS } from "./dds/header.js";
import { ConfigError } from "./errors.js";
import { toAssetName, toDisplayName, toUnitName } from "./naming.js";
import { Vehicle, vehicleSchema } from "./vehicle.js";

export const projectSchema = z.object({
  mod: z.object({
    name: z.string().min(1, "is required"),
    author: z.string().min(1, "is required"),
    version: z.string().default("1.0"),
    description: z.string().default(""),
    icon: z.string().nullish(),
  }),
  skin: z.object({
    name: z.string().min(1, "is required"),
    price: z.number().int().min(0).default(10000),
    unlock: z.number().int().min(0).default(0),
    /**
     * The mask is multiplied onto the base colour by its alpha, so the
     * player's chosen colour still shows through where alpha is low. This is
     * what nearly every livery wants; turn it off for an opaque wrap.
     */
    airbrush: z.boolean().default(true),
    base_color: z.tuple([z.number(), z.number(), z.number()]).nullish(),
    icon: z.string().nullish(),
  }),
  vehicle: vehicleSchema,
  textures: z
    .object({
      main: z.string().nullish(),
      cabins: z.record(z.string()).default({}),
      accessories: z.record(z.string()).default({}),
    })
    .default({ cabins: {}, accessories: {} }),
  output: z
    .object({
      dds_format: z.enum(DDS_FORMATS).default("dxt5"),
      mipmaps: z.boolean().default(true),
      compress: z.boolean().default(false),
    })
    .default({ dds_format: "dxt5", mipmaps: true, compress: false }),
});

export type ProjectInput = z.input<typeof projectSchema>;

export interface ModInfo {
  readonly name: string;
  readonly author: string;
  readonly version: string;
  readonly description: string;
  readonly icon: string | null;
  /** Unit-safe name used for the archive file and the mod's internal ids. */
  readonly unitName: string;
}

export interface SkinInfo {
  readonly name: string;
  readonly price: number;
  readonly unlock: number;
  readonly airbrush: boolean;
  readonly baseColor: readonly [number, number, number] | null;
  readonly icon: string | null;
  readonly unitName: string;
  /** Name used for the archive folder and the icon file. */
  readonly assetName: string;
}

export interface OutputOptions {
  readonly ddsFormat: (typeof DDS_FORMATS)[number];
  readonly mipmaps: boolean;
  readonly compress: boolean;
}

export interface Project {
  readonly mod: ModInfo;
  readonly skin: SkinInfo;
  readonly vehicle: Vehicle;
  readonly mainTexture: string | null;
  readonly cabinTextures: Readonly<Record<string, string>>;
  readonly accessoryTextures: Readonly<Record<string, string>>;
  readonly output: OutputOptions;
}

export function parseProject(input: unknown, source = "project"): Project {
  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ConfigError(`${source}: ${issue.path.join(".") || "project"} ${issue.message}`);
  }
  const data = parsed.data;

  const modName = toDisplayName(data.mod.name);
  const modAuthor = toDisplayName(data.mod.author);
  const skinName = toDisplayName(data.skin.name);

  const project: Project = {
    mod: {
      name: modName,
      author: modAuthor,
      version: data.mod.version,
      description: data.mod.description.trim(),
      icon: data.mod.icon ?? null,
      unitName: toUnitName(`${modAuthor}_${modName}`),
    },
    skin: {
      name: skinName,
      price: data.skin.price,
      unlock: data.skin.unlock,
      airbrush: data.skin.airbrush,
      baseColor: data.skin.base_color ?? null,
      icon: data.skin.icon ?? null,
      unitName: toUnitName(skinName),
      assetName: toAssetName(skinName),
    },
    vehicle: Vehicle.parse(data.vehicle, source),
    mainTexture: data.textures.main ?? null,
    cabinTextures: data.textures.cabins,
    accessoryTextures: data.textures.accessories,
    output: {
      ddsFormat: data.output.dds_format,
      mipmaps: data.output.mipmaps,
      compress: data.output.compress,
    },
  };

  validateProject(project, source);
  return project;
}

/** Catch the mistakes that otherwise surface as a silent no-op in game. */
export function validateProject(project: Project, source = "project"): void {
  const { vehicle } = project;

  if (vehicle.separatePaintjobs) {
    const known = new Set(vehicle.cabins.map((cabin) => cabin.key));
    const unknown = Object.keys(project.cabinTextures).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      throw new ConfigError(
        `${source}: textures.cabins refers to cabin(s) ${JSON.stringify(unknown)} that this ` +
          `vehicle does not have. Known cabins: ${JSON.stringify([...known])}`,
      );
    }
    const missing = vehicle.cabins
      .filter((cabin) => project.cabinTextures[cabin.key] === undefined)
      .map((cabin) => cabin.key);
    if (missing.length > 0 && project.mainTexture === null) {
      throw new ConfigError(
        `${source}: this vehicle unwraps each cabin separately, so cabin(s) ` +
          `${JSON.stringify(missing)} need their own entry under textures.cabins -- ` +
          `or set textures.main as a fallback for the ones you have not painted.`,
      );
    }
  } else if (project.mainTexture === null) {
    throw new ConfigError(
      `${source}: textures.main is required -- it is the mask painted on the UV template.`,
    );
  }

  const knownAccessories = new Set(vehicle.accessories.map((group) => group.label));
  const unknown = Object.keys(project.accessoryTextures).filter((label) => !knownAccessories.has(label));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${source}: textures.accessories refers to ${JSON.stringify(unknown)}, which this vehicle ` +
        `does not define. Known groups: ${
          knownAccessories.size > 0 ? JSON.stringify([...knownAccessories]) : "none"
        }`,
    );
  }
}
