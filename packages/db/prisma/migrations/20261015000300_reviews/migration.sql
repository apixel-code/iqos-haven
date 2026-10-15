-- Reviews and verified-purchase proof (roadmap step 93, ADR 0061; architecture §10).
-- A proof is a random token that staff send to the customer of a Delivered order. Only its
-- SHA-256 hash is stored. It lets the holder review the products of that order, nothing else:
-- an order ID alone proves nothing.
CREATE TABLE review_proofs (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  token_hash BYTEA NOT NULL,
  issued_by UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  issued_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  expires_at TIMESTAMPTZ(6) NOT NULL,
  revoked_at TIMESTAMPTZ(6),
  CONSTRAINT review_proofs_token UNIQUE (token_hash),
  CONSTRAINT review_proof_hash CHECK (octet_length(token_hash) = 32),
  CONSTRAINT review_proof_expiry CHECK (expires_at > issued_at),
  CONSTRAINT review_proof_revoked CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
-- One live link per order: issuing a new one revokes the previous one first.
CREATE UNIQUE INDEX review_proofs_live ON review_proofs (order_id) WHERE revoked_at IS NULL;
CREATE FUNCTION review_proofs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A review proof is never removed' USING ERRCODE='42501';
  END IF;
  -- Only revocation may change, and only once.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'A review proof only records being revoked, once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_proofs_guard BEFORE UPDATE OR DELETE ON review_proofs
  FOR EACH ROW EXECUTE FUNCTION review_proofs_guard();

-- A review is always verified at launch (BI-12: unverified reviews are not accepted), so the
-- proof and the order are required. Every review starts pending; only moderation changes it.
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  proof_id UUID NOT NULL REFERENCES review_proofs(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  rating SMALLINT NOT NULL,
  title VARCHAR(120) NOT NULL,
  body VARCHAR(2000) NOT NULL,
  author_name VARCHAR(60) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  moderated_by UUID REFERENCES staff_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  moderated_at TIMESTAMPTZ(6),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  -- One review per purchased product per order.
  CONSTRAINT reviews_one_per_purchase UNIQUE (order_id, product_id),
  CONSTRAINT review_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT review_text CHECK (btrim(title) <> '' AND btrim(body) <> '' AND btrim(author_name) <> ''),
  CONSTRAINT review_status CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT review_moderation CHECK (
    (status = 'pending') = (moderated_by IS NULL AND moderated_at IS NULL)),
  CONSTRAINT review_version CHECK (version >= 1)
);
CREATE INDEX reviews_moderation ON reviews (status, created_at, id);
CREATE INDEX reviews_product ON reviews (product_id, status);

-- The database refuses a review that its proof does not cover: the proof must belong to the
-- order, and the product must be one the order contains.
CREATE FUNCTION reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A review is never removed' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'A review starts pending' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM review_proofs p WHERE p.id = NEW.proof_id AND p.order_id = NEW.order_id)
       OR NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = NEW.order_id AND i.product_id = NEW.product_id) THEN
      RAISE EXCEPTION 'The proof does not cover this review' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Moderation changes the status, who and when, and the version; the content stays.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.proof_id IS DISTINCT FROM OLD.proof_id
     OR NEW.rating IS DISTINCT FROM OLD.rating OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.body IS DISTINCT FROM OLD.body OR NEW.author_name IS DISTINCT FROM OLD.author_name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Only moderation changes a review' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reviews_guard BEFORE INSERT OR UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_guard();
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ih_app') THEN
  REVOKE DELETE, TRUNCATE ON review_proofs, reviews FROM ih_app;
 END IF;
END;
$$;
