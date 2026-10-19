import type { ReactNode } from "react";

/** The admin prototype's page head (`pageHead`): title, optional line under it and actions. */
export function PageHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="ph">
      <div className="ph-t">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="ph-a">{actions}</div>}
    </div>
  );
}
