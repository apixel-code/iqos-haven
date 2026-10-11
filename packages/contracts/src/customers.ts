import { z } from "zod";
/** Stored customer phone identity. Typed input is normalized by `normalizePhone` first. */
export const phoneE164Schema = z.string().regex(/^\+[1-9]\d{7,14}$/);
export const customerAddressTypeSchema = z.enum(["apartment", "villa", "office"]);
const line = (max: number) => z.string().min(1).max(max);
/** Storage bounds of a saved address (already normalized). Per-type rules are step 66. */
export const customerAddressSchema = z.strictObject({
  areaId: z.uuid(),
  type: customerAddressTypeSchema,
  building: line(150),
  unit: line(50).nullable(),
  street: line(150).nullable(),
  makani: z
    .string()
    .regex(/^\d{10}$/)
    .nullable(),
  notes: line(500).nullable(),
});
export type CustomerAddressType = z.infer<typeof customerAddressTypeSchema>;
export type CustomerAddress = z.infer<typeof customerAddressSchema>;
