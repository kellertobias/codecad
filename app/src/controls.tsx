// Toolbar buttons that show an icon, with what they do and their key in
// the tooltip, and the overview of every shortcut.
import { useEffect, useRef } from "react";
import { Icon, type IconName } from "./icons.tsx";
import {
  keyLabel,
  shortcuts,
  tip,
  type ShortcutGroup,
  type ShortcutId,
} from "./shortcuts.ts";

export function ToolButton({
  icon,
  label,
  shortcut,
  active,
  disabled,
  className,
  onClick,
}: {
  icon: IconName;
  label: string;
  shortcut?: ShortcutId | undefined;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={["tool", active ? "active" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      title={shortcut ? tip(shortcut, label) : label}
      aria-label={label}
      {...(active !== undefined ? { "aria-pressed": active } : {})}
      {...(shortcut
        ? {
            "aria-keyshortcuts": shortcuts[shortcut].keys
              .map((k) =>
                [
                  ...(k.mod ? ["Control"] : []),
                  ...(k.alt ? ["Alt"] : []),
                  ...(k.shift === true ? ["Shift"] : []),
                  k.key.length === 1 ? k.key.toUpperCase() : k.key,
                ].join("+"),
              )
              .join(" "),
          }
        : {})}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

const groups: readonly ShortcutGroup[] = [
  "General",
  "Model",
  "View",
  "Sketch",
  "Sketch constraints",
  "Layouts",
];

export function ShortcutHelp({ close }: { close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="shortcut-help"
      aria-label="Keyboard shortcuts"
      onClose={close}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <header>
        <h2>Keyboard shortcuts</h2>
        <ToolButton
          icon="close"
          label="Close"
          onClick={() => dialog.current?.close()}
        />
      </header>
      <div className="shortcut-groups">
        {groups.map((group) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {Object.values(shortcuts)
                .filter((s) => s.group === group)
                .map((s) => (
                  <div key={s.label}>
                    <dt>
                      {s.keys.map((k, i) => (
                        <kbd key={i}>{keyLabel(k)}</kbd>
                      ))}
                    </dt>
                    <dd>{s.label}</dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="hint">
        Single keys work while no field has the focus. In a sketch, the
        constraint keys apply what the selection allows.
      </p>
    </dialog>
  );
}
