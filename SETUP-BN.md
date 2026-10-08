# Setup ও দৈনিক কাজ

1. Node 24 ও pnpm 10.28.0 install করুন; Docker Desktop বা Docker Engine + Compose v2 চালু রাখুন।
2. ZIP extract করে `iqos-haven` folder খুলুন। Git history নেই; নতুন repository হলে `git init` করুন।
3. `pnpm install --frozen-lockfile`, `cp .env.example .env`, `pnpm infra:up`, `pnpm build`, তারপর `pnpm dev` চালান।
4. API readiness: http://localhost:4000/v1/health/ready। প্রথম boot-এ PostgreSQL init এবং MinIO bucket creation শেষ হওয়ার জন্য অপেক্ষা করুন। `.env.example`-এর passwords শুধু local development-এর জন্য।
5. আর্কিটেকচার আগে থেকেই `docs/architecture.md`-তে আছে। `docs/README.md` ও `PROGRESS.md` পড়ে পরবর্তী অসমাপ্ত কাজ নিন।

Claude Code ব্যবহার করলে `/start` → `/step N` → `/verify` → `/handoff` workflow ব্যবহার করা যায়। প্রতিটি step-এর acceptance ও architectural invariant পরীক্ষা করে তারপর complete চিহ্ন দিন। Production access বা external messaging স্বয়ংক্রিয়ভাবে অনুমোদিত নয়।

Full checks `README.md`-তে আছে। Integration tests বাস্তব PostgreSQL/Redis ছাড়া চালানো যাবে না। Empty schema অবস্থায় migration command default fail করবে; শুধু development-এ explicit `pnpm db:migrate -- --allow-empty` ব্যবহারযোগ্য। `db:generate` client তৈরি করে; migration তৈরি করতে `db:migration:create` ব্যবহার করুন।

Client inputs এলে `docs/business-inputs.md`-এ evidence ও answer লিখুন। VAT/excise, age/preview policy, catalogue/assets ও hosting profile-এর সিদ্ধান্ত ছাড়া সংশ্লিষ্ট feature বা release gate approved করবেন না।
