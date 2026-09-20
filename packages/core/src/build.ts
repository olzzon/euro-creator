/**
 * Assembling the mod and packing it into a `.scs`.
 *
 * The layout produced here mirrors what the game expects, and what SCS' own
 * archives look like:
 *
 * ```
 * manifest.sii                                  mod manager entry
 * versions.sii
 * Mod_Manager_Image.jpg
 * Mod_Manager_Description.txt
 * material/ui/accessory/<Skin> Icon.dds|.tobj   shop icon
 * material/ui/accessory/<skin>_icon.mat
 * def/vehicle/truck/<path>/paint_job/
 *     <skin>_settings.sui                       shared attributes
 *     <skin>.sii                                accessory_paint_job_data
 *     accessory/<skin>.sii                      simple_paint_job_data overrides
 * vehicle/truck/upgrade/paintjob/<Skin>/<Truck>/
 *     Cabin.dds|.tobj, <Accessory>.dds|.tobj    the masks themselves
 * ```
 *
 * The `def` side and the `vehicle` side are joined only by string paths, so
 * every path is built once, here, and reused for both the SII text and the
 * file it points at. That is the single thing that makes hand-built skins
 * fail.
 *
 * Nothing touches the filesystem: the result is a list of in-memory files, so
 * the same code serves the CLI (which writes them) and the HTTP API (which
 * streams them).
 */

import type { ModFile } from "./archive.js";
import { encodeJpeg, encodePng, letterbox, resample } from "./codecs.js";
import { encodeDds } from "./dds/index.js";
import { TextureError } from "./errors.js";
import { createImage, type RgbaImage } from "./image.js";
import type { Project } from "./project.js";
import { renderSui, SiiFile, SiiUnit, type SiiValue } from "./sii.js";
import { buildTobj } from "./tobj.js";
import type { Vehicle } from "./vehicle.js";

/** The in-game mod manager thumbnail. */
const MOD_IMAGE_SIZE = [276, 162] as const;

/** The dealer UI draws paint job icons at 4:1. */
export const ICON_SIZE = [256, 64] as const;

/**
 * Masks for accessories the skin does not cover: fully transparent, so with
 * airbrush on the accessory keeps the player's base colour. 16x16 keeps the
 * archive small -- the game stretches the mask across the UVs regardless.
 */
const PLACEHOLDER_SIZE = 16;

/** Resolves a project's opaque texture reference to bytes. */
export type TextureResolver = (ref: string) => Promise<{ data: Buffer; filename?: string }>;

/** Decodes bytes to RGBA. Injected so core stays independent of the codec choice. */
export type ImageDecoder = (data: Buffer, filename?: string) => Promise<RgbaImage>;

export interface BuildOptions {
  resolveTexture: TextureResolver;
  decodeImage: ImageDecoder;
  /** Resample a mask that does not match the template size instead of failing. */
  resizeMismatched?: boolean;
  onProgress?: (message: string) => void;
}

export interface MaskReport {
  readonly name: string;
  readonly tobjPath: string;
  readonly bytes: number;
  readonly source: "painted" | "placeholder";
}

export interface BuildResult {
  readonly files: readonly ModFile[];
  readonly masks: readonly MaskReport[];
  readonly warnings: readonly string[];
  readonly totalBytes: number;
  readonly archiveName: string;
}

export async function buildMod(project: Project, options: BuildOptions): Promise<BuildResult> {
  const { vehicle, skin } = project;
  const progress = options.onProgress ?? (() => {});
  const files: ModFile[] = [];
  const masks: MaskReport[] = [];
  const warnings: string[] = [];

  const add = (path: string, data: Buffer): void => {
    files.push({ path, data });
  };

  /** Write `<name>.dds` + `<name>.tobj` and return the TOBJ's archive path. */
  const writeMask = async (name: string, image: RgbaImage, source: MaskReport["source"]): Promise<string> => {
    const dir = vehicle.textureDir(skin.assetName);
    const ddsPath = `/${dir}/${name}.dds`;
    const tobjPath = `/${dir}/${name}.tobj`;
    const dds = encodeDds(image, { format: project.output.ddsFormat, mipmaps: project.output.mipmaps });
    add(`${dir}/${name}.dds`, dds);
    add(`${dir}/${name}.tobj`, buildTobj(ddsPath));
    masks.push({ name, tobjPath, bytes: dds.length, source });
    return tobjPath;
  };

  const loadMask = async (ref: string, label: string): Promise<RgbaImage> => {
    const { data, filename } = await options.resolveTexture(ref);
    const image = await options.decodeImage(data, filename);
    const [width, height] = vehicle.templateSize;
    if (image.width === width && image.height === height) return image;
    if (!options.resizeMismatched) {
      throw new TextureError(
        `${label}: ${filename ?? ref} is ${image.width}x${image.height}, but this vehicle's ` +
          `template is ${width}x${height}. Paint on the exported template so the UV layout lines up.`,
      );
    }
    warnings.push(`${label}: resampled ${filename ?? ref} to ${width}x${height}`);
    return resample(image, width, height);
  };

  // ------------------------------------------------------------ loose files
  progress("writing mod metadata");
  add("manifest.sii", Buffer.from(renderManifest(project), "utf8"));
  add("versions.sii", Buffer.from(renderVersions(), "utf8"));
  add("Mod_Manager_Description.txt", Buffer.from(renderDescription(project), "utf8"));
  add("Mod_Manager_Image.jpg", await renderModImage(project, options));

  // ------------------------------------------------------------- shop icon
  progress("writing shop icon");
  for (const file of await renderShopIcon(project, options)) add(file.path, file.data);

  // -------------------------------------------------------- shared settings
  const settingsName = `${skin.unitName}_settings.sui`;
  const settings: Array<readonly [string, SiiValue]> = [
    ["name", skin.name],
    ["price", skin.price],
    ["unlock", skin.unlock],
    ["airbrush", skin.airbrush],
    ["icon", `${skin.unitName}_icon`],
  ];
  if (skin.baseColor) settings.push(["base_color", skin.baseColor]);
  if (vehicle.alternateUvset) {
    // Tells the game to sample the mask through the vehicle's mirrored UV
    // layer. Must match how the model was exported (truckpaint.altuv).
    settings.push(["alternate_uvset", true]);
  }
  add(`${vehicle.defDir}/${settingsName}`, Buffer.from(renderSui(settings), "utf8"));

  // ------------------------------------------------------ masks + def files
  const accessoryMasks: Array<{ tobjPath: string; units: readonly string[] }> = [];
  if (vehicle.usesAccessories) {
    progress(`building ${vehicle.accessories.length} accessory mask(s)`);
    for (const group of vehicle.accessories) {
      const ref = project.accessoryTextures[group.label];
      let image: RgbaImage;
      let source: MaskReport["source"];
      if (ref === undefined) {
        image = createImage(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE, [0, 0, 0, 0]);
        source = "placeholder";
      } else {
        const resolved = await options.resolveTexture(ref);
        image = await options.decodeImage(resolved.data, resolved.filename);
        source = "painted";
      }
      accessoryMasks.push({ tobjPath: await writeMask(group.textureName, image, source), units: group.units });
    }
  }

  if (vehicle.separatePaintjobs) {
    progress(`building ${vehicle.cabins.length} per-cabin paint job(s)`);
    for (const cabin of vehicle.cabins) {
      const ref = project.cabinTextures[cabin.key] ?? project.mainTexture;
      if (ref === null || ref === undefined) {
        throw new TextureError(`cabin ${cabin.key} has no mask and there is no textures.main fallback`);
      }
      const image = await loadMask(ref, `cabin ${cabin.key}`);
      const maskPath = await writeMask(withAltUvSuffix(cabin.textureName, vehicle), image, "painted");

      const paintjobUnit = `${skin.unitName}_${cabin.key}`;
      add(
        `${vehicle.defDir}/${paintjobUnit}.sii`,
        Buffer.from(renderPaintjob(vehicle, paintjobUnit, settingsName, maskPath, cabin.units), "utf8"),
      );
      if (accessoryMasks.length > 0) {
        add(
          `${vehicle.defDir}/accessory/${paintjobUnit}.sii`,
          Buffer.from(renderAccessoryOverrides(accessoryMasks), "utf8"),
        );
      }
    }
  } else {
    progress("building single whole-vehicle paint job");
    const image = await loadMask(project.mainTexture!, "main");
    const maskPath = await writeMask(withAltUvSuffix(vehicle.mainTextureName(), vehicle), image, "painted");
    // No suitable_for[]: one mask covers every cabin, and an omitted list
    // means "all of them". Enumerating cabins here would only create a way to
    // miss one and have the paint job quietly vanish from that cab.
    add(
      `${vehicle.defDir}/${skin.unitName}.sii`,
      Buffer.from(renderPaintjob(vehicle, skin.unitName, settingsName, maskPath, []), "utf8"),
    );
    if (accessoryMasks.length > 0) {
      add(
        `${vehicle.defDir}/accessory/${skin.unitName}.sii`,
        Buffer.from(renderAccessoryOverrides(accessoryMasks), "utf8"),
      );
    }
  }

  return {
    files,
    masks,
    warnings,
    totalBytes: files.reduce((sum, file) => sum + file.data.length, 0),
    archiveName: `${project.mod.unitName}.scs`,
  };
}

// --------------------------------------------------------------------------
// pieces
// --------------------------------------------------------------------------

/**
 * Mark alt-uvset masks in the file name. Purely a convention, but it matches
 * the community template packs, so a mask dropped in from one of those lands
 * under the name expected here.
 */
function withAltUvSuffix(name: string, vehicle: Vehicle): string {
  return vehicle.alternateUvset ? `${name} (alt uvset)` : name;
}

function renderPaintjob(
  vehicle: Vehicle,
  paintjobUnit: string,
  settingsName: string,
  maskPath: string,
  suitableFor: readonly string[],
): string {
  const unit = new SiiUnit("accessory_paint_job_data", `${paintjobUnit}.${vehicle.path}.paint_job`);
  unit.include(settingsName);
  for (const cabinUnit of suitableFor) unit.append("suitable_for", `${cabinUnit}.${vehicle.path}.cabin`);
  unit.set("paint_job_mask", maskPath);
  return new SiiFile(unit).render();
}

/**
 * Overrides pointing individual painted accessories at their own mask.
 *
 * The unit name `.ovrN` is an override slot on the paint job; the file must
 * sit in `paint_job/accessory/` and share the paint job's name for the game to
 * associate the two.
 */
function renderAccessoryOverrides(masks: ReadonlyArray<{ tobjPath: string; units: readonly string[] }>): string {
  const file = new SiiFile();
  masks.forEach((mask, index) => {
    const unit = new SiiUnit("simple_paint_job_data", `.ovr${index}`);
    unit.set("paint_job_mask", mask.tobjPath);
    unit.extend("acc_list", mask.units);
    file.add(unit);
  });
  return file.render();
}

function renderManifest(project: Project): string {
  const unit = new SiiUnit("mod_package", ".package_name");
  unit.set("package_version", project.mod.version);
  unit.set("display_name", project.mod.name);
  unit.set("author", project.mod.author);
  unit.blank();
  unit.append("category", "paint_job");
  unit.blank();
  unit.set("icon", "Mod_Manager_Image.jpg");
  unit.set("description_file", "Mod_Manager_Description.txt");
  return new SiiFile(unit).render();
}

function renderVersions(): string {
  const unit = new SiiUnit("package_version_info", ".universal");
  unit.set("package_name", "universal");
  return new SiiFile(unit).render();
}

function renderDescription(project: Project): string {
  const { vehicle } = project;
  const lines: string[] = [];
  if (project.mod.description) lines.push(project.mod.description, "");
  const owner = vehicle.isMod ? `${vehicle.author}'s ` : "";
  lines.push(`Paint job for ${owner}${vehicle.name}.`);
  if (vehicle.separatePaintjobs && vehicle.cabins.length > 0) {
    lines.push("", "Cabins supported:");
    for (const cabin of vehicle.cabins) lines.push(`- ${cabin.displayName}`);
  }
  lines.push("", "Built with euro-creator.");
  return lines.join("\n") + "\n";
}

async function renderModImage(project: Project, options: BuildOptions): Promise<Buffer> {
  const [width, height] = MOD_IMAGE_SIZE;
  const ref = project.mod.icon ?? project.skin.icon;
  let image = createImage(width, height, [28, 30, 34, 255]);
  if (ref) {
    const resolved = await options.resolveTexture(ref);
    image = await letterbox(await options.decodeImage(resolved.data, resolved.filename), width, height);
  }
  return encodeJpeg(image);
}

async function renderShopIcon(project: Project, options: BuildOptions): Promise<ModFile[]> {
  const { skin } = project;
  const [width, height] = ICON_SIZE;
  // Letterboxed rather than stretched: a squashed logo is the single most
  // common cosmetic bug in hand-built skin mods.
  let image = createImage(width, height, [0, 0, 0, 0]);
  if (skin.icon) {
    const resolved = await options.resolveTexture(skin.icon);
    image = await letterbox(await options.decodeImage(resolved.data, resolved.filename), width, height);
  }

  const ddsName = `${skin.assetName} Icon.dds`;
  const dir = "material/ui/accessory";
  return [
    { path: `${dir}/${ddsName}`, data: encodeDds(image, { format: "dxt5", mipmaps: true }) },
    // Clamped: the icon does not tile, and repeat addressing shows a seam on
    // the mip levels the UI picks at small sizes.
    { path: `${dir}/${skin.assetName} Icon.tobj`, data: buildTobj(`/${dir}/${ddsName}`, { clamp: true }) },
    {
      path: `${dir}/${skin.unitName}_icon.mat`,
      data: Buffer.from(
        `material: "ui"\n{\n\ttexture: "${skin.assetName} Icon.tobj"\n\ttexture_name: "texture"\n}\n`,
        "utf8",
      ),
    },
  ];
}

/** Unused export kept for callers that only need a PNG preview of a mask. */
export { encodePng };
