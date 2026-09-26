// The personal part library: save this project as an item (or a new
// version of one), say where it connects (interfaces), and insert items
// into this project. Items are files too: export one, import one.
import { useState } from "react";
import type {
  CadDocument,
  PartInterfaceDefinition,
  SketchFeature,
} from "../../src/document/schema.ts";
import { insertInstance } from "../../src/document/library.ts";
import { library, type LibraryItemSummary } from "./api.ts";
import { kernel } from "./kernel.ts";
import { Checklist, Choice, Field } from "./features/fields.tsx";
import { CodePartEditor } from "./code/CodePartEditor.tsx";
import { starterSource } from "./code/sdk-types.ts";
import { Icon } from "./icons.tsx";

type Apply = (change: (document: CadDocument) => CadDocument) => void;

const thumbnailOf = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function LibraryView({
  document,
  items,
  refresh,
  apply,
  rollback,
  inserted,
  report,
}: {
  document: CadDocument;
  items: readonly LibraryItemSummary[];
  refresh(): void;
  apply: Apply;
  rollback: number | undefined;
  inserted(id: string): void;
  report(message: string): void;
}) {
  const [filter, setFilter] = useState("");
  /** A code part open for writing. */
  const [editing, setEditing] = useState<{
    item?: string;
    name: string;
    source: string;
    files?: Readonly<Record<string, string>>;
  }>();
  const shown = items.filter((item) =>
    `${item.name} ${item.tags.join(" ")} ${item.description}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const insert = async (item: LibraryItemSummary) => {
    try {
      const version = await library.version(item.id, item.latest);
      const result = insertInstance(
        document,
        { id: item.id, name: item.name },
        version,
        rollback,
      );
      apply(() => result.document);
      inserted(result.id);
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  };
  if (editing)
    return (
      <CodePartEditor
        initial={editing}
        items={items}
        close={() => setEditing(undefined)}
        saved={(message) => {
          refresh();
          report(message);
          setEditing(undefined);
        }}
      />
    );
  const editCode = async (item: LibraryItemSummary) => {
    try {
      const version = await library.version(item.id, item.latest);
      if (!version.code) return;
      setEditing({
        item: item.id,
        name: item.name,
        source: version.code.source,
      });
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="library">
      <section className="library-items">
        <header>
          <h2>Library</h2>
          <button
            title="A part written in TypeScript; it runs in this browser only"
            onClick={() =>
              setEditing({ name: "Code part", source: starterSource })
            }
          >
            <Icon name="plus" size={16} /> Code part
          </button>
          <input
            type="search"
            placeholder="Find by name or tag"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <label className="button">
            Import…
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                try {
                  await library.importFile(JSON.parse(await file.text()));
                  refresh();
                } catch (error) {
                  report(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }}
            />
          </label>
        </header>
        {!shown.length ? (
          <p className="hint">
            {items.length
              ? "Nothing matches."
              : "Save a project to the library to use it in others."}
          </p>
        ) : (
          <ul className="item-grid">
            {shown.map((item) => (
              <li key={item.id}>
                {item.thumbnail ? (
                  <img src={thumbnailOf(item.thumbnail)} alt="" />
                ) : (
                  <div className="no-thumbnail" />
                )}
                <strong>{item.name}</strong>
                <small>
                  {item.kind === "code" ? "code part · " : ""}version{" "}
                  {item.latest}
                  {item.tags.length ? ` · ${item.tags.join(", ")}` : ""}
                </small>
                <div className="button-row">
                  <button className="primary" onClick={() => void insert(item)}>
                    Insert
                  </button>
                  {item.kind === "code" ? (
                    <button onClick={() => void editCode(item)}>
                      Edit code
                    </button>
                  ) : null}
                  <a className="button" href={library.fileUrl(item.id)}>
                    Export
                  </a>
                  <button
                    className="danger"
                    onClick={async () => {
                      if (!confirm(`Delete ${item.name} from the library?`))
                        return;
                      await library.remove(item.id);
                      refresh();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <aside className="library-side">
        <SaveToLibrary
          document={document}
          items={items}
          saved={refresh}
          report={report}
        />
        <Interfaces document={document} apply={apply} />
      </aside>
    </div>
  );
}

function SaveToLibrary({
  document,
  items,
  saved,
  report,
}: {
  document: CadDocument;
  items: readonly LibraryItemSummary[];
  saved(): void;
  report(message: string): void;
}) {
  const [target, setTarget] = useState("new");
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [exposed, setExposed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const blocked = !document.features.length
    ? "The project is empty."
    : target !== "new" &&
        (document.library ?? []).some((p) => p.item === target)
      ? "This project places the item itself; save it as a new item instead."
      : undefined;
  const save = async () => {
    setBusy(true);
    try {
      const { svg } = await kernel().drawing(document, {
        id: "thumbnail",
        name: target === "new" ? name : "",
        size: "A4",
        views: [{ id: "iso", kind: "view", angle: "isometric", label: " " }],
      });
      const body = {
        document,
        exposed: exposed.filter((n) =>
          document.variables.some((v) => v.name === n),
        ),
        thumbnail: svg,
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      if (target === "new")
        await library.create({
          ...body,
          name: name.trim(),
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        });
      else await library.addVersion(target, body);
      setNote("");
      saved();
      report(
        target === "new"
          ? `Saved ${name.trim()} to the library.`
          : `Saved a new version of ${items.find((i) => i.id === target)?.name}.`,
      );
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="save-to-library">
      <h2>Save this project to the library</h2>
      <Choice
        label="As"
        value={target}
        options={[
          ["new", "a new item"],
          ...items.map(
            (item) =>
              [item.id, `version ${item.latest + 1} of ${item.name}`] as const,
          ),
        ]}
        commit={setTarget}
      />
      {target === "new" ? (
        <>
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tags">
            <input
              value={tags}
              placeholder="hardware, hinge"
              onChange={(e) => setTags(e.target.value)}
            />
          </Field>
        </>
      ) : (
        <Field label="What changed">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      )}
      <Checklist
        label="Variables an instance may set"
        items={document.variables.map((v) => ({
          value: v.name,
          label: `${v.name} = ${v.expression}`,
        }))}
        checked={exposed}
        commit={setExposed}
        empty="The project has no variables."
      />
      {blocked ? <p className="warning">{blocked}</p> : null}
      <button
        className="primary"
        disabled={busy || !!blocked || (target === "new" && !name.trim())}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Save to library"}
      </button>
    </section>
  );
}

function Interfaces({
  document,
  apply,
}: {
  document: CadDocument;
  apply: Apply;
}) {
  const interfaces = document.interfaces ?? [];
  const sketches = document.features.filter(
    (f): f is SketchFeature => f.type === "sketch",
  );
  const set = (id: string, change: Partial<PartInterfaceDefinition>) =>
    apply((d) => ({
      ...d,
      interfaces: (d.interfaces ?? []).map((i) =>
        i.id === id ? { ...i, ...change } : i,
      ),
    }));
  return (
    <section className="interfaces">
      <header>
        <h2>Interfaces</h2>
        <button
          disabled={!sketches.length}
          title={
            sketches.length ? undefined : "Draw a sketch with points first"
          }
          onClick={() =>
            apply((d) => {
              const all = d.interfaces ?? [];
              let n = all.length + 1;
              while (all.some((i) => i.id === `i${n}`)) n++;
              return {
                ...d,
                interfaces: [
                  ...all,
                  {
                    id: `i${n}`,
                    name: `Interface ${n}`,
                    sketch: sketches.at(-1)!.id,
                    kind: "screw",
                    diameter: "3",
                    depth: "12",
                  },
                ],
              };
            })
          }
        >
          Add
        </button>
      </header>
      <p className="hint">
        Where this part connects: the free points of a sketch, in its plane.
        Mated onto another part, the points are drilled there.
      </p>
      <ul className="stock-list">
        {interfaces.map((i) => (
          <li key={i.id}>
            <div className="part-main">
              <input
                aria-label="Interface name"
                value={i.name}
                onChange={(e) => set(i.id, { name: e.target.value })}
              />
              <button
                className="icon"
                aria-label={`Delete ${i.name}`}
                onClick={() =>
                  apply((d) => ({
                    ...d,
                    interfaces: (d.interfaces ?? []).filter(
                      (x) => x.id !== i.id,
                    ),
                  }))
                }
              >
                ×
              </button>
            </div>
            <div className="part-details">
              <select
                aria-label="Sketch"
                value={i.sketch}
                onChange={(e) => set(i.id, { sketch: e.target.value })}
              >
                {sketches.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Kind"
                value={i.kind}
                onChange={(e) =>
                  set(i.id, {
                    kind: e.target.value as PartInterfaceDefinition["kind"],
                  })
                }
              >
                <option value="screw">screws</option>
                <option value="dowel">dowels</option>
                <option value="point">points</option>
              </select>
              {i.kind !== "point" ? (
                <>
                  <input
                    aria-label="Hole diameter"
                    className="quantity"
                    value={i.diameter ?? ""}
                    placeholder="Ø"
                    onChange={(e) =>
                      set(i.id, { diameter: e.target.value || "3" })
                    }
                  />
                  <input
                    aria-label="Hole depth"
                    className="quantity"
                    value={i.depth ?? ""}
                    placeholder="depth"
                    onChange={(e) =>
                      set(i.id, { depth: e.target.value || "12" })
                    }
                  />
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
