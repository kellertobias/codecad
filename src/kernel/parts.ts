// Bodies as parts: what each evaluated body is made of, and, for sheet
// stock, the SheetPart the existing manufacturing outputs (cut list,
// nesting, DXF) already know how to handle.
//
// A body counts as sheet stock when it is a flat blank (an extruded region)
// exactly as deep as its sheet material is thick. It keeps the blank's
// outline and the cuts made into it afterwards, brought into the blank's
// own frame: thickness along +Z from 0, as SheetPart expects.
import { Matrix4 } from "three";
import { Assembly, Shapes, construction, type Recipe } from "../model.js";
import { SheetMaterial, SheetPart } from "../stock.js";
import { frameMatrix } from "../document/frames.js";
import type {
  CadDocument,
  MaterialDefinition,
  PartProperties,
} from "../document/schema.js";
import {
  evaluateVariables,
  evaluateWith,
  type VariableValues,
} from "../document/variables.js";
import type { Body } from "./evaluator.js";

export type BodyShape = Pick<
  Body,
  "id" | "name" | "blank" | "machining" | "irregular"
>;

export interface PartInfo {
  readonly body: string;
  readonly name: string;
  readonly quantity: number;
  readonly material?: MaterialDefinition;
  readonly stock: "sheet" | "solid";
  /** Sheet parts: the material's thickness. */
  readonly thickness?: number;
  /** Why a body set to sheet stock is not one, or why its DXF would miss
   * something. */
  readonly problem?: string;
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function thicknessOf(
  material: MaterialDefinition,
  variables: VariableValues,
): number | undefined {
  if (material.kind === "solid" || material.thickness === undefined)
    return undefined;
  try {
    return evaluateWith(material.thickness, variables);
  } catch {
    return undefined;
  }
}

/** What every body is as a part. */
export function describeParts(
  document: CadDocument,
  bodies: readonly BodyShape[],
): PartInfo[] {
  const variables = evaluateVariables(document.variables);
  const materials = document.materials ?? [];
  const properties = new Map(
    (document.parts ?? []).map((p): [string, PartProperties] => [p.body, p]),
  );
  return bodies.map((body) => {
    const props = properties.get(body.id);
    const stock = props?.stock ?? "auto";
    const depth = body.blank?.depth;
    let material = props?.material
      ? materials.find((m) => m.id === props.material)
      : undefined;
    // With no material chosen, a blank takes the first sheet material
    // exactly as thick as it is deep.
    if (!props?.material && stock !== "solid" && depth !== undefined)
      material = materials.find((m) => {
        const t = thicknessOf(m, variables);
        return t !== undefined && close(t, depth);
      });
    const thickness = material && thicknessOf(material, variables);
    const base = {
      body: body.id,
      name: props?.name ?? body.name,
      quantity: props?.quantity ?? 1,
      ...(material ? { material } : {}),
    };
    const fits =
      thickness !== undefined && depth !== undefined && close(thickness, depth);
    if (stock === "solid" || (stock === "auto" && !fits))
      return { ...base, stock: "solid" as const };
    if (!fits)
      return {
        ...base,
        stock: "solid" as const,
        problem: !body.blank
          ? "It is not a flat blank, so it cannot be cut from sheet stock"
          : !material
            ? "Choose a sheet material for it"
            : thickness === undefined
              ? `${material.name} has no thickness`
              : `It is ${round(depth!)} mm deep, but ${material.name} is ${round(thickness)} mm thick`,
      };
    return {
      ...base,
      stock: "sheet" as const,
      thickness,
      ...(body.irregular
        ? {
            problem: `Its DXF shows the blank and its cuts only: ${body.irregular}`,
          }
        : {}),
    };
  });
}

const round = (value: number) => Math.round(value * 1000) / 1000;

class DocumentParts extends Assembly {}

export interface SheetProject {
  /** The sheet parts, as children of one assembly, for cut lists. */
  readonly root: Assembly;
  readonly parts: ReadonlyMap<string, SheetPart>;
}

/** SheetParts for the bodies `describeParts` found to be sheet stock. */
export function sheetProject(
  document: CadDocument,
  bodies: readonly BodyShape[],
  info: readonly PartInfo[] = describeParts(document, bodies),
): SheetProject {
  const variables = evaluateVariables(document.variables);
  const value = (expression: string | undefined) => {
    if (expression === undefined) return undefined;
    try {
      return evaluateWith(expression, variables);
    } catch {
      return undefined;
    }
  };
  const materials = new Map<string, SheetMaterial>();
  const materialFor = (definition: MaterialDefinition, thickness: number) => {
    let material = materials.get(definition.id);
    if (!material) {
      const width = value(definition.width);
      const height = value(definition.height);
      material = new SheetMaterial({
        id: definition.id,
        name: definition.name,
        thickness,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(definition.grain ? { grain: definition.grain } : {}),
        ...(definition.density ? { densityKgPerM3: definition.density } : {}),
        ...(definition.color && /^#[0-9a-f]{6}$/i.test(definition.color)
          ? { color: definition.color as `#${string}` }
          : {}),
      });
      materials.set(definition.id, material);
    }
    return material;
  };
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const parts = new Map<string, SheetPart>();
  const root = construction(() => {
    const assembly = new DocumentParts({ id: "document", label: "Document" });
    for (const part of info) {
      if (part.stock !== "sheet") continue;
      const body = byId.get(part.body)!;
      const blank = body.blank!;
      const outline = new Shapes.Polygon({ points: blank.outline });
      if (blank.curved) outline.fitArcs(0.01);
      const sheet = new SheetPart(
        materialFor(part.material!, part.thickness!),
        {
          id: part.body,
          label: part.name,
          outline,
          quantity: part.quantity,
        },
      );
      const local = new Matrix4().fromArray(frameMatrix(blank.frame)).invert();
      const cut = (kind: string, recipe: Recipe, extra: object = {}) => {
        sheet.recipe = { kind: "cut", left: sheet.recipe, right: recipe };
        sheet.operations.push({ kind, recipe, ...extra });
      };
      for (const opening of blank.openings)
        cut("cut", {
          kind: "extrude",
          points: [...opening],
          height: blank.depth,
        });
      for (const machining of body.machining)
        cut(
          machining.kind,
          {
            kind: "transform",
            source: machining.recipe,
            matrix: local.toArray(),
          },
          {
            ...(machining.diameter !== undefined
              ? { diameter: machining.diameter }
              : {}),
            ...(machining.depth !== undefined
              ? { depth: machining.depth }
              : {}),
          },
        );
      parts.set(part.body, sheet);
    }
    return assembly;
  });
  return { root, parts };
}
