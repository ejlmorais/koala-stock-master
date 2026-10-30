import { withApi, readJson, requireString } from '@/lib/api';
import { sql } from '@/lib/db';
import { applyMovement } from '@/lib/stock';

/**
 * Refeições do staff: consomem stock exatamente como uma venda (receita do
 * item POS, ou ligação direta), mas sem entrar nas vendas — ficam marcadas
 * com ref_type 'staff_meal' para análise separada.
 */

/** GET — itens POS elegíveis como refeição (têm receita ou ligação direta). */
export const GET = withApi(async () => {
  const meals = await sql()`
    SELECT DISTINCT zp.code, zp.name, zp.familia_name
    FROM zs_products zp
    WHERE EXISTS (
            SELECT 1 FROM sale_components sc
            JOIN products p ON p.id = sc.product_id AND p.active
            WHERE sc.zs_code = zp.code)
       OR EXISTS (
            SELECT 1 FROM products p
            WHERE p.active AND (lower(p.zonesoft_name) = lower(zp.name)
                                OR p.zonesoft_name = zp.code
                                OR lower(p.name) = lower(zp.name)))
    ORDER BY zp.name`;
  return { meals };
});

/** POST — { zs_code, meal_name, staff_name, created_by } → desconta o stock. */
export const POST = withApi(async (req) => {
  const body = await readJson(req);
  const zsCode = requireString(body.zs_code, 'zs_code');
  const mealName = requireString(body.meal_name, 'meal_name');
  const staffName = requireString(body.staff_name, 'staff_name');
  const createdBy = requireString(body.created_by, 'created_by');
  const note = `Refeição staff: ${staffName} — ${mealName}`;

  const components = (await sql()`
    SELECT sc.product_id, sc.qty_per_sale, p.area, p.name, p.unit
    FROM sale_components sc
    JOIN products p ON p.id = sc.product_id AND p.active
    WHERE sc.zs_code = ${zsCode}`) as unknown as {
    product_id: number;
    qty_per_sale: string;
    area: 'bar' | 'kitchen';
    name: string;
    unit: string;
  }[];

  const descontos: { name: string; qty: number; unit: string }[] = [];
  if (components.length > 0) {
    for (const c of components) {
      const qty = Number(c.qty_per_sale);
      if (qty === 0) continue;
      await applyMovement({
        productId: c.product_id,
        area: c.area,
        delta: -qty,
        reason: 'sale',
        refType: 'staff_meal',
        note,
        createdBy,
      });
      descontos.push({ name: c.name, qty, unit: c.unit });
    }
  } else {
    const direct = (await sql()`
      SELECT id, area, name, unit, units_per_sale FROM products
      WHERE active AND (lower(zonesoft_name) = lower(${mealName})
                        OR zonesoft_name = ${zsCode}
                        OR lower(name) = lower(${mealName}))
      LIMIT 1`) as unknown as {
      id: number;
      area: 'bar' | 'kitchen';
      name: string;
      unit: string;
      units_per_sale: string;
    }[];
    if (direct[0]) {
      const qty = Number(direct[0].units_per_sale ?? 1);
      await applyMovement({
        productId: direct[0].id,
        area: direct[0].area,
        delta: -qty,
        reason: 'sale',
        refType: 'staff_meal',
        note,
        createdBy,
      });
      descontos.push({ name: direct[0].name, qty, unit: direct[0].unit });
    }
  }

  return { ok: true, descontos };
});

export const OPTIONS = withApi(async () => ({}));
