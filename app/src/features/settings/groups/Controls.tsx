import { useId, type ReactNode } from 'react';

export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="settings-card" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      {description ? <p className="settings-desc">{description}</p> : null}
      {children}
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  disabled = false,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? 'settings-row is-disabled' : 'settings-row'}>
      <div className="settings-row-main">
        <span className="settings-row-label">{label}</span>
        {description ? (
          <span className="settings-row-desc">{description}</span>
        ) : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function ComingSoonRow({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <div className="settings-row is-disabled">
      <div className="settings-row-main">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-desc">{description}</span>
      </div>
      <span className="settings-badge">即将支持</span>
    </div>
  );
}

export function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="settings-segmented-button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsSwitch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={checked ? 'settings-switch is-on' : 'settings-switch'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function SelectField({
  label,
  value,
  onChange,
  disabled = false,
  children,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="settings-select-wrap">
      <select
        id={id}
        className="settings-select"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      {hint ? <small className="settings-hint">{hint}</small> : null}
    </div>
  );
}
