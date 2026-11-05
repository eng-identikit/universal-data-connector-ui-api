-- Users of the UI (local login; with Keycloak users live there)
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text,
  role          text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'operator', 'viewer')),
  disabled      boolean NOT NULL DEFAULT false,
  -- Bumped on password change or disable: older tokens stop working
  token_version integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Catalog of UDC instances the UI orchestrates
CREATE TABLE udcs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  -- Base URL the BFF uses (e.g. http://udc:3000); public_url is what clients outside see (MCP)
  url         text NOT NULL,
  public_url  text,
  -- Service API key of the instance, encrypted (AES-256-GCM)
  api_key_enc text NOT NULL,
  color       text,
  position    jsonb NOT NULL DEFAULT '{"x": 0, "y": 0}',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Position of the source/sink blocks of each UDC on the board
CREATE TABLE udc_layout (
  udc_id   uuid NOT NULL REFERENCES udcs(id) ON DELETE CASCADE,
  node_key text NOT NULL,
  x        double precision NOT NULL,
  y        double precision NOT NULL,
  PRIMARY KEY (udc_id, node_key)
);
