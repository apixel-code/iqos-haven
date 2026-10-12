-- BI-03 answered 2026-10-12: delivery covers all seven emirates, still at one flat fee.
-- Existing rows are all 'dubai', so widening the check is backwards compatible.
ALTER TABLE delivery_areas DROP CONSTRAINT delivery_area_emirate;
ALTER TABLE delivery_areas ADD CONSTRAINT delivery_area_emirate CHECK (
  emirate IN ('abu_dhabi','dubai','sharjah','ajman','umm_al_quwain','ras_al_khaimah','fujairah')
);
