import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, PageHead } from "@/components/listing";
import { Money } from "@/components/money";
import { AR, EMIRATE_NAMES_AR, languageAlternates } from "@/lib/ar";
import { servedEmirates } from "@/lib/emirates";
import { SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";

export const metadata: Metadata = {
  title: `توصيل إيكوس وتيريا في الإمارات · ${SITE.name}`,
  description: "الإمارات التي نوصل إليها أجهزة IQOS ILUMA وأعواد TEREA، والدفع نقداً عند الاستلام.",
  alternates: languageAlternates("/ar/delivery", "ar"),
};

/** Arabic delivery by emirate (ADRs 0118, 0120): the emirates served, from the delivery settings. */
export default async function ArabicDeliveryPage() {
  const delivery = await storeRead((api, shopper) => api.delivery(shopper));
  const served = servedEmirates(delivery);
  return (
    <div lang="ar" dir="rtl">
      <Breadcrumbs trail={[{ label: AR.home, href: "/ar" }, { label: AR.delivery }]} />
      <PageHead title={AR.delivery} lead={AR.deliveryLead} />
      <div className="prose">
        {delivery.feeFils !== null && (
          <p>
            رسوم التوصيل <Money fils={delivery.feeFils} /> للطلب الواحد، وهي نفسها في جميع الإمارات
            {delivery.freeThresholdFils !== null && (
              <>
                ، والتوصيل مجاني عندما تبلغ قيمة المنتجات{" "}
                <Money fils={delivery.freeThresholdFils} /> أو أكثر بعد الخصم
              </>
            )}
            .
          </p>
        )}
        {served.length === 0 ? (
          <p>يجري إعداد مناطق التوصيل. راسلنا على واتساب لتسأل عن منطقتك.</p>
        ) : (
          <ul>
            {served.map((place) => (
              <li key={place.slug}>
                <Link href={`/ar/delivery/${place.slug}`} prefetch={false} className="underline">
                  التوصيل في {EMIRATE_NAMES_AR[place.emirate]}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p>{AR.adults}</p>
      </div>
    </div>
  );
}
