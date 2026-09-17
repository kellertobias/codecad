export type OutputAvailability = {
  files: { kind: string }[];
  reports: { kind: string }[];
  cutList: unknown[];
};

export function availableViews(output: OutputAvailability) {
  return {
    drawing: true,
    nesting:
      output.reports.some((report) => report.kind === "nesting") ||
      output.files.some((file) => file.kind === "nesting"),
    cuts:
      output.reports.some((report) => report.kind === "cutList") ||
      output.cutList.length > 0,
    exports: output.files.length > 0 || output.reports.length > 0,
  };
}
