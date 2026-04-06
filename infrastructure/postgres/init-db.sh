#!/bin/bash
set -e

# 1. Initialize SyncMusic user and database
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER syncmusic WITH PASSWORD '$POSTGRES_PASSWORD';
    CREATE DATABASE syncmusic OWNER syncmusic;
EOSQL

# Essential for Postgres 15+: Grant schema permissions explicitly
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "syncmusic" <<-EOSQL
    GRANT ALL ON SCHEMA public TO syncmusic;
EOSQL

# 2. Initialize Keycloak user and database
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER keycloak WITH PASSWORD '$KC_DB_PASSWORD';
    CREATE DATABASE keycloak OWNER keycloak;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "keycloak" <<-EOSQL
    GRANT ALL ON SCHEMA public TO keycloak;
EOSQL
