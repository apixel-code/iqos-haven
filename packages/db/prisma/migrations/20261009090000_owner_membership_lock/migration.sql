-- Common identity guard enforced by the database (architecture §11). Any insert or update that
-- touches Owner membership or activation takes the seeded owner-role row lock first, so every
-- path — bootstrap, invites, role changes, reactivation, bulk/operational tooling — is
-- serialized with the last-Owner and one-time-bootstrap checks, even if application code
-- forgets to call lockOwnerRole(). The runtime role may lock this row via its column grant.
CREATE FUNCTION "staff_users_owner_lock"() RETURNS trigger
  LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  owner_role uuid;
BEGIN
  SELECT "id" INTO owner_role FROM "roles" WHERE "key" = 'owner';
  IF NEW."role_id" = owner_role OR (TG_OP = 'UPDATE' AND OLD."role_id" = owner_role) THEN
    PERFORM 1 FROM "roles" WHERE "id" = owner_role FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "staff_users_owner_lock"
  BEFORE INSERT OR UPDATE OF "role_id", "active" ON "staff_users"
  FOR EACH ROW EXECUTE FUNCTION "staff_users_owner_lock"();
