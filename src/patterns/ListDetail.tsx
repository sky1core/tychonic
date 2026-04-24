import type { ReactNode } from "react";

export function ListDetailLayout({
  list,
  detail
}: {
  list: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className="workspace">
      <aside className="rail">{list}</aside>
      <main className="detail">{detail}</main>
    </div>
  );
}

export function ListRow({
  icon,
  title,
  subtitle,
  accessory,
  active,
  onClick
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  accessory?: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={active ? "run-row active" : "run-row"}
      type="button"
    >
      {icon ? <span>{icon}</span> : null}
      <div>
        <span>{title}</span>
        {subtitle ? <small>{subtitle}</small> : null}
      </div>
      {accessory ? <small>{accessory}</small> : null}
    </button>
  );
}
