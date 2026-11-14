import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/listing";
import { Money } from "@/components/money";
import { AR, EMIRATE_NAMES_AR, languageAlternates } from "@/lib/ar";
import { emirateOfSlug, servedEmirates } from "@/lib/emirates";
import { SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";

type Props = { params: Promise<{ emirate: string }> };

async function placeOf(slug: string) {
  const emirate = emirateOfSlug(slug);
  if (!emirate) return null;
  const delivery = await storeRead((api, shopper) => api.delivery(shopper));
  const place = servedEmirates(delivery).find((item) => item.emirate === emirate);
  return place ? { place, delivery, name: EMIRATE_NAMES_AR[emirate] } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await placeOf((await params).emirate);
  if (!found) return { title: SITE.name };
  return {
    title: `توصيل إيكوس إيلوما وتيريا في ${found.name} · ${SITE.name}`,
    description: `اطلب أجهزة IQOS ILUMA وأعواد TEREA مع التوصيل في ${found.name} والدفع نقداً عند الاستلام. ${AR.adults}`,
    alternates: languageAlternates(`/ar/delivery/${found.place.slug}`, "ar"),
  };
}

/** Arabic delivery in one emirate (ADRs 0118, 0120). Fee, time and areas from the settings. */
export default async function ArabicEmirateDeliveryPage({ params }: Props) {
  const found = await placeOf((await params).emirate);
  if (!found) notFound();
  const { place, delivery, name } = found;
  return (
    <div lang="ar" dir="rtl">
      <Breadcrumbs
        trail={[
          { label: AR.home, href: "/ar" },
          { label: AR.delivery, href: "/ar/delivery" },
          { label: name },
        ]}
      />
      <header className="shop-head">
        <h1 className="h1">توصيل إيكوس إيلوما وتيريا في {name}</h1>
        <p className="muted">اطلب عبر الإنترنت وادفع نقداً عند الاستلام. {AR.adults}</p>
      </header>
      <div className="prose">
        <h2 className="h2">الرسوم ومدة التوصيل</h2>
        {delivery.feeFils !== null ? (
          <p>
            التوصيل إلى {name} بسعر <Money fils={delivery.feeFils} /> للطلب الواحد
            {delivery.freeThresholdFils !== null && (
              <>
                ، ومجاني عندما تبلغ قيمة المنتجات <Money fils={delivery.freeThresholdFils} /> أو
                أكثر بعد الخصم
              </>
            )}
            . ترى الرسوم والمجموع قبل تأكيد الطلب.
          </p>
        ) : (
          <p>ترى رسوم التوصيل والمجموع قبل تأكيد الطلب.</p>
        )}
        {delivery.etaText && (
          <p lang="en" dir="ltr">
            {delivery.etaText}
          </p>
        )}
        <h2 className="h2">المناطق التي نوصل إليها في {name}</h2>
        <ul className="sm:columns-2" lang="en" dir="ltr">
          {place.areas.map((area) => (
            <li key={area}>{area}</li>
          ))}
        </ul>
        <p>
          اختر منطقتك عند إتمام الطلب. منطقتك غير موجودة؟ راسلنا على واتساب من{" "}
          <Link href="/help#help-contact" prefetch={false} className="underline">
            صفحة المساعدة
          </Link>
          .
        </p>
        <h2 className="h2">ماذا يمكنك أن تطلب</h2>
        <ul>
          <li>
            <Link href="/ar/devices" prefetch={false} className="underline">
              {AR.devices}
            </Link>
            : جميع الموديلات والألوان.
          </li>
          <li>
            <Link href="/ar/sticks" prefetch={false} className="underline">
              {AR.sticks}
            </Link>
            : سبع إصدارات، تُباع بالكرتونة.
          </li>
        </ul>
        <h2 className="h2">الدفع</h2>
        <p>
          ادفع نقداً لمندوب التوصيل عند وصول طلبك، أو اختر التحويل البنكي أو الدفع الإلكتروني عند
          إتمام الطلب وسنرسل لك التفاصيل على واتساب.
        </p>
      </div>
    </div>
  );
}
