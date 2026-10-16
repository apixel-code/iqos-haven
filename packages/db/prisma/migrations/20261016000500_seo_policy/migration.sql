-- SEO indexing policy (roadmap step 113, ADR 0079). One more settings key, written only by the
-- Owner's SEO command (`seo.write`), never by the general Settings screen. Absent = closed.
ALTER TABLE settings DROP CONSTRAINT settings_key;
ALTER TABLE settings ADD CONSTRAINT settings_key
  CHECK (key IN ('store','contact','notifications','whatsapp','delivery','seo'));
