import { useEffect, useState } from "react";

/**
 * Verkefnamappa-veljarinn: birtist fyrir fyrsta skeyti samtals þegar notandinn
 * er tengdur platforminum. Flæðið samþykkt í demoinu: flýtihnappar með möppum,
 * Ný mappa, og Sleppa fyrir verk sem þarf ekki að geyma.
 */

interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
}

interface Props {
  value: { id: string; name: string } | { skip: true } | null;
  onChange: (f: { id: string; name: string } | { skip: true } | null) => void;
  /** Aðeins sýnt þegar samtal er tómt og notandinn tengdur. */
  visible: boolean;
}

export function FolderPicker({ value, onChange, visible }: Props) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || folders !== null) return;
    chrome.runtime
      .sendMessage({ type: "folders/list" })
      .then((res: { ok?: boolean; folders?: Folder[] }) => {
        setFolders(res?.ok ? (res.folders ?? []) : []);
      })
      .catch(() => setFolders([]));
  }, [visible, folders]);

  if (!visible) return null;

  // Val komið: lítil kvittun með möguleika á að breyta.
  if (value) {
    return (
      <div className="eva-folder-picked">
        <span>
          {"skip" in value ? "Vistast ekki í möppu" : `📁 ${value.name}`}
        </span>
        <button type="button" className="eva-link" onClick={() => onChange(null)}>
          breyta
        </button>
      </div>
    );
  }

  const roots = (folders ?? []).filter((f) => f.parent_id === null).slice(0, 5);

  const createFolder = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "folders/create",
        name,
      })) as { ok?: boolean; folder?: Folder };
      if (res?.ok && res.folder) {
        onChange({ id: res.folder.id, name: res.folder.name });
      }
    } finally {
      setBusy(false);
      setCreating(false);
      setNewName("");
    }
  };

  return (
    <div className="eva-folder-picker">
      <div className="eva-folder-picker-label">Í hvaða möppu á verkið heima?</div>
      <div className="eva-folder-picker-chips">
        {folders === null ? (
          <span className="eva-folder-picker-loading">Sæki möppur…</span>
        ) : (
          <>
            {roots.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onChange({ id: f.id, name: f.name })}
              >
                📁 {f.name}
              </button>
            ))}
            {creating ? (
              <span className="eva-folder-picker-new">
                <input
                  autoFocus
                  value={newName}
                  placeholder="Nafn á möppu"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createFolder();
                    if (e.key === "Escape") setCreating(false);
                  }}
                />
                <button type="button" onClick={createFolder} disabled={busy || !newName.trim()}>
                  {busy ? "…" : "Búa til"}
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setCreating(true)}>
                + Ný mappa
              </button>
            )}
            <button type="button" className="skip" onClick={() => onChange({ skip: true })}>
              Sleppa
            </button>
          </>
        )}
      </div>
    </div>
  );
}
