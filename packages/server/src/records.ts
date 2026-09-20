/** Shapes persisted in the workspace and returned by the API. */

import type { MaskReport, ProjectInput, VehicleInput, VerifyReport } from "@euro-creator/core";

export type UploadKind = "image" | "blend" | "other";

export interface UploadRecord {
  readonly id: string;
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly uploaded: string;
  readonly kind: UploadKind;
  /** Present for images; the dimensions a mask has to match. */
  readonly image?: { readonly width: number; readonly height: number };
}

export interface BlendRoot {
  readonly name: string;
  readonly parts: readonly string[];
  readonly variants: ReadonlyArray<{ name: string; parts: readonly string[] }>;
  readonly paintMaterials: ReadonlyArray<{
    name: string;
    effect: string;
    altUvset: boolean;
    uvLayer: string | null;
  }>;
  readonly paintObjects: ReadonlyArray<{ object: string; part: string; polygons: number }>;
  readonly altUvset: boolean;
  readonly mixedUvset: boolean;
}

export interface TemplateInfo {
  readonly size: number;
  readonly polygons: number;
  readonly groups: readonly string[];
  readonly rendered: string;
}

export interface VehicleRecord {
  readonly id: string;
  readonly created: string;
  updated: string;
  vehicle: VehicleInput;
  /** Set when this vehicle was drafted from a .blend. */
  source?: {
    readonly blendUploadId: string;
    readonly blendFilename: string;
    readonly roots: readonly BlendRoot[];
    readonly scsToolsLoaded: boolean;
    readonly blenderVersion: readonly number[];
  };
  template?: TemplateInfo;
}

export interface ProjectRecord {
  readonly id: string;
  readonly created: string;
  updated: string;
  /** The vehicle is stored inline, so a project stays buildable if the vehicle is edited. */
  project: ProjectInput;
  /** Which saved vehicle it was copied from, for the UI's "update from vehicle" action. */
  vehicleId?: string;
}

export interface BuildRecord {
  readonly id: string;
  readonly projectId: string;
  readonly created: string;
  readonly archiveName: string;
  readonly archiveBytes: number;
  readonly totalBytes: number;
  readonly masks: readonly MaskReport[];
  readonly warnings: readonly string[];
  readonly verify: VerifyReport;
  readonly files: ReadonlyArray<{ path: string; bytes: number }>;
}
