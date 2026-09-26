// Bodies as parts: each body's name, material, stock and quantity, and the
// materials they can be made of. A body extruded exactly as deep as a
// sheet material is thick is sheet stock without being told; the list shows
// which bodies that makes sheet parts, with their blank sizes.
import type {
  CadDocument,
  MaterialDefinition,
  PartProperties,
} from "../../src/document/schema.ts";
import type { VariableValues } from "../../src/document/variables.ts";
import type { Model } from "./kernel.ts";
import { Choice, ExpressionField, Field } from "./features/fields.tsx";

type Apply = (change: (document: CadDocument) => CadDocument) => void;
/** Fields to merge in; a field set to undefined is removed. */
type Change<T> = { [K in keyof T]?: T[K] | undefined };

const merged = <T extends object>(value: T, change: Change<T>): T => {
  const next: Record<string, unknown> = { ...value, ...change };
  for (const [key, field] of Object.entries(change))
    if (field === undefined) delete next[key];
  return next as T;
};

export function PartsPanel({
  document,
  model,
  variables,
  apply,
  select,
  selected,
}: {
  document: CadDocument;
  model: Model | undefined;
  variables: VariableValues;
  apply: Apply;
  select(body: string | undefined): void;
  selected: string | undefined;
}) {
  const materials = document.materials ?? [];
  const setPart = (body: string, change: Change<PartProperties>) =>
    apply((d) => {
      const parts = d.parts ?? [];
      const next = merged(
        parts.find((p) => p.body === body) ?? { body },
        change,
      );
      const others = parts.filter((p) => p.body !== body);
      // Only what differs from the defaults is kept.
      return {
        ...d,
        parts: Object.keys(next).length > 1 ? [...others, next] : others,
      };
    });
  const setMaterial = (id: string, change: Change<MaterialDefinition>) =>
    apply((d) => ({
      ...d,
      materials: (d.materials ?? []).map((m) =>
        m.id === id ? merged(m, change) : m,
      ),
    }));
  const addMaterial = () =>
    apply((d) => {
      const all = d.materials ?? [];
      let n = all.length + 1;
      while (all.some((m) => m.id === `m${n}`)) n++;
      return {
        ...d,
        materials: [
          ...all,
          {
            id: `m${n}`,
            name: `Plywood ${n}`,
            kind: "sheet",
            thickness: "18",
            width: "2500",
            height: "1250",
          },
        ],
      };
    });
  const parts = model?.parts ?? [];
  const sheets = parts.filter((p) => p.stock === "sheet");
  return (
    <section className="parts-panel" aria-label="Parts">
      <header>
        <h2>Parts</h2>
      </header>
      {parts.length === 0 ? (
        <p className="hint">Extrude a sketch to make a body.</p>
      ) : (
        <ul className="part-list">
          {parts.map((part) => {
            const props = document.parts?.find((p) => p.body === part.body);
            return (
              <li
                key={part.body}
                className={part.body === selected ? "selected" : undefined}
              >
                <div className="part-main">
                  <input
                    aria-label="Part name"
                    value={props?.name ?? part.name}
                    onFocus={() => select(part.body)}
                    onChange={(event) =>
                      setPart(part.body, {
                        name: event.target.value || undefined,
                      })
                    }
                  />
                  <input
                    aria-label="Quantity"
                    className="quantity"
                    type="number"
                    min={1}
                    value={part.quantity}
                    onChange={(event) =>
                      setPart(part.body, {
                        quantity:
                          Math.max(1, Math.round(Number(event.target.value))) ||
                          1,
                      })
                    }
                  />
                </div>
                <div className="part-details">
                  <select
                    aria-label="Material"
                    value={props?.material ?? ""}
                    onChange={(event) =>
                      setPart(part.body, {
                        material: event.target.value || undefined,
                      })
                    }
                  >
                    <option value="">
                      {part.material && !props?.material
                        ? `auto: ${part.material.name}`
                        : "no material"}
                    </option>
                    {materials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Stock"
                    value={props?.stock ?? "auto"}
                    onChange={(event) =>
                      setPart(part.body, {
                        stock:
                          event.target.value === "auto"
                            ? undefined
                            : (event.target.value as "sheet" | "solid"),
                      })
                    }
                  >
                    <option value="auto">
                      auto ({part.stock === "sheet" ? "sheet" : "solid"})
                    </option>
                    <option value="sheet">sheet</option>
                    <option value="solid">solid</option>
                  </select>
                  {part.stock === "sheet" ? (
                    <span className="hint">
                      {part.width} × {part.height} × {part.thickness}
                    </span>
                  ) : null}
                </div>
                {part.problem ? (
                  <p className="warning part-problem">{part.problem}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {sheets.length ? (
        <p className="hint">
          {sheets.reduce((n, p) => n + p.quantity, 0)} sheet part
          {sheets.reduce((n, p) => n + p.quantity, 0) === 1 ? "" : "s"} for the
          cut list, nesting and DXF.
        </p>
      ) : null}

      <header>
        <h2>Materials</h2>
        <button onClick={addMaterial}>Add</button>
      </header>
      {materials.length === 0 ? (
        <p className="hint">
          Add the sheet stock you have: bodies as deep as it is thick become
          sheet parts.
        </p>
      ) : (
        <ul className="material-list">
          {materials.map((material) => (
            <li key={material.id}>
              <div className="part-main">
                <input
                  aria-label="Material name"
                  value={material.name}
                  onChange={(event) =>
                    setMaterial(material.id, { name: event.target.value })
                  }
                />
                <button
                  className="icon"
                  aria-label={`Delete ${material.name}`}
                  onClick={() =>
                    apply((d) => ({
                      ...d,
                      materials: (d.materials ?? []).filter(
                        (m) => m.id !== material.id,
                      ),
                      parts: (d.parts ?? []).map((p) =>
                        p.material === material.id
                          ? (({ material: _m, ...rest }) => rest)(p)
                          : p,
                      ),
                    }))
                  }
                >
                  ×
                </button>
              </div>
              <Choice
                label="Kind"
                value={material.kind}
                options={[
                  ["sheet", "Sheet"],
                  ["board", "Board"],
                  ["solid", "Solid"],
                ]}
                commit={(kind) =>
                  setMaterial(material.id, {
                    kind,
                    ...(kind !== "solid" && !material.thickness
                      ? { thickness: "18" }
                      : {}),
                  })
                }
              />
              {material.kind !== "solid" ? (
                <>
                  <ExpressionField
                    label="Thickness"
                    value={material.thickness}
                    variables={variables}
                    commit={(thickness) =>
                      setMaterial(material.id, { thickness: thickness ?? "18" })
                    }
                  />
                  <Field label="Sheet size">
                    <span className="size">
                      <input
                        aria-label="Sheet width"
                        value={material.width ?? ""}
                        placeholder="width"
                        onChange={(event) =>
                          setMaterial(material.id, {
                            width: event.target.value || undefined,
                          })
                        }
                      />
                      ×
                      <input
                        aria-label="Sheet height"
                        value={material.height ?? ""}
                        placeholder="height"
                        onChange={(event) =>
                          setMaterial(material.id, {
                            height: event.target.value || undefined,
                          })
                        }
                      />
                    </span>
                  </Field>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
