# Custom Postgres Image
# Bakes in the multiple-database initialization script for SyncMusic + Keycloak.

FROM postgres:18-alpine

# Scripts in /docker-entrypoint-initdb.d/ are executed automatically on first startup
COPY init-db.sh /docker-entrypoint-initdb.d/init-db.sh
RUN chmod +x /docker-entrypoint-initdb.d/init-db.sh
