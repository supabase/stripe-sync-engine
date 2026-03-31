-- Migration 0012 hardcoded "postgres" as the function owner, which fails on
-- PostgreSQL installations where that role does not exist (e.g. managed cloud
-- databases). Re-assign ownership to the role executing the migration so it
-- works in any environment.
ALTER FUNCTION set_updated_at() OWNER TO CURRENT_USER;
