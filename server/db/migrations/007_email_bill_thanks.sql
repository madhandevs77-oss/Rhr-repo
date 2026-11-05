-- 007: email channel, invoice attachments, "bill ready" and "thank you" messages

ALTER TABLE notification_templates DROP CONSTRAINT IF EXISTS notification_templates_channel_check;
ALTER TABLE notification_templates ADD CONSTRAINT notification_templates_channel_check CHECK (channel IN ('sms','whatsapp','email'));
ALTER TABLE notification_templates ADD COLUMN subject text;

ALTER TABLE notification_events DROP CONSTRAINT IF EXISTS notification_events_channel_check;
ALTER TABLE notification_events ADD CONSTRAINT notification_events_channel_check CHECK (channel IN ('sms','whatsapp','email'));
ALTER TABLE notification_events ALTER COLUMN to_phone DROP NOT NULL;
ALTER TABLE notification_events ADD COLUMN to_email text;
ALTER TABLE notification_events ADD COLUMN subject text;
ALTER TABLE notification_events ADD COLUMN invoice_id uuid REFERENCES invoices(id);
ALTER TABLE notification_events ADD CONSTRAINT notification_events_destination CHECK (to_phone IS NOT NULL OR to_email IS NOT NULL);
CREATE INDEX notification_invoice ON notification_events (invoice_id) WHERE invoice_id IS NOT NULL;

UPDATE settings SET value = value || '{"emailProvider":"mock","sendBill":true,"sendThankYou":true,"thankYouDelayHours":2}'::jsonb WHERE key = 'notifications';

-- ---------- templates: bill_ready ----------
INSERT INTO notification_templates (key, channel, language, subject, body, provider_template_name) VALUES
('bill_ready', 'sms', 'en', NULL,
'Dear {{customer_name}},

Thank you for your payment. Your bill is ready.

Invoice No: {{invoice_number}}
Reference: {{reference}}
Event Date: {{event_date}}
Total Paid: {{total_amount}} (paid in full)

{{bill_note}}

For any query please call {{restaurant_phone}}.

RHR Veg Restaurant', NULL),
('bill_ready', 'whatsapp', 'en', NULL,
'Dear {{customer_name}},

Thank you for your payment. Your bill is ready.

Invoice No: {{invoice_number}}
Reference: {{reference}}
Event Date: {{event_date}}
Total Paid: {{total_amount}} (paid in full)

{{bill_note}}

For any query please call {{restaurant_phone}}.

RHR Veg Restaurant', 'bill_ready'),
('bill_ready', 'email', 'en', 'Your invoice {{invoice_number}} - RHR Veg Restaurant',
'Dear {{customer_name}},

Thank you for your payment. Your bill is ready and the invoice is attached to this email as a PDF.

Invoice No: {{invoice_number}}
Reference: {{reference}}
Event Date: {{event_date}}
Total Paid: {{total_amount}} (paid in full)

If you have any question about this invoice, please call us on {{restaurant_phone}}.

Thank you for choosing RHR Veg Restaurant.', NULL),
('bill_ready', 'sms', 'ta', NULL,
'அன்புள்ள {{customer_name}},

உங்கள் கட்டணத்திற்கு நன்றி. உங்கள் பில் தயாராக உள்ளது.

இன்வாய்ஸ் எண்: {{invoice_number}}
முன்பதிவு எண்: {{reference}}
நிகழ்ச்சி தேதி: {{event_date}}
செலுத்திய தொகை: {{total_amount}} (முழுமையாக செலுத்தப்பட்டது)

{{bill_note}}

விவரங்களுக்கு {{restaurant_phone}} என்ற எண்ணை அழைக்கவும்.

RHR Veg Restaurant', NULL),
('bill_ready', 'whatsapp', 'ta', NULL,
'அன்புள்ள {{customer_name}},

உங்கள் கட்டணத்திற்கு நன்றி. உங்கள் பில் தயாராக உள்ளது.

இன்வாய்ஸ் எண்: {{invoice_number}}
முன்பதிவு எண்: {{reference}}
நிகழ்ச்சி தேதி: {{event_date}}
செலுத்திய தொகை: {{total_amount}} (முழுமையாக செலுத்தப்பட்டது)

{{bill_note}}

விவரங்களுக்கு {{restaurant_phone}} என்ற எண்ணை அழைக்கவும்.

RHR Veg Restaurant', 'bill_ready_ta'),
('bill_ready', 'email', 'ta', 'உங்கள் இன்வாய்ஸ் {{invoice_number}} - RHR Veg Restaurant',
'அன்புள்ள {{customer_name}},

உங்கள் கட்டணத்திற்கு நன்றி. உங்கள் பில் தயாராக உள்ளது; இன்வாய்ஸ் PDF ஆக இந்த மின்னஞ்சலுடன் இணைக்கப்பட்டுள்ளது.

இன்வாய்ஸ் எண்: {{invoice_number}}
முன்பதிவு எண்: {{reference}}
நிகழ்ச்சி தேதி: {{event_date}}
செலுத்திய தொகை: {{total_amount}} (முழுமையாக செலுத்தப்பட்டது)

இந்த இன்வாய்ஸ் குறித்து ஏதேனும் கேள்வி இருந்தால் {{restaurant_phone}} என்ற எண்ணில் எங்களை அழைக்கவும்.

RHR Veg Restaurant-ஐ தேர்ந்தெடுத்ததற்கு நன்றி.', NULL),

-- ---------- templates: thank_you ----------
('thank_you', 'sms', 'en', NULL,
'Dear {{customer_name}},

Thank you for choosing RHR Veg Restaurant for your {{event_type}} on {{event_date}}. It was a pleasure serving you and your guests.

We hope everything was to your satisfaction and we would be happy to host you again.

For feedback or future bookings please call {{restaurant_phone}}.

Warm regards,
RHR Veg Restaurant', NULL),
('thank_you', 'whatsapp', 'en', NULL,
'Dear {{customer_name}},

Thank you for choosing RHR Veg Restaurant for your {{event_type}} on {{event_date}}. It was a pleasure serving you and your guests.

We hope everything was to your satisfaction and we would be happy to host you again.

For feedback or future bookings please call {{restaurant_phone}}.

Warm regards,
RHR Veg Restaurant', 'thank_you'),
('thank_you', 'email', 'en', 'Thank you from RHR Veg Restaurant',
'Dear {{customer_name}},

Thank you for choosing RHR Veg Restaurant for your {{event_type}} on {{event_date}} (reference {{reference}}). It was a pleasure serving you and your guests.

We hope everything was to your satisfaction and we would be happy to host you again.

For feedback or future bookings, please call us on {{restaurant_phone}}.

Warm regards,
RHR Veg Restaurant', NULL),
('thank_you', 'sms', 'ta', NULL,
'அன்புள்ள {{customer_name}},

{{event_date}} அன்று உங்கள் {{event_type}} நிகழ்ச்சிக்கு RHR Veg Restaurant-ஐ தேர்ந்தெடுத்ததற்கு மிக்க நன்றி. உங்களுக்கும் உங்கள் விருந்தினர்களுக்கும் சேவை செய்தது எங்களுக்கு மகிழ்ச்சி.

எல்லாம் உங்களுக்கு திருப்தியாக இருந்தது என்று நம்புகிறோம். மீண்டும் உங்களை வரவேற்க ஆவலுடன் இருக்கிறோம்.

கருத்துகள் அல்லது புதிய முன்பதிவுகளுக்கு {{restaurant_phone}} என்ற எண்ணை அழைக்கவும்.

அன்புடன்,
RHR Veg Restaurant', NULL),
('thank_you', 'whatsapp', 'ta', NULL,
'அன்புள்ள {{customer_name}},

{{event_date}} அன்று உங்கள் {{event_type}} நிகழ்ச்சிக்கு RHR Veg Restaurant-ஐ தேர்ந்தெடுத்ததற்கு மிக்க நன்றி. உங்களுக்கும் உங்கள் விருந்தினர்களுக்கும் சேவை செய்தது எங்களுக்கு மகிழ்ச்சி.

எல்லாம் உங்களுக்கு திருப்தியாக இருந்தது என்று நம்புகிறோம். மீண்டும் உங்களை வரவேற்க ஆவலுடன் இருக்கிறோம்.

கருத்துகள் அல்லது புதிய முன்பதிவுகளுக்கு {{restaurant_phone}} என்ற எண்ணை அழைக்கவும்.

அன்புடன்,
RHR Veg Restaurant', 'thank_you_ta'),
('thank_you', 'email', 'ta', 'RHR Veg Restaurant-இன் நன்றி',
'அன்புள்ள {{customer_name}},

{{event_date}} அன்று உங்கள் {{event_type}} நிகழ்ச்சிக்கு (எண்: {{reference}}) RHR Veg Restaurant-ஐ தேர்ந்தெடுத்ததற்கு மிக்க நன்றி. உங்களுக்கும் உங்கள் விருந்தினர்களுக்கும் சேவை செய்தது எங்களுக்கு மகிழ்ச்சி.

எல்லாம் உங்களுக்கு திருப்தியாக இருந்தது என்று நம்புகிறோம். மீண்டும் உங்களை வரவேற்க ஆவலுடன் இருக்கிறோம்.

கருத்துகள் அல்லது புதிய முன்பதிவுகளுக்கு {{restaurant_phone}} என்ற எண்ணில் எங்களை அழைக்கவும்.

அன்புடன்,
RHR Veg Restaurant', NULL)
ON CONFLICT (key, channel, language) DO NOTHING;
