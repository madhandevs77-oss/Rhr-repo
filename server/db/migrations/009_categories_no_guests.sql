-- 009: dynamic menu categories; remove guest-count / guest-capacity completely.

-- ---------- archive the removed guest data (read-only, unused by the app; drop it any time with: DROP TABLE legacy_guest_data_archive) ----------
CREATE TABLE legacy_guest_data_archive (
  entity    text NOT NULL,           -- 'booking' | 'catering_order' | 'hall'
  entity_id uuid NOT NULL,
  value     int,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity, entity_id)
);
INSERT INTO legacy_guest_data_archive (entity, entity_id, value) SELECT 'booking', id, guests FROM bookings WHERE guests IS NOT NULL;
INSERT INTO legacy_guest_data_archive (entity, entity_id, value) SELECT 'catering_order', id, guests FROM catering_orders WHERE guests IS NOT NULL;
INSERT INTO legacy_guest_data_archive (entity, entity_id, value) SELECT 'hall', id, capacity FROM halls WHERE capacity IS NOT NULL;

ALTER TABLE bookings DROP COLUMN guests;
ALTER TABLE catering_orders DROP COLUMN guests;
ALTER TABLE halls DROP COLUMN capacity;

-- the {{guest_count}} placeholder no longer exists: strip it from stored message templates
UPDATE notification_templates SET body = regexp_replace(body, E'\\n(Guests|விருந்தினர்கள்): \\{\\{guest_count\\}\\}', '', 'g');
UPDATE notification_templates SET body = replace(body, '{{guest_count}}', '') WHERE body LIKE '%{{guest_count}}%';

-- ---------- dynamic menu categories ----------
CREATE TABLE menu_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  active     boolean NOT NULL DEFAULT true,
  sort       int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX menu_categories_name ON menu_categories (lower(name));

INSERT INTO menu_categories (name, sort) VALUES ('Royal Breakfast', 1), ('Royal Lunch', 2), ('Royal Dinner', 3);

ALTER TABLE meal_menu_items ADD COLUMN category_id uuid REFERENCES menu_categories(id) ON DELETE CASCADE;
UPDATE meal_menu_items i SET category_id = c.id FROM menu_categories c
  WHERE c.name = CASE i.meal WHEN 'breakfast' THEN 'Royal Breakfast' WHEN 'lunch' THEN 'Royal Lunch' ELSE 'Royal Dinner' END;
ALTER TABLE meal_menu_items ALTER COLUMN category_id SET NOT NULL;
DROP INDEX meal_menu_unique;
ALTER TABLE meal_menu_items DROP COLUMN meal;
CREATE UNIQUE INDEX meal_menu_unique ON meal_menu_items (category_id, lower(name));
CREATE INDEX meal_menu_category ON meal_menu_items (category_id, sort);

-- saved booking menus: replace the old fixed "meal" tag with a frozen category name (names/ids stay as saved)
UPDATE bookings b SET food_items = (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN e ? 'meal' THEN
      (e - 'meal') || jsonb_build_object(
        'category', CASE e->>'meal' WHEN 'breakfast' THEN 'Royal Breakfast' WHEN 'lunch' THEN 'Royal Lunch' ELSE 'Royal Dinner' END,
        'categorySort', CASE e->>'meal' WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END)
    ELSE e END ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements(b.food_items) WITH ORDINALITY AS t(e, ord))
WHERE food_items::text LIKE '%"meal"%';
