-- 011: one managed Catering Menu (categories + items) with a separate price per item, order lines linked to it, and saved drafts.

-- ---------- catering prices: one row per Catering Menu item, kept apart from the menu itself ----------
CREATE TABLE catering_prices (
  meal_item_id uuid PRIMARY KEY REFERENCES meal_menu_items(id) ON DELETE CASCADE,
  unit         text NOT NULL DEFAULT 'plate' CHECK (unit IN ('plate','kg','litre','piece','tray','packet')),
  unit_price   numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0 AND unit_price <= 9999999.99),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id)
);

ALTER TABLE catering_order_items ADD COLUMN meal_item_id uuid REFERENCES meal_menu_items(id) ON DELETE SET NULL;
CREATE INDEX catering_order_items_meal ON catering_order_items (meal_item_id);

-- ---------- bring the earlier priced list into the managed menu (nothing is deleted; old table stays for history) ----------
DO $$
DECLARE r record; cat_id uuid; item_id uuid;
BEGIN
  FOR r IN SELECT * FROM menu_items ORDER BY category, sort, name LOOP
    SELECT id INTO cat_id FROM menu_categories WHERE lower(name) = lower(r.category);
    IF cat_id IS NULL THEN
      INSERT INTO menu_categories (name, active, sort) VALUES (r.category, true, (SELECT COALESCE(max(sort),0)+1 FROM menu_categories)) RETURNING id INTO cat_id;
    END IF;
    SELECT id INTO item_id FROM meal_menu_items WHERE category_id = cat_id AND lower(name) = lower(r.name);
    IF item_id IS NULL THEN
      INSERT INTO meal_menu_items (category_id, name, active, sort) VALUES (cat_id, r.name, r.active, (SELECT COALESCE(max(sort),0)+1 FROM meal_menu_items WHERE category_id = cat_id)) RETURNING id INTO item_id;
    END IF;
    INSERT INTO catering_prices (meal_item_id, unit, unit_price) VALUES (item_id, r.unit, r.unit_price) ON CONFLICT (meal_item_id) DO NOTHING;
    UPDATE catering_order_items SET meal_item_id = item_id WHERE menu_item_id = r.id;
  END LOOP;
END $$;

-- ---------- drafts: unsubmitted forms, never part of bookings, history or availability ----------
CREATE TABLE drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('booking','catering')),
  category      text NOT NULL,                       -- Hall / Outsource / Catering (shown on the dashboard)
  hall_id       uuid REFERENCES halls(id) ON DELETE SET NULL,
  title         text NOT NULL DEFAULT '',
  customer_name text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft')),
  data          jsonb NOT NULL,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drafts_size CHECK (pg_column_size(data) < 400000)
);
CREATE INDEX drafts_updated ON drafts (updated_at DESC);
