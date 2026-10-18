import { withApi, readJson, ApiError } from '@/lib/api';
import { receiveOrder, type ReceptionLineInput } from '@/lib/v2/orders';

/** POST { received_by?, invoice_ref?, note?, lines: [{ order_line_id, packs?, loose?, units?, not_coming? }] } */
export const POST = withApi(async (req, params) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new ApiError(400, 'id inválido');
  const body = await readJson(req);
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw new ApiError(400, '"lines" é obrigatório');
  return {
    order: await receiveOrder(id, {
      received_by: (body.received_by as string) ?? null,
      invoice_ref: (body.invoice_ref as string) ?? null,
      note: (body.note as string) ?? null,
      lines: body.lines as ReceptionLineInput[],
    }),
  };
});
export const OPTIONS = withApi(async () => ({}));
