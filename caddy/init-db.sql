-- This script runs as the 'postgres' user
CREATE DATABASE syncmusic;

-- Ensure the keycloak user exists with the correct password from environment (if we could, but SQL is static)
-- So we'll just create it with a placeholder if it doesn't exist, though POSTGRES_USER usually handles one.
-- Actually, the best way for DevOps is to have the APP users separate.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'keycloak') THEN
        CREATE USER keycloak WITH PASSWORD 'syncmusic_db_secret';
    END IF;
END
$$;

GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak;
