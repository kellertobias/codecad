import {
  Component,
  PartInterface,
  Project,
  construction,
  interfaceMethods,
} from "./model.js";
import type { MotionStudy } from "./motion.js";
import { parameter } from "./parameters.js";
import type {
  CutList,
  ManufacturingDxf,
  StepModel,
  TechnicalDrawing,
} from "./outputs.js";
export interface ProjectDecoratorOptions {
  readonly id: string;
  readonly title?: string;
  readonly units: "mm";
}
export interface PartDecoratorOptions {
  readonly id: string;
  readonly revision: string;
  /** Default label for instances that pass none to `super()`. */
  readonly title?: string;
}
export interface TechniqueDecoratorOptions extends PartDecoratorOptions {}
export interface OutputDecoratorOptions {
  readonly id?: string;
  readonly fileName?: string;
  readonly title?: string;
}
type AnyConstructor = abstract new (...args: any[]) => any;
export interface RegisteredClassDecorator {
  <T extends AnyConstructor>(
    value: T,
    context: ClassDecoratorContext<T>,
  ): T | void;
}
export interface RegisteredMethodDecorator<R> {
  <This, Args extends any[], Actual extends R>(
    value: (this: This, ...args: Args) => Actual,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Actual
    >,
  ): ((this: This, ...args: Args) => Actual) | void;
}
export interface OutputRegistration {
  kind: string;
  name: string;
  options: OutputDecoratorOptions;
}
export const outputRegistry = new WeakMap<object, OutputRegistration[]>();
/** A project class, or a function returning one. The lazy form lets an output
 * module import the project it belongs to even when the project module imports
 * that output module back: the class is only read when the build matches
 * providers, by which time both modules have finished evaluating. */
export type ProjectTypeReference = AnyConstructor | (() => AnyConstructor);
export const outputProviders: {
  projectType: ProjectTypeReference;
  providerType: new (project: any) => object;
}[] = [];
/** The project class an output provider is bound to: the class itself, or what
 * its lazy reference returns. */
export function projectTypeOf(
  reference: ProjectTypeReference,
  provider?: AnyConstructor,
): AnyConstructor {
  const isProjectClass = (value: unknown): value is AnyConstructor =>
    typeof value === "function" &&
    (value === Project || value.prototype instanceof Project);
  if (isProjectClass(reference)) return reference;
  let resolved: unknown;
  let cause: unknown;
  try {
    resolved = (reference as () => AnyConstructor)();
  } catch (error) {
    cause = error;
  }
  if (isProjectClass(resolved)) return resolved;
  throw new Error(
    `${provider?.name ?? "An output provider"} is not bound to a Project class; pass the class, or "() => TheProject" when the project module imports this one`,
    cause === undefined ? undefined : { cause },
  );
}
export const catalog = new Map<string, AnyConstructor>();
function registered(options: {
  id: string;
  title?: string;
}): RegisteredClassDecorator {
  return (value) => {
    const wrapped = new Proxy(value, {
      construct(target, args, newTarget) {
        return construction(
          () => Reflect.construct(target, args, newTarget),
          false,
          {
            id: options.id,
            ...(options.title ? { label: options.title } : {}),
          },
        );
      },
    });
    catalog.set(options.id, wrapped);
    return wrapped;
  };
}
function output<R>(
  kind: string,
  options: OutputDecoratorOptions = {},
): RegisteredMethodDecorator<R> {
  return (_value, context) => {
    if (context.private || context.static)
      throw new Error("CAD output methods must be public instance methods");
    context.addInitializer(function () {
      const owner = this as object;
      const list = outputRegistry.get(owner) ?? [];
      list.push({ kind, name: String(context.name), options });
      outputRegistry.set(owner, list);
    });
  };
}
export const cad = {
  parameter,
  project: registered as (
    o: ProjectDecoratorOptions,
  ) => RegisteredClassDecorator,
  /** Bind a separately constructed output class to the active project instance. */
  outputsFor:
    (projectType: ProjectTypeReference): RegisteredClassDecorator =>
    (value) => {
      outputProviders.push({
        projectType,
        providerType: value as unknown as new (project: any) => object,
      });
    },
  part: registered as (o: PartDecoratorOptions) => RegisteredClassDecorator,
  technique: registered as (
    o: TechniqueDecoratorOptions,
  ) => RegisteredClassDecorator,
  interface: (
    options: { name?: string; default?: boolean } = {},
  ): RegisteredMethodDecorator<PartInterface> => {
    return function (value, context) {
      context.addInitializer(function () {
        const methods =
          interfaceMethods.get(this as object) ?? new Map<string, string>();
        methods.set(options.name ?? String(context.name), String(context.name));
        if (options.default) methods.set("default", String(context.name));
        interfaceMethods.set(this as object, methods);
      });
      return function (...args) {
        const result = value.apply(this, args);
        if (!(this instanceof Component))
          throw new Error("Interfaces must be exposed by components");
        const bound = result.bind(this);
        return bound as ReturnType<typeof value>;
      };
    };
  },
  output: {
    technicalDrawing: (o?: OutputDecoratorOptions) =>
      output<TechnicalDrawing>("drawing", o),
    cutList: (o?: OutputDecoratorOptions) => output<CutList>("cutList", o),
    manufacturingDxf: (o?: OutputDecoratorOptions) =>
      output<ManufacturingDxf>("dxf", o),
    step: (o?: OutputDecoratorOptions) => output<StepModel>("step", o),
    motion: (o?: OutputDecoratorOptions) => output<MotionStudy>("motion", o),
  },
};
