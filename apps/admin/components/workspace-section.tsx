"use client";
import Link from "next/link";
import { useSession } from "./session-shell";
import { SettingsManagement } from "./settings-management";
import { DeliveryManagement } from "./delivery-management";
import { CouponManagement } from "./coupon-management";
import { StaffManagement } from "./staff-management";
import { CatalogueParentManagement } from "./catalogue-parent-management";
import { ProductManagement } from "./product-management";
import { InventoryManagement } from "./inventory-management";
import { CustomerManagement } from "./customer-management";
import { ReviewManagement } from "./review-management";
import { ContentManagement } from "./content-management";
import { OrderManagement } from "./order-management";
import { AnalyticsManagement } from "./analytics-management";
import { ReportManagement } from "./report-management";
import { SeoManagement } from "./seo-management";
import { NotificationInbox } from "./notification-inbox";
import { sections } from "../lib/navigation";
import { Icon } from "./icons";
import { PageHead } from "./page-head";
/** Screens that draw the prototype's page head themselves. */
const OWN_HEAD = new Set([
  "orders",
  "products",
  "inventory",
  "brands",
  "categories",
  "customers",
  "reviews",
  "discounts",
  "analytics",
  "reports",
  "content",
  "seo",
]);

export function WorkspaceSection({ sectionKey }: { sectionKey: string }) {
  const session = useSession();
  const section = sections.find((item) => item.key === sectionKey);
  if (!session) return null;
  if (!section || !session.permissions.includes(section.permission))
    return (
      <main className="page-content">
        <div className="card lockcard">
          <div className="dlg-ic">
            <Icon name="lock" size="lg" />
          </div>
          <h2>Access unavailable</h2>
          <p className="muted">
            Your account cannot open this page. Ask the Owner if you need it for your work.
          </p>
          <div className="row">
            <Link href="/" className="btn btn-p">
              Go to dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  return (
    <main className="page-content">
      {/* Rebuilt screens draw their own head (counts and actions, as in the prototype). */}
      {!OWN_HEAD.has(sectionKey) && (
        <PageHead title={section.label} {...("sub" in section ? { sub: section.sub } : {})} />
      )}
      {sectionKey === "orders" ? (
        <OrderManagement
          canReadContact={session.permissions.includes("customers.read")}
          canTransition={session.permissions.includes("orders.transition")}
          canEdit={session.permissions.includes("orders.edit")}
          canCancel={session.permissions.includes("orders.cancel_before_dispatch")}
          canReturn={session.permissions.includes("orders.cancel_after_dispatch")}
          canCollect={session.permissions.includes("orders.collect")}
          canCorrect={session.permissions.includes("orders.collection_correct")}
          canCreate={session.permissions.includes("orders.create")}
        />
      ) : sectionKey === "notifications" ? (
        <NotificationInbox />
      ) : sectionKey === "seo" ? (
        <SeoManagement canReport={session.permissions.includes("seo.reports")} />
      ) : sectionKey === "reports" ? (
        <ReportManagement
          canExport={session.permissions.includes("reports.export")}
          canExportCustomers={session.permissions.includes("customers.export")}
        />
      ) : sectionKey === "analytics" ? (
        <AnalyticsManagement />
      ) : sectionKey === "customers" ? (
        <CustomerManagement permissions={session.permissions} />
      ) : sectionKey === "content" ? (
        <ContentManagement />
      ) : sectionKey === "reviews" ? (
        <ReviewManagement
          canOpenOrders={session.permissions.includes("orders.read")}
          canOpenProducts={session.permissions.includes("catalog.read")}
        />
      ) : sectionKey === "settings" ? (
        <SettingsManagement />
      ) : sectionKey === "delivery" ? (
        <DeliveryManagement />
      ) : sectionKey === "discounts" ? (
        <CouponManagement />
      ) : sectionKey === "staff" ? (
        <StaffManagement />
      ) : sectionKey === "inventory" ? (
        <InventoryManagement permissions={session.permissions} />
      ) : sectionKey === "products" ? (
        <ProductManagement permissions={session.permissions} />
      ) : sectionKey === "brands" ? (
        <CatalogueParentManagement kind="brand" permissions={session.permissions} />
      ) : sectionKey === "categories" ? (
        <CatalogueParentManagement kind="category" permissions={session.permissions} />
      ) : (
        <section className="empty-panel">
          <h2>This workspace is being prepared</h2>
          <p className="muted">There is no activity to display here yet.</p>
          <Link href="/">Back to workspace</Link>
        </section>
      )}
    </main>
  );
}
