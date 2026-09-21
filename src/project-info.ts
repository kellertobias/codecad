/** Identity of a project, exported as `PROJECTINFO` from its `index.ts`.
 *
 * The entry file names the project, so Studio and the build can title a model
 * before evaluating any geometry, and drawings that do not set their own
 * author or revision inherit them here. */
export interface ProjectInfo {
  readonly name: string;
  readonly author?: string;
  readonly description?: string;
  /** Printed as REV in drawing title blocks. */
  readonly revision?: string;
}
const optional = ["author", "description", "revision"] as const;
export function validateProjectInfo(value: unknown): ProjectInfo {
  if (!value || typeof value !== "object")
    throw new Error("PROJECTINFO must be an object");
  const info = value as ProjectInfo;
  if (typeof info.name !== "string" || !info.name.trim())
    throw new Error("PROJECTINFO needs a name");
  if (info.name.length > 200)
    throw new Error("PROJECTINFO name is too long (200 characters)");
  for (const key of optional) {
    const field = info[key];
    if (field !== undefined && typeof field !== "string")
      throw new Error(`PROJECTINFO ${key} must be text`);
    if (typeof field === "string" && field.length > 2000)
      throw new Error(`PROJECTINFO ${key} is too long`);
  }
  return info;
}
