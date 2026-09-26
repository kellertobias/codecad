// Signing in, when the server has accounts: a passkey per device, no
// passwords. And sharing a project with a view link.
import { useEffect, useRef, useState } from "react";
import { account, viewLinks, type AccountState, type ViewLink } from "./api.ts";
import { ToolButton } from "./controls.tsx";
import { Icon } from "./icons.tsx";

export function useAccount() {
  const [state, setState] = useState<AccountState>();
  useEffect(() => {
    account.me().then(setState, () => setState({ accounts: false }));
  }, []);
  return state;
}

export function SignIn() {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await work();
      location.reload();
    } catch (error) {
      setProblem(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "The passkey was not used."
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      setBusy(false);
    }
  };
  const supported = typeof PublicKeyCredential !== "undefined";
  return (
    <main className="sign-in">
      <h1>CodeCAD</h1>
      {!supported ? (
        <p className="error">
          This browser cannot use passkeys here. Passkeys need HTTPS (or
          localhost).
        </p>
      ) : null}
      <section>
        <h2>Sign in</h2>
        <button
          className="primary"
          disabled={busy || !supported}
          onClick={() => void act(() => account.login())}
        >
          <Icon name="key" size={16} /> Sign in with a passkey
        </button>
      </section>
      <section>
        <h2>New here?</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => account.register(name));
          }}
        >
          <input
            aria-label="Your name"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button disabled={busy || !supported || !name.trim()}>
            Create an account
          </button>
        </form>
        <p className="hint">
          Your device keeps a passkey for this site; there is no password.
        </p>
      </section>
      {problem ? <p className="error">{problem}</p> : null}
    </main>
  );
}

export function AccountMenu({ name }: { name: string }) {
  return (
    <span className="account">
      <span className="account-name" title="Signed in">
        {name}
      </span>
      <ToolButton
        icon="key"
        label="Add a passkey for another device"
        onClick={() =>
          void account.register().then(
            () => alert("Passkey added."),
            (error: unknown) =>
              alert(error instanceof Error ? error.message : String(error)),
          )
        }
      />
      <ToolButton
        icon="signout"
        label="Sign out"
        onClick={() => void account.logout().then(() => location.reload())}
      />
    </span>
  );
}

export function ShareDialog({
  project,
  close,
}: {
  project: string;
  close(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [links, setLinks] = useState<ViewLink[]>([]);
  const [problem, setProblem] = useState<string>();
  const refresh = () =>
    viewLinks
      .list(project)
      .then(setLinks, (e: unknown) => setProblem(String(e)));
  useEffect(() => {
    dialog.current?.showModal();
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const full = (link: ViewLink) => `${location.origin}${link.path}`;
  return (
    <dialog ref={dialog} className="share-dialog" onClose={close}>
      <header>
        <h2>View links</h2>
        <ToolButton
          icon="close"
          label="Close"
          onClick={() => dialog.current?.close()}
        />
      </header>
      <p className="hint">
        Anyone with a link sees this project's saved drawings, cut list, layouts
        and model on the phone viewer, without an account. They cannot change
        anything.
      </p>
      <ul className="share-links">
        {links.map((link) => (
          <li key={link.token}>
            <input readOnly value={full(link)} aria-label="View link" />
            <ToolButton
              icon="copy"
              label="Copy the link"
              onClick={() => void navigator.clipboard?.writeText(full(link))}
            />
            <ToolButton
              icon="trash"
              label="Revoke the link"
              className="danger"
              onClick={() => void viewLinks.revoke(link.token).then(refresh)}
            />
          </li>
        ))}
      </ul>
      <button
        className="primary"
        onClick={() =>
          void viewLinks
            .create(project)
            .then(refresh, (e: unknown) =>
              setProblem(e instanceof Error ? e.message : String(e)),
            )
        }
      >
        <Icon name="plus" size={16} /> New view link
      </button>
      {problem ? <p className="error">{problem}</p> : null}
    </dialog>
  );
}
