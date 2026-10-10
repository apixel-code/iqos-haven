# কোথা থেকে শুরু করবেন

এই ZIP-এ আপনার দেওয়া final architecture হুবহু `docs/architecture.md`-তে আছে। ১৩২ ধাপের roadmap, দুটো UI prototype, design tokens, requirements, acceptance scenarios, database contract, runbooks ও সংশোধিত code foundation একসঙ্গে রাখা হয়েছে।

প্রথমে `README.md` অনুযায়ী setup করুন। তারপর `docs/implementation-status.md` দেখুন। সেখানে তৈরি হওয়া foundation ও বাকি business feature আলাদা করে লেখা আছে। `docs/business-inputs.md`-এর client decision-গুলো এখনও pending; এই audit থেকে কোনো সিদ্ধান্ত অনুমান করে approved করা হয়নি।

বর্তমান implementation step 35 পর্যন্ত: audit/outbox/worker, private storage/service auth, identity schema, Owner bootstrap, gateway, backend login/session/permissions, Origin/CSRF/rate limits ও password reset/staff invitations ও versioned staff administration। M2 gate approved; M0 review এবং M1 staging/fixtures এখনও open। সর্বশেষ branch, verification ও পরের কাজ `PROGRESS.md` থেকে নিন। পরের feature step 36 shared last-Owner guard ও fixed-role/reactivation administration; admin login/reset UI step 37-এ।

এটি production implementation-এর সংশোধিত starting kit। Frontend authentication/reset pages, inventory tables, checkout, COD collection, production deployment ও recovery drill এখনো সম্পন্ন হয়নি। `docs/verification.md`-তে কোন checks চালানো গেছে এবং কোনগুলো infrastructure ছাড়া চালানো যায়নি—সেটা পাবেন।
