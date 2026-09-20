import { observer } from "mobx-react-lite";
import { useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";

import { useStore } from "../store";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      className={mono ? "input mono" : "input"}
      value={value}
      placeholder={placeholder}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  return (
    <input
      className="input"
      type="number"
      value={value}
      min={min}
      onChange={(event) => {
        const parsed = Number.parseInt(event.target.value, 10);
        onChange(Number.isFinite(parsed) ? parsed : 0);
      }}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {hint ? <em>{hint}</em> : null}
      </span>
    </label>
  );
}

/** Comma- or newline-separated unit names, which is how they are read out of def files. */
export function UnitList({
  units,
  onChange,
  placeholder,
}: {
  units: string[];
  onChange: (units: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(units.join(", "));
  return (
    <textarea
      className="input mono"
      rows={2}
      value={text}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onBlur={() =>
        onChange(
          text
            .split(/[,\n]/)
            .map((unit) => unit.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/** Drop target that hands whole `File`s to the caller. */
export const Dropzone = observer(function Dropzone({
  accept,
  label,
  onFiles,
  busy,
  children,
}: {
  accept: string;
  label: string;
  onFiles: (files: File[]) => void;
  busy?: boolean;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    onFiles([...event.dataTransfer.files]);
  };

  return (
    <div
      className={`dropzone${over ? " over" : ""}${busy ? " busy" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      {children ?? <span>{busy ? "Uploading…" : label}</span>}
    </div>
  );
});

export const Notices = observer(function Notices() {
  const store = useStore();
  if (store.notices.length === 0) return null;
  return (
    <div className="notices">
      {store.notices.map((notice) => (
        <div key={notice.id} className={`notice ${notice.kind}`}>
          <span>{notice.message}</span>
          <button onClick={() => store.dismiss(notice.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
});
