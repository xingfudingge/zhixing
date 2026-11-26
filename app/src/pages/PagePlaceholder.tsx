import { useId, type ReactNode } from 'react';

import { SparkIcon } from '../app/shell/icons';

type EmptyStateProps = {
  pending: string;
  features?: readonly string[];
  icon?: ReactNode;
  workspace?: boolean;
};

function EmptyState({ pending, features, icon, workspace }: EmptyStateProps) {
  return (
    <div className={workspace ? 'empty-card empty-card--workspace' : 'empty-card'}>
      <span className="empty-icon" aria-hidden="true">
        {icon ?? <SparkIcon />}
      </span>
      <h2>后续卡实现</h2>
      <p>{pending}</p>
      {features && features.length > 0 ? (
        <ul className="empty-chips" aria-label="后续交付范围">
          {features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type PagePlaceholderProps = {
  eyebrow: string;
  title: string;
  description: string;
  pending: string;
  features?: readonly string[];
  icon?: ReactNode;
};

export function PagePlaceholder({
  eyebrow,
  title,
  description,
  pending,
  features,
  icon,
}: PagePlaceholderProps) {
  const titleId = useId();

  return (
    <section className="page" aria-labelledby={titleId}>
      <div className="page-header">
        <p className="page-eyebrow">{eyebrow}</p>
        <h1 id={titleId}>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      <EmptyState pending={pending} features={features} icon={icon} />
    </section>
  );
}

export type WorkspacePlaceholderProps = {
  eyebrow: string;
  title: string;
  pending: string;
  features?: readonly string[];
  variant: 'knowledge' | 'board';
  icon: ReactNode;
};

export function WorkspacePlaceholder({
  eyebrow,
  title,
  pending,
  features,
  variant,
  icon,
}: WorkspacePlaceholderProps) {
  const titleId = useId();

  return (
    <section
      className={`workspace-page workspace-page--${variant}`}
      aria-labelledby={titleId}
    >
      <div className="workspace-head">
        <div className="workspace-head-main">
          <p className="workspace-eyebrow">{eyebrow}</p>
          <h1 id={titleId}>{title}</h1>
        </div>
        <span className="workspace-meta">全高工作区 · 顶栏隐藏</span>
      </div>
      <div
        className={
          variant === 'board'
            ? 'workspace-canvas workspace-canvas--grid'
            : 'workspace-canvas'
        }
      >
        <EmptyState
          pending={pending}
          features={features}
          icon={icon}
          workspace
        />
      </div>
    </section>
  );
}
