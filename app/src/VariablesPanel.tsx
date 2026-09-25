// The variable table: every variable with its expression, its current value
// (or why it has none), unit, type and group. Edits go through the document
// history like every other change.
import { useEffect, useState } from "react";
import type { CadDocument, Variable } from "../../src/document/schema.ts";
import {
  renameVariable,
  type VariableValues,
} from "../../src/document/variables.ts";
import { newId } from "../../src/document/sketch-edit.ts";

const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Change = { [K in keyof Variable]?: Variable[K] | undefined };

export function VariablesPanel({
  document,
  values,
  apply,
}: {
  document: CadDocument;
  values: VariableValues;
  apply: (
    change: (document: CadDocument) => CadDocument,
    merge?: string,
  ) => void;
}) {
  /** Merges fields into a variable; a field set to undefined is removed. */
  const update = (id: string, change: Change, merge?: string) =>
    apply(
      (d) => ({
        ...d,
        variables: d.variables.map((v) => {
          if (v.id !== id) return v;
          const next: Record<string, unknown> = { ...v, ...change };
          for (const [key, value] of Object.entries(change))
            if (value === undefined) delete next[key];
          return next as unknown as Variable;
        }),
      }),
      merge,
    );
  const add = () =>
    apply((d) => {
      let n = d.variables.length + 1;
      while (d.variables.some((v) => v.name === `var${n}`)) n++;
      return {
        ...d,
        variables: [
          ...d.variables,
          { id: newId("v"), name: `var${n}`, expression: "100", unit: "mm" },
        ],
      };
    });
  const remove = (id: string) =>
    apply((d) => ({ ...d, variables: d.variables.filter((v) => v.id !== id) }));

  return (
    <section className="variables-panel" aria-label="Variables">
      <header>
        <h2>Variables</h2>
        <button onClick={add}>Add</button>
      </header>
      {document.variables.length === 0 ? (
        <p className="hint">
          Variables drive dimensions: give a dimension an expression such as{" "}
          <code>width - 2 * thickness</code>.
        </p>
      ) : (
        <ul className="variable-list">
          {document.variables.map((variable) => (
            <Row
              key={variable.id}
              variable={variable}
              taken={document.variables
                .filter((v) => v.id !== variable.id)
                .map((v) => v.name)}
              value={values.values.get(variable.name)}
              error={values.errors.get(variable.id)}
              update={(change, merge) => update(variable.id, change, merge)}
              rename={(name) =>
                apply((d) => renameVariable(d, variable.id, name))
              }
              remove={() => remove(variable.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  variable,
  taken,
  value,
  error,
  update,
  rename,
  remove,
}: {
  variable: Variable;
  taken: readonly string[];
  value: number | undefined;
  error: string | undefined;
  update: (change: Change, merge?: string) => void;
  rename: (name: string) => void;
  remove: () => void;
}) {
  // The name is committed on blur, so half-typed names never reach the
  // document; invalid ones are shown and not applied.
  const [name, setName] = useState(variable.name);
  // Follow the document when undo or redo changes the name.
  useEffect(() => setName(variable.name), [variable.name]);
  const nameProblem = !namePattern.test(name)
    ? "Letters, digits and _, starting with a letter"
    : taken.includes(name)
      ? "Another variable has this name"
      : undefined;
  const shown =
    value === undefined
      ? "—"
      : variable.kind === "boolean"
        ? value
          ? "yes"
          : "no"
        : `${Math.round(value * 1000) / 1000}${variable.unit === "none" ? "" : ` ${variable.unit}`}`;
  return (
    <li className={error ? "invalid" : undefined}>
      <div className="variable-main">
        <input
          aria-label="Name"
          className="name"
          value={name}
          aria-invalid={!!nameProblem}
          title={nameProblem}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (nameProblem) setName(variable.name);
            else rename(name);
          }}
        />
        <span className="equals">=</span>
        <input
          aria-label="Expression"
          className="expression"
          value={variable.expression}
          onChange={(event) =>
            update(
              { expression: event.target.value },
              `variable:${variable.id}:expression`,
            )
          }
        />
        <span className="value" title={error ?? shown}>
          {error ? "—" : shown}
        </span>
        <button
          className="icon"
          aria-label={`Delete ${variable.name}`}
          onClick={remove}
        >
          ×
        </button>
      </div>
      {error ? <p className="error variable-error">{error}</p> : null}
      <div className="variable-details">
        <select
          aria-label="Unit"
          value={variable.unit}
          onChange={(event) =>
            update({ unit: event.target.value as Variable["unit"] })
          }
        >
          <option value="mm">mm</option>
          <option value="deg">deg</option>
          <option value="none">no unit</option>
        </select>
        <select
          aria-label="Type"
          value={variable.kind ?? "number"}
          onChange={(event) => {
            const kind = event.target.value as NonNullable<Variable["kind"]>;
            update(
              kind === "select"
                ? {
                    kind,
                    unit: "none",
                    options: variable.options ?? [
                      { label: "One", value: 1 },
                      { label: "Two", value: 2 },
                    ],
                  }
                : kind === "boolean"
                  ? { kind, unit: "none" }
                  : { kind },
            );
          }}
        >
          <option value="number">Number</option>
          <option value="boolean">Yes / no</option>
          <option value="select">Choice</option>
        </select>
        <input
          aria-label="Group"
          className="group"
          placeholder="Group"
          value={variable.group ?? ""}
          onChange={(event) =>
            update(
              { group: event.target.value || undefined },
              `variable:${variable.id}:group`,
            )
          }
        />
        {variable.kind === "select" ? (
          <input
            aria-label="Choices"
            className="options"
            title="Choices as label=value, separated by commas"
            defaultValue={(variable.options ?? [])
              .map((o) => `${o.label}=${o.value}`)
              .join(", ")}
            onBlur={(event) => {
              const options = event.target.value
                .split(",")
                .map((part) => part.split("="))
                .filter(([label, value]) => label?.trim() && value?.trim())
                .map(([label, value]) => ({
                  label: label!.trim(),
                  value: Number(value),
                }))
                .filter((o) => Number.isFinite(o.value));
              if (options.length) update({ options });
            }}
          />
        ) : null}
      </div>
    </li>
  );
}
