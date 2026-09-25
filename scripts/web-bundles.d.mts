import type { BuildOptions } from "esbuild";

export function kernelBundleOptions(root: string, outdir: string): BuildOptions;
export function copyKernelWasm(root: string, outdir: string): Promise<void>;
