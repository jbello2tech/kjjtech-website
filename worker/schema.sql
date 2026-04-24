CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  business_or_role TEXT,
  rating INTEGER NOT NULL,
  service_type TEXT,
  review TEXT NOT NULL,
  display_anonymously TEXT DEFAULT 'No',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at DESC);
