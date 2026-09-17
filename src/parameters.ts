export type NumberParameter = {
  readonly type: "number";
  readonly label: string;
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
};
export type BooleanParameter = {
  readonly type: "boolean";
  readonly label: string;
  readonly default: boolean;
};
export type SelectParameter<T extends string = string> = {
  readonly type: "select";
  readonly label: string;
  readonly default: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly unit?: string;
};
export type ParameterDefinition =
  NumberParameter | BooleanParameter | SelectParameter;
export type ParameterSchema = Record<string, ParameterDefinition>;
export type ParameterValues<S extends ParameterSchema> = {
  readonly [K in keyof S]: S[K] extends NumberParameter
    ? number
    : S[K] extends BooleanParameter
      ? boolean
      : S[K] extends SelectParameter<infer T>
        ? T
        : never;
};
export type ParameterState = {
  definitions: ParameterSchema;
  values: Record<string, number | boolean | string>;
};

export function defineParameters<const S extends ParameterSchema>(
  schema: S,
): S {
  for (const [key, definition] of Object.entries(schema)) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key))
      throw new Error(`Invalid parameter name: ${key}`);
    if (!definition.label.trim())
      throw new Error(`Parameter ${key} needs a label`);
    if (definition.type === "number") {
      for (const value of [definition.default, definition.min, definition.max])
        if (value !== undefined && !Number.isFinite(value))
          throw new Error(`Parameter ${key} must be finite`);
      if (
        definition.min !== undefined &&
        definition.max !== undefined &&
        definition.min > definition.max
      )
        throw new Error(`Parameter ${key} has reversed bounds`);
      if (
        definition.step !== undefined &&
        (!Number.isFinite(definition.step) || definition.step <= 0)
      )
        throw new Error(`Parameter ${key} needs a positive step`);
    } else if (definition.type === "select") {
      if (
        !definition.options.length ||
        new Set(definition.options.map((option) => option.value)).size !==
          definition.options.length
      )
        throw new Error(`Parameter ${key} needs distinct options`);
      if (definition.options.some((option) => !option.label.trim()))
        throw new Error(`Parameter ${key} needs option labels`);
    }
    validateParameterValue(key, definition, definition.default);
  }
  return schema;
}

/** Reusable input definitions whose defaults can be overridden per project. */
export class InputParameters<S extends ParameterSchema> {
  constructor(readonly definitions: S) {
    defineParameters(definitions);
  }

  /** Return a validated schema with new defaults; Studio overrides still win. */
  with(defaults: Partial<ParameterValues<S>> = {}): S {
    const values = resolveParameters(this.definitions, defaults);
    return defineParameters(
      Object.fromEntries(
        Object.entries(this.definitions).map(([key, definition]) => [
          key,
          { ...definition, default: values[key as keyof S] },
        ]),
      ) as unknown as S,
    );
  }
}

export function inputParameters<S extends ParameterSchema>(
  definitions: S,
): InputParameters<S> {
  return new InputParameters(definitions);
}

export function validateParameterValue(
  key: string,
  definition: ParameterDefinition,
  value: unknown,
): asserts value is number | boolean | string {
  if (definition.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (definition.min !== undefined && value < definition.min) ||
      (definition.max !== undefined && value > definition.max)
    )
      throw new Error(
        `Parameter ${key} must be a finite number within its bounds`,
      );
  } else if (definition.type === "boolean") {
    if (typeof value !== "boolean")
      throw new Error(`Parameter ${key} must be a boolean`);
  } else if (
    typeof value !== "string" ||
    !definition.options.some((option) => option.value === value)
  ) {
    throw new Error(`Parameter ${key} must be one of its options`);
  }
}

export function resolveParameters<const S extends ParameterSchema>(
  schema: S,
  overrides: unknown = {},
): ParameterValues<S> {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new Error("Parameter values must be an object");
  const input = overrides as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!(key in schema)) throw new Error(`Unknown parameter: ${key}`);
  const values: Record<string, number | boolean | string> = {};
  for (const [key, definition] of Object.entries(schema)) {
    const value = key in input ? input[key] : definition.default;
    validateParameterValue(key, definition, value);
    values[key] = value;
  }
  return values as ParameterValues<S>;
}
