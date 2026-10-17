// SPDX-License-Identifier: GPL-3.0-or-later
// The Material icon names the database and the Android app store
// (categories.json, CategoryHints), drawn with their nearest Lucide glyph.
import {
  Baby, Bike, Bolt, BookOpen, Briefcase, Car, CircleHelp, Coffee, CreditCard, Drama, Ellipsis, Fuel, Gamepad2, Gift, GraduationCap,
  Heart, HeartPulse, Home, Landmark, MonitorPlay, PawPrint, PiggyBank, Plane, Receipt, Scissors, Shield, Shirt, ShoppingBag,
  ShoppingCart, Smartphone, Tag, Ticket, Bus, UtensilsCrossed, Wallet, Dumbbell, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  home: Home, shopping_cart: ShoppingCart, restaurant: UtensilsCrossed, directions_bus: Bus, bolt: Bolt,
  subscriptions: MonitorPlay, favorite: Heart, shopping_bag: ShoppingBag, sports_esports: Gamepad2, school: GraduationCap,
  redeem: Gift, more_horiz: Ellipsis, payments: Wallet, savings: PiggyBank, help: CircleHelp, label: Tag,
  local_hospital: HeartPulse, local_gas_station: Fuel, directions_car: Car, pets: PawPrint, flight: Plane, smartphone: Smartphone,
  fitness_center: Dumbbell, child_care: Baby, local_cafe: Coffee, theater_comedy: Drama, confirmation_number: Ticket,
  content_cut: Scissors, shield: Shield, account_balance: Landmark, checkroom: Shirt, work: Briefcase, receipt: Receipt,
  credit_card: CreditCard, menu_book: BookOpen, pedal_bike: Bike,
};

export function Icon({ name, size = 22, className, color }: { name: string; size?: number; className?: string; color?: string }) {
  const C = ICONS[name] ?? Tag;
  return <C size={size} className={className} color={color} strokeWidth={2} aria-hidden />;
}
