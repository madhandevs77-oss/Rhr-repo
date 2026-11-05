-- 005_defaults: infrastructure defaults (settings, catering service options, message templates).
-- No customers, payments, or vendors are seeded.

INSERT INTO settings (key, value) VALUES
 ('business', '{
    "name": "RHR Veg Restaurant",
    "legalName": "",
    "phone": "+919443730274",
    "email": "",
    "address": "242b, Trichy Rd, Sulur, Tamil Nadu 641402",
    "taxId": "",
    "invoiceFooter": "Thank you for choosing RHR Veg Restaurant.",
    "terms": "",
    "bankDetails": ""
  }'),
 ('finance', '{
    "currency": "INR",
    "taxLabel": "GST",
    "defaultTaxRate": 0,
    "invoicePrefix": "INV",
    "quotationPrefix": "QT",
    "advanceMinPercent": 0,
    "quotationValidDays": 7
  }'),
 ('notifications', '{
    "enabled": true,
    "smsProvider": "mock",
    "whatsappProvider": "mock",
    "defaultChannel": "sms",
    "maxAttempts": 5,
    "notifyOnSignificantChange": true
  }')
ON CONFLICT (key) DO NOTHING;

INSERT INTO catering_service_options (code, name, description, includes_staff, includes_utensils, includes_setup, requires_vendor) VALUES
 ('A', 'Full Catering Service',
  'Agreed bulk menu prepared by us with serving staff, utensils and setup included when selected.', true, true, true, false),
 ('B', 'Bulk Food Supply Only',
  'Prepared food supplied in bulk. Delivery or pickup is recorded separately; serving staff and setup are optional extras.', false, false, false, false),
 ('C', 'External Catering Partner',
  'We coordinate an external catering vendor to fulfil the food requirements (quote, assignment, delivery and final cost tracked).', false, false, false, true)
ON CONFLICT (code) DO NOTHING;

-- ---------- message templates ----------
INSERT INTO notification_templates (key, channel, language, body, provider_template_name) VALUES
('booking_confirmation', 'sms', 'en',
'Dear {{customer_name}},

Your hall booking at RHR Veg Restaurant has been successfully confirmed.

Booking ID: {{booking_reference}}
Hall: {{hall_name}}
Function: {{event_type}}
Event Date: {{event_date}}
Booking Time: {{start_time}} - {{end_time}}
Guests: {{guest_count}}

Total Booking Amount: {{total_amount}}
Advance Received: {{advance_amount}}
Balance Due: {{remaining_balance}}

Please retain your booking reference for future communication.

Thank you for choosing RHR Veg Restaurant.', NULL),
('booking_confirmation', 'whatsapp', 'en',
'Dear {{customer_name}},

Your hall booking at RHR Veg Restaurant has been successfully confirmed.

Booking ID: {{booking_reference}}
Hall: {{hall_name}}
Function: {{event_type}}
Event Date: {{event_date}}
Booking Time: {{start_time}} - {{end_time}}
Guests: {{guest_count}}

Total Booking Amount: {{total_amount}}
Advance Received: {{advance_amount}}
Balance Due: {{remaining_balance}}

Please retain your booking reference for future communication.

Thank you for choosing RHR Veg Restaurant.', 'booking_confirmation'),
('booking_confirmation', 'sms', 'ta',
'அன்புள்ள {{customer_name}},

RHR Veg Restaurant-இல் உங்கள் மண்டப முன்பதிவு வெற்றிகரமாக உறுதி செய்யப்பட்டுள்ளது.

முன்பதிவு எண்: {{booking_reference}}
மண்டபம்: {{hall_name}}
நிகழ்ச்சி: {{event_type}}
நிகழ்ச்சி தேதி: {{event_date}}
நேரம்: {{start_time}} - {{end_time}}
விருந்தினர்கள்: {{guest_count}}

மொத்த தொகை: {{total_amount}}
பெறப்பட்ட முன்பணம்: {{advance_amount}}
நிலுவைத் தொகை: {{remaining_balance}}

எதிர்கால தொடர்புக்கு உங்கள் முன்பதிவு எண்ணை வைத்திருக்கவும்.

RHR Veg Restaurant-ஐ தேர்ந்தெடுத்ததற்கு நன்றி.', NULL),
('booking_confirmation', 'whatsapp', 'ta',
'அன்புள்ள {{customer_name}},

RHR Veg Restaurant-இல் உங்கள் மண்டப முன்பதிவு வெற்றிகரமாக உறுதி செய்யப்பட்டுள்ளது.

முன்பதிவு எண்: {{booking_reference}}
மண்டபம்: {{hall_name}}
நிகழ்ச்சி: {{event_type}}
நிகழ்ச்சி தேதி: {{event_date}}
நேரம்: {{start_time}} - {{end_time}}
விருந்தினர்கள்: {{guest_count}}

மொத்த தொகை: {{total_amount}}
பெறப்பட்ட முன்பணம்: {{advance_amount}}
நிலுவைத் தொகை: {{remaining_balance}}

எதிர்கால தொடர்புக்கு உங்கள் முன்பதிவு எண்ணை வைத்திருக்கவும்.

RHR Veg Restaurant-ஐ தேர்ந்தெடுத்ததற்கு நன்றி.', 'booking_confirmation_ta'),

('booking_changed', 'sms', 'en',
'Dear {{customer_name}}, your booking {{booking_reference}} at RHR Veg Restaurant has been updated.
Hall: {{hall_name}}
Event Date: {{event_date}}
Time: {{start_time}} - {{end_time}}
Guests: {{guest_count}}
Balance Due: {{remaining_balance}}
For any questions please call {{restaurant_phone}}.', NULL),
('booking_changed', 'whatsapp', 'en',
'Dear {{customer_name}}, your booking {{booking_reference}} at RHR Veg Restaurant has been updated.
Hall: {{hall_name}}
Event Date: {{event_date}}
Time: {{start_time}} - {{end_time}}
Guests: {{guest_count}}
Balance Due: {{remaining_balance}}
For any questions please call {{restaurant_phone}}.', 'booking_changed'),
('booking_changed', 'sms', 'ta',
'அன்புள்ள {{customer_name}}, RHR Veg Restaurant-இல் உங்கள் முன்பதிவு {{booking_reference}} புதுப்பிக்கப்பட்டுள்ளது.
மண்டபம்: {{hall_name}}
நிகழ்ச்சி தேதி: {{event_date}}
நேரம்: {{start_time}} - {{end_time}}
விருந்தினர்கள்: {{guest_count}}
நிலுவைத் தொகை: {{remaining_balance}}
விவரங்களுக்கு {{restaurant_phone}} எண்ணை அழைக்கவும்.', NULL),
('booking_changed', 'whatsapp', 'ta',
'அன்புள்ள {{customer_name}}, RHR Veg Restaurant-இல் உங்கள் முன்பதிவு {{booking_reference}} புதுப்பிக்கப்பட்டுள்ளது.
மண்டபம்: {{hall_name}}
நிகழ்ச்சி தேதி: {{event_date}}
நேரம்: {{start_time}} - {{end_time}}
விருந்தினர்கள்: {{guest_count}}
நிலுவைத் தொகை: {{remaining_balance}}
விவரங்களுக்கு {{restaurant_phone}} எண்ணை அழைக்கவும்.', 'booking_changed_ta'),

('catering_confirmation', 'sms', 'en',
'Dear {{customer_name}}, your bulk catering order {{order_reference}} with RHR Veg Restaurant is confirmed.
Event Date: {{event_date}}
Delivery/Serving Time: {{delivery_time}}
Plates: {{plates}}
Total Amount: {{total_amount}}
Advance Received: {{advance_amount}}
Balance Due: {{remaining_balance}}
Thank you for choosing RHR Veg Restaurant.', NULL),
('catering_confirmation', 'whatsapp', 'en',
'Dear {{customer_name}}, your bulk catering order {{order_reference}} with RHR Veg Restaurant is confirmed.
Event Date: {{event_date}}
Delivery/Serving Time: {{delivery_time}}
Plates: {{plates}}
Total Amount: {{total_amount}}
Advance Received: {{advance_amount}}
Balance Due: {{remaining_balance}}
Thank you for choosing RHR Veg Restaurant.', 'catering_confirmation'),
('catering_confirmation', 'sms', 'ta',
'அன்புள்ள {{customer_name}}, RHR Veg Restaurant-இல் உங்கள் மொத்த உணவு ஆர்டர் {{order_reference}} உறுதி செய்யப்பட்டுள்ளது.
நிகழ்ச்சி தேதி: {{event_date}}
டெலிவரி/பரிமாறும் நேரம்: {{delivery_time}}
தட்டுகள்: {{plates}}
மொத்த தொகை: {{total_amount}}
பெறப்பட்ட முன்பணம்: {{advance_amount}}
நிலுவைத் தொகை: {{remaining_balance}}
RHR Veg Restaurant-ஐ தேர்ந்தெடுத்ததற்கு நன்றி.', NULL),
('catering_confirmation', 'whatsapp', 'ta',
'அன்புள்ள {{customer_name}}, RHR Veg Restaurant-இல் உங்கள் மொத்த உணவு ஆர்டர் {{order_reference}} உறுதி செய்யப்பட்டுள்ளது.
நிகழ்ச்சி தேதி: {{event_date}}
டெலிவரி/பரிமாறும் நேரம்: {{delivery_time}}
தட்டுகள்: {{plates}}
மொத்த தொகை: {{total_amount}}
பெறப்பட்ட முன்பணம்: {{advance_amount}}
நிலுவைத் தொகை: {{remaining_balance}}
RHR Veg Restaurant-ஐ தேர்ந்தெடுத்ததற்கு நன்றி.', 'catering_confirmation_ta')
ON CONFLICT (key, channel, language) DO NOTHING;
