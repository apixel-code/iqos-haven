import { EmptyState } from "@/components/listing";

export default function ShopNotFound() {
  return (
    <div className="pt-16">
      <EmptyState
        title="We couldn't find that page"
        body="It may have been renamed or is no longer available."
        action={{ href: "/shop", label: "Browse all products" }}
      />
    </div>
  );
}
