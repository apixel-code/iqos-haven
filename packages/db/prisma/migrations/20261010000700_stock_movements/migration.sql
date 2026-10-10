-- Stock ledger (roadmap step 46, ADR 0017). Inserting a movement is the only way to change a
-- variant's stock. The writer computes balance_after under the variant row lock; an AFTER INSERT
-- trigger applies the delta to the variant and verifies the resulting balance, so ledger and
-- balance commit together or not at all. AFTER (not BEFORE) so a row skipped by ON CONFLICT never
-- touches stock. The variant CHECK (0 ≤ stock ≤ 100,000,000) refuses impossible balances.
ALTER TABLE variants ADD CONSTRAINT variants_stock_max CHECK (stock_on_hand<=100000000);
CREATE TABLE stock_movements (
 id UUID PRIMARY KEY DEFAULT uuidv7(),
 variant_id UUID NOT NULL REFERENCES variants(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 delta INTEGER NOT NULL CHECK (delta<>0 AND delta BETWEEN -1000000 AND 1000000),
 balance_after INTEGER NOT NULL CHECK (balance_after>=0),
 -- Order reasons (sale, release, return) are added with the order steps (73+).
 reason VARCHAR(24) NOT NULL CHECK (reason IN ('INITIAL_STOCK','RESTOCK','MANUAL','DAMAGE')),
 note VARCHAR(500) CHECK (note IS NULL OR (note=btrim(note) AND length(note)>0)),
 command_id VARCHAR(128) NOT NULL CHECK (length(command_id)>0),
 effect VARCHAR(32) NOT NULL DEFAULT 'adjust' CHECK (effect ~ '^[a-z][a-z0-9_]{0,31}$'),
 actor_id UUID REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
 UNIQUE (command_id, variant_id, effect),
 CHECK (reason<>'INITIAL_STOCK' OR delta>0),
 CHECK (reason<>'RESTOCK' OR delta>0),
 CHECK (reason<>'DAMAGE' OR (delta<0 AND note IS NOT NULL)),
 CHECK (reason<>'MANUAL' OR note IS NOT NULL)
);
-- INITIAL_STOCK happens at most once per variant, as its first movement (checked in the trigger).
CREATE UNIQUE INDEX stock_movements_one_initial ON stock_movements(variant_id) WHERE reason='INITIAL_STOCK';
CREATE INDEX stock_movements_variant ON stock_movements(variant_id, created_at, id);

CREATE FUNCTION stock_movements_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance INTEGER;
BEGIN
 -- Lock and update first, then check, so concurrent writers serialize on the variant row.
 UPDATE variants SET stock_on_hand=stock_on_hand+NEW.delta WHERE id=NEW.variant_id
  RETURNING stock_on_hand INTO balance;
 IF balance IS NULL THEN
  RAISE EXCEPTION 'Unknown variant' USING ERRCODE='23503';
 END IF;
 IF balance<>NEW.balance_after THEN
  RAISE EXCEPTION 'Stock movement balance does not match the variant' USING ERRCODE='IH002';
 END IF;
 IF NEW.reason='INITIAL_STOCK' AND EXISTS (
   SELECT 1 FROM stock_movements WHERE variant_id=NEW.variant_id AND id<>NEW.id) THEN
  RAISE EXCEPTION 'Initial stock must be the first movement' USING ERRCODE='IH001';
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements
 FOR EACH ROW EXECUTE FUNCTION stock_movements_apply();

-- Variant stock may change only from inside the ledger trigger (nested trigger depth), never by a
-- direct UPDATE, whatever session settings a caller sets. Replaces the step-41 flag guard.
-- Invariant for future migrations: no other trigger may update variants.stock_on_hand.
CREATE OR REPLACE FUNCTION variants_stock_ledger_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.stock_on_hand<>0 THEN
   RAISE EXCEPTION 'Variant stock starts at zero; use the stock ledger' USING ERRCODE='42501';
  END IF;
 ELSIF NEW.stock_on_hand IS DISTINCT FROM OLD.stock_on_hand AND pg_trigger_depth()<2 THEN
  RAISE EXCEPTION 'Variant stock changes only through the stock ledger' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;

-- Append-only ledger.
CREATE FUNCTION stock_movements_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'stock_movements is append-only' USING ERRCODE='insufficient_privilege';
END;
$$;
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
 FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
 FOR EACH STATEMENT EXECUTE FUNCTION stock_movements_append_only();
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE UPDATE, DELETE, TRUNCATE ON stock_movements FROM ih_app;
 END IF;
END;
$$;
