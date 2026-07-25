import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let client: NeonQueryFunction<false, false> | null = null;

export function sql() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    client = neon(url);
  }
  return client;
}

export const AREAS = ['bar', 'kitchen'] as const;
export type Area = (typeof AREAS)[number];

export function isArea(value: unknown): value is Area {
  return value === 'bar' || value === 'kitchen';
}

export type MovementReason = 'manual' | 'sale' | 'order' | 'adjustment';

export interface Product {
  id: number;
  name: string;
  unit: string; // 'un', 'kg', 'L', …
  area: Area; // where its stock lives by default
  zonesoft_name: string | null; // product name as it appears in ZSBMS sales
  units_per_sale: string; // numeric — stock decremented per unit sold
  min_level: string | null; // numeric — below this triggers a low-stock alert
  active: boolean;
}

export interface StockLevel {
  product_id: number;
  area: Area;
  qty: string;
  updated_at: string;
}

export interface StockMovement {
  id: number;
  product_id: number;
  area: Area;
  delta: string;
  reason: MovementReason;
  ref_type: string | null;
  ref_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export type OrderStatus = 'draft' | 'ordered' | 'received' | 'cancelled';

export interface Order {
  id: number;
  supplier: string;
  status: OrderStatus;
  ordered_at: string | null;
  received_at: string | null;
  note: string | null;
  created_at: string;
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number;
  qty: string;
  unit_cost: string | null;
  area: Area | null; // overrides the product's default area when set
}
