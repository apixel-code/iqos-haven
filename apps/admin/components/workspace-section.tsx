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
import { sections } from "../lib/navigation";
export function WorkspaceSection({ sectionKey }: { sectionKey: string }) {
  const session = useSession();
  const section = sections.find((item) => item.key === sectionKey);
  if (!session) return null;
  if (!section || !session.permissions.includes(section.permission))
    return (
      <main className="page-content">
        <h1>Access unavailable</h1>
        <p className="muted">You do not have access to this workspace.</p>
        <Link href="/">Back to workspace</Link>
      </main>
    );
  return (
    <main className="page-content">
      <p className="eyebrow">{section.group}</p>
      <h1>{section.label}</h1>
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
      ) : sectionKey === "customers" ? (
        <CustomerManagement />
      ) : sectionKey === "content" ? (
        <ContentManagement />
      ) : sectionKey === "reviews" ? (
        <ReviewManagement canOpenOrders={session.permissions.includes("orders.read")} />
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
