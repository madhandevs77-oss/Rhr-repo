-- 010: "Extra amount" (one plain amount) next to itemised extra charges; every hall uses the same booking rules; GST is no longer added automatically.
ALTER TABLE bookings ADD COLUMN extra_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (extra_amount >= 0 AND extra_amount <= 99999999.99);

-- halls that are not one of the seven sections use the same maintenance-charge default; start from their old base price (nothing is overwritten if already set)
UPDATE halls SET default_charge = base_price WHERE kind IS NULL AND default_charge = 0 AND base_price > 0;

-- the automatic section GST rate is retired (existing bookings keep the tax they were saved with)
UPDATE settings SET value = value - 'sectionGstRate' WHERE key = 'finance';
