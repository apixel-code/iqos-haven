# কোথা থেকে শুরু করবেন

এই ZIP-এ আপনার দেওয়া final architecture হুবহু `docs/architecture.md`-তে আছে। ১৩২ ধাপের roadmap, দুটো UI prototype, design tokens, requirements, acceptance scenarios, database contract, runbooks ও সংশোধিত code foundation একসঙ্গে রাখা হয়েছে।

প্রথমে `README.md` অনুযায়ী setup করুন। তারপর `docs/implementation-status.md` দেখুন। সেখানে তৈরি হওয়া foundation ও বাকি business feature আলাদা করে লেখা আছে। `docs/business-inputs.md`-এর client decision-গুলো এখনও pending; এই audit থেকে কোনো সিদ্ধান্ত অনুমান করে approved করা হয়নি।

পরের কাজ: UI states/assets ও business rules review করে Milestone 0 gate বন্ধ করা; এরপর Milestone 1-এর অসমাপ্ত components, fixtures ও staging skeleton শেষ করা। তারপর roadmap-এর নির্ভরতা অনুযায়ী audit/outbox, identity, catalogue, age gate, pricing, transactional checkout ও order operations implement করুন।

এটি production implementation-এর সংশোধিত starting kit। Authentication, inventory tables, checkout, COD collection, production deployment ও recovery drill এখনো সম্পন্ন হয়নি। `docs/verification.md`-তে কোন checks চালানো গেছে এবং কোনগুলো infrastructure ছাড়া চালানো যায়নি—সেটা পাবেন।
