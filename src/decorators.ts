import {
  Component,
  PartInterface,
  construction,
  interfaceMethods,
} from "./model.js";
import type { MotionStudy } from "./motion.js";
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
}
export interface TechniqueDecoratorOptions extends PartDecoratorOptions {}
export interface OutputDecoratorOptions {
  readonly id?: string;
  readonly fileName?: string;
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
export const catalog = new Map<string, AnyConstructor>();
function registered(options: { id: string }): RegisteredClassDecorator {
  return (value) => {
    const wrapped = new Proxy(value, {
      construct(target, args, newTarget) {
        return construction(() => Reflect.construct(target, args, newTarget));
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
  project: registered as (
    o: ProjectDecoratorOptions,
  ) => RegisteredClassDecorator,
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
