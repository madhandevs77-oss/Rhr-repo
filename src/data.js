const img = (n) => `${import.meta.env.BASE_URL}images/${n}`

export const DEFAULT_HALLS = [
  {
    id: 'h1',
    name: 'Celebration Hall',
    description: 'Dedicated celebration hall for weddings, receptions, birthdays & events.',
    photos: [1, 2, 3, 4].map((i) => img(`hall1-${i}.jpg`)),
  },
  {
    id: 'h2',
    name: 'Main Dining Hall',
    description: 'Primary dining area for unlimited meals and daily service.',
    photos: [1, 2, 3, 4].map((i) => img(`hall2-${i}.jpg`)),
  },
  {
    id: 'h3',
    name: 'Private Dining Area',
    description: 'Intimate space for family gatherings and small functions.',
    photos: [1, 2, 3, 4].map((i) => img(`hall3-${i}.jpg`)),
  },
]

const F = (name, cat, price) => ({ name, cat, price })
const MENU = [
  F('Mini Tiffin', 'Breakfast / Tiffin', 70),
  F('Sambar Idli', 'Breakfast / Tiffin', 60),
  F('Butter Appam', 'Breakfast / Tiffin', 45),
  F('Kichadi', 'Breakfast / Tiffin', 55),
  F('Dosa & Ghee Roast', 'Breakfast / Tiffin', 65),
  F('Idli with Molagapodi', 'Breakfast / Tiffin', 55),
  F('Pongal', 'Breakfast / Tiffin', 60),
  F('Upma & Kesari', 'Breakfast / Tiffin', 45),
  F('Parotta & Kuruma', 'Lunch Specials', 60),
  F('Gobi Manchurian', 'Lunch Specials', 90),
  F('Paneer Butter Masala', 'Lunch Specials', 120),
  F('Veg Biryani', 'Lunch Specials', 110),
  F('Curd Rice & Pickle', 'Lunch Specials', 50),
  F('Ghee Pongal Meals', 'Lunch Specials', 95),
  F('Chapati & Gravy', 'Lunch Specials', 70),
  F('Unlimited Meals (Banana Leaf)', 'Unlimited Meals', 100),
  F('Rice', 'Unlimited Meals', 0),
  F('Paruppu', 'Unlimited Meals', 0),
  F('Sambar', 'Unlimited Meals', 0),
  F('Rasam', 'Unlimited Meals', 0),
  F('Kootu', 'Unlimited Meals', 0),
  F('Poriyal', 'Unlimited Meals', 0),
  F('Buttermilk', 'Unlimited Meals', 0),
  F('Filter Coffee', 'Beverages', 25),
  F('Tea / Masala Chai', 'Beverages', 15),
  F('Lime Soda', 'Beverages', 30),
  F('Buttermilk', 'Beverages', 20),
  F('Sambar', 'Catering Items', 0),
  F('Rasam', 'Catering Items', 0),
  F('Poriyal', 'Catering Items', 0),
  F('Kootu', 'Catering Items', 0),
  F('Curd', 'Catering Items', 0),
  F('Pickle', 'Catering Items', 0),
  F('Sweet / Payasam', 'Catering Items', 0),
  F('Ice Cream', 'Catering Items', 0),
]
export const DEFAULT_FOOD = MENU.map((f, i) => ({ id: 'f' + (i + 1), ...f }))

export const DEFAULT_SETTINGS = {
  hotelName: 'RHR Veg Restaurant',
  phone: '+919443730274',
  address: '242b, Trichy Rd, Sulur, Tamil Nadu 641402',
}

export const EVENT_TYPES = ['Wedding', 'Reception', 'Engagement', 'Birthday', 'Conference', 'Party', 'Other']
export const PAY_METHODS = ['Cash', 'GPay', 'UPI', 'Bank Transfer', 'Card', 'Other']
export const TAGLINE = 'Pure Vegetarian · Since 1931 · Sulur, Coimbatore'
export const LOGO = `${import.meta.env.BASE_URL}images/logo.png`
