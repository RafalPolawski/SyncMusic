SELECT 'CREATE DATABASE syncmusic'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'syncmusic')\gexec
