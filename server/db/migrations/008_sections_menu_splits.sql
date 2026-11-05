-- 008: seven booking sections, price-free meal menu, manual food amount, split payments.
-- Additive only: no existing row is deleted or rewritten except the payment-method CHECK (widened).

-- ---------- sections (a section is a hall with a "kind") ----------
ALTER TABLE halls ADD COLUMN kind text CHECK (kind IS NULL OR kind IN ('mandapam','mini_hall','outsource'));
ALTER TABLE halls ADD COLUMN default_charge numeric(12,2) NOT NULL DEFAULT 0 CHECK (default_charge >= 0 AND default_charge <= 99999999.99);
ALTER TABLE halls ADD COLUMN section_order int;
CREATE UNIQUE INDEX halls_section_order ON halls (section_order) WHERE section_order IS NOT NULL;

-- Re-use an existing hall that already has the section's name (keeps its photos and bookings); create the rest.
INSERT INTO halls (name, description, capacity, active)
SELECT v.name, '', 1000, true FROM (VALUES
  ('Mandapam'),('Mini Hall'),('Outsource 1'),('Outsource 2'),('Outsource 3'),('Outsource 4'),('Outsource 5')) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM halls h WHERE lower(h.name) = lower(v.name));

UPDATE halls SET kind='mandapam',  section_order=1, default_charge=15000, active=true WHERE lower(name)='mandapam';
UPDATE halls SET kind='mini_hall', section_order=2, default_charge=5000,  active=true WHERE lower(name)='mini hall';
UPDATE halls SET kind='outsource', section_order=2 + substring(name from '[0-9]+$')::int WHERE lower(name) ~ '^outsource [1-5]$';

-- ---------- bookings ----------
ALTER TABLE bookings ALTER COLUMN guests DROP NOT NULL;            -- sections have no guest count
ALTER TABLE bookings ADD COLUMN meals text[] NOT NULL DEFAULT '{}';  -- breakfast / lunch / dinner chosen
ALTER TABLE bookings ADD COLUMN food_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (food_amount >= 0 AND food_amount <= 99999999.99); -- manual agreed food-service amount
ALTER TABLE bookings ADD CONSTRAINT bookings_meals_valid CHECK (meals <@ ARRAY['breakfast','lunch','dinner']::text[]);
CREATE INDEX bookings_hall_date ON bookings (hall_id, event_date) WHERE status <> 'cancelled';
CREATE INDEX halls_kind ON halls (kind) WHERE kind IS NOT NULL;

-- ---------- price-free meal menu ----------
CREATE TABLE meal_menu_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal       text NOT NULL CHECK (meal IN ('breakfast','lunch','dinner')),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  active     boolean NOT NULL DEFAULT true,
  sort       int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX meal_menu_unique ON meal_menu_items (meal, lower(name));

INSERT INTO meal_menu_items (meal, name, sort)
SELECT m, n, row_number() OVER (PARTITION BY m ORDER BY ord) FROM (VALUES
 ('breakfast',1,'Mini Ghee Jalebi'),('breakfast',2,'Mini Ghee Laddu'),('breakfast',3,'Mini Ghee Mysorepa'),('breakfast',4,'Milk Sweet'),('breakfast',5,'Idly'),
 ('breakfast',6,'Mini Vadai'),('breakfast',7,'Pongal'),('breakfast',8,'Kichadi'),('breakfast',9,'Semiya Kichadi'),('breakfast',10,'Wheat Upma'),('breakfast',11,'Mini Masal Dosa'),
 ('breakfast',12,'Podi Dosa'),('breakfast',13,'Cauliflower Dosa'),('breakfast',14,'Mini Onion Uthappam'),('breakfast',15,'Poori'),('breakfast',16,'Coffee'),('breakfast',17,'Tea'),
 ('breakfast',18,'Badam Milk'),('breakfast',19,'Water Bottle — 300 ml'),('breakfast',20,'Coconut Chutney'),('breakfast',21,'Kara Chutney'),('breakfast',22,'Sambar'),
 ('lunch',1,'Mini Ghee Jalebi'),('lunch',2,'Mini Ghee Laddu'),('lunch',3,'Mini Mysorepa'),('lunch',4,'Milk Sweet'),('lunch',5,'White Rice'),('lunch',6,'Ghee Dal'),('lunch',7,'Sambar'),
 ('lunch',8,'Rasam'),('lunch',9,'Brinjal Curry'),('lunch',10,'Poriyal'),('lunch',11,'Kootu'),('lunch',12,'Kara Kari'),('lunch',13,'Payasam'),('lunch',14,'Curd'),
 ('lunch',15,'Mini Paruppu Vadai'),('lunch',16,'Appalam'),('lunch',17,'Pickle'),('lunch',18,'Salt'),('lunch',19,'Water Bottle — 300 ml'),
 ('lunch',20,'Tamarind Rice'),('lunch',21,'Lemon Rice'),('lunch',22,'Tomato Rice'),('lunch',23,'Coconut Rice'),('lunch',24,'Coriander Rice'),('lunch',25,'Mint Rice'),
 ('lunch',26,'Kalkandu Rice'),('lunch',27,'Curry Leaf Rice'),('lunch',28,'Brinjal Rice'),('lunch',29,'Mango Rice'),('lunch',30,'Arisi Paruppu Sadham'),('lunch',31,'Vatha Kozhambu Sadham'),
 ('lunch',32,'Special Poriyal'),('lunch',33,'Mushroom Biryani'),('lunch',34,'Banana'),('lunch',35,'Beeda'),('lunch',36,'Ice Cream'),('lunch',37,'Fruit Salad with Ice Cream'),
 ('lunch',38,'Hot Gulab Jamun with Ice Cream'),('lunch',39,'Chappathi with Kurma'),
 ('dinner',1,'Hot Ghee Jalebi'),('dinner',2,'Ghee Laddu'),('dinner',3,'Badusha'),('dinner',4,'Milk Sweet'),('dinner',5,'Idly'),('dinner',6,'Veg Cutlet'),('dinner',7,'Mysore Bonda'),
 ('dinner',8,'Gobi 65'),('dinner',9,'Veg Biryani'),('dinner',10,'Veg Pulao'),('dinner',11,'Ghee Rice'),('dinner',12,'Onion Raita'),('dinner',13,'Mini Masal Dosa'),('dinner',14,'Podi Dosa'),
 ('dinner',15,'Cauliflower Dosa'),('dinner',16,'Mini Onion Uthappam'),('dinner',17,'Chappathi'),('dinner',18,'Kothu Parotta'),('dinner',19,'Veg Kurma'),('dinner',20,'Channa Gravy'),
 ('dinner',21,'Curd Rice'),('dinner',22,'Curd Semiya'),('dinner',23,'Pickle'),('dinner',24,'Sambar'),('dinner',25,'Coconut Chutney'),('dinner',26,'Kara Chutney'),('dinner',27,'Coffee'),
 ('dinner',28,'Tea'),('dinner',29,'Badam Milk'),('dinner',30,'Water Bottle — 300 ml')
) AS t(m, ord, n);

-- ---------- split payments ----------
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('Cash','GPay','UPI','Bank Transfer','Card','Cheque','Other','Split'));

CREATE TABLE payment_splits (
  payment_id uuid NOT NULL REFERENCES payments(id),
  method     text NOT NULL CHECK (method IN ('Cash','GPay','UPI','Bank Transfer','Card','Cheque','Other')),
  amount     numeric(12,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, method)
);
INSERT INTO payment_splits (payment_id, method, amount) SELECT id, method, amount FROM payments WHERE method <> 'Split';
CREATE FUNCTION splits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment splits are immutable' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER splits_guard_t BEFORE UPDATE OR DELETE ON payment_splits FOR EACH ROW EXECUTE FUNCTION splits_guard();
CREATE INDEX payments_paid_on ON payments (paid_on);

-- ---------- finance setting: GST for section bookings (added only if absent) ----------
UPDATE settings SET value = jsonb_build_object('sectionGstRate', 5) || value WHERE key='finance';
