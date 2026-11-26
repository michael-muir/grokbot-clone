// Settings building blocks: a section card, a labelled row, an on/off switch, and a select. The select is the
// native element, styled like the reference's trigger, so keyboards and screen readers get the platform's own.
import { type ReactNode, useId } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id} className="settings-section-title">
        {title}
      </h3>
      <div className="settings-card">{children}</div>
    </section>
  );
}

/** One line of a card: label (and an optional description) on the left, the control on the right. */
export function Row({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: ReactNode;
  /** The control's id, so clicking the label focuses it. */
  htmlFor?: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        {htmlFor ? (
          <label className="settings-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="settings-label">{label}</span>
        )}
        {description && <span className="settings-description">{description}</span>}
      </div>
      {children && <div className="settings-control">{children}</div>}
    </div>
  );
}

export function Switch({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}

export function Select<T extends string>({
  id,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange(next: T): void;
}) {
  return (
    <span className="select">
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <svg className="select-chevron" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 6.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}
