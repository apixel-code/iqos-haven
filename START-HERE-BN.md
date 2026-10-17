# কোথা থেকে শুরু করবেন

এই ZIP-এ আপনার দেওয়া final architecture হুবহু `docs/architecture.md`-তে আছে। ১৩২ ধাপের roadmap, দুটো UI prototype, design tokens, requirements, acceptance scenarios, database contract, runbooks ও সংশোধিত code foundation একসঙ্গে রাখা হয়েছে।

প্রথমে `README.md` অনুযায়ী setup করুন। তারপর `docs/implementation-status.md` দেখুন। সেখানে তৈরি হওয়া foundation ও বাকি business feature আলাদা করে লেখা আছে। Client decisions ও কোন input এখনও বাকি আছে তা `docs/business-inputs.md` থেকে নিন।

বর্তমান implementation step 83 পর্যন্ত: admin auth/settings/catalogue/stock/media/coupons ও read-only order operations, age-gated storefront browsing/search/cart/checkout/private confirmation, server quote, atomic order creation এবং order notifications তৈরি হয়েছে। পরের কাজ step 84: versioned order status transition commands ও timeline। Checkout submission default-এ বন্ধ থাকে।

M2 ও M5 approved; অন্য milestone gates-এর বর্তমান অবস্থা `PROGRESS.md`-তে আছে। Business decisions `docs/business-inputs.md` ও ADR 0036-তে দেখুন: admin-entered price final, tax calculation নেই, UAE-এর সাত emirate-এ এক flat fee। Real contact/WhatsApp copy, email sender verification ও final indexing decision বাকি।

এখনও production-ready নয়। Order operations/COD, notification inbox, reviews/CMS, analytics/reports, final QA, deployment ও recovery drills বাকি। কোন checks সত্যি পাস করেছে এবং কী পরীক্ষা হয়নি তা `docs/verification.md`-তে দেখুন।
