// Form fields for feature parameters. Numeric fields hold expressions:
// they are committed on Enter or when focus leaves, and show the value the
// expression has now (or why it has none).
import { useEffect, useState, type ReactNode } from "react";
import {
  evaluateWith,
  type VariableValues,
} from "../../../src/document/variables.ts";

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">{children}</span>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function ExpressionField({
  label,
  value,
  variables,
  unit = "mm",
  optional,
  placeholder,
  commit,
}: {
  label: string;
  value: string | undefined;
  variables: VariableValues;
  unit?: string;
  /** Empty is allowed and commits undefined. */
  optional?: boolean;
  placeholder?: string;
  commit: (value: string | undefined) => void;
}) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  let shown: string;
  let problem = false;
  if (!text.trim()) {
    shown = optional ? "" : "required";
    problem = !optional;
  } else
    try {
      const v = evaluateWith(text, variables);
      shown = `= ${Math.round(v * 1000) / 1000}${unit ? ` ${unit}` : ""}`;
    } catch (error) {
      shown = error instanceof Error ? error.message : String(error);
      problem = true;
    }
  const done = () => {
    const next = text.trim();
    if (!next && !optional) return setText(value ?? "");
    if ((next || undefined) !== value) commit(next || undefined);
  };
  return (
    <Field
      label={label}
      hint={
        shown ? (
          <span className={problem ? "error" : "hint"}>{shown}</span>
        ) : null
      }
    >
      <input
        className="expression"
        value={text}
        placeholder={placeholder}
        aria-invalid={problem}
        onChange={(event) => setText(event.target.value)}
        onBlur={done}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setText(value ?? "");
        }}
      />
    </Field>
  );
}

export function Choice<T extends string>({
  label,
  value,
  options,
  commit,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  commit: (value: T) => void;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(event) => commit(event.target.value as T)}
      >
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** A list of checkboxes; `checked` lists the chosen values. */
export function Checklist({
  label,
  items,
  checked,
  commit,
  empty,
  hint,
}: {
  label: string;
  items: readonly { value: string; label: string }[];
  checked: readonly string[];
  commit: (values: string[]) => void;
  empty: string;
  hint?: string;
}) {
  return (
    <fieldset className="checklist">
      <legend>{label}</legend>
      {items.length === 0 ? <p className="hint">{empty}</p> : null}
      {items.map((item) => (
        <label key={item.value}>
          <input
            type="checkbox"
            checked={checked.includes(item.value)}
            onChange={(event) =>
              commit(
                event.target.checked
                  ? [...checked, item.value]
                  : checked.filter((v) => v !== item.value),
              )
            }
          />
          {item.label}
        </label>
      ))}
      {hint ? <p className="hint">{hint}</p> : null}
    </fieldset>
  );
}
