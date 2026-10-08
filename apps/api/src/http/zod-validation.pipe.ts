import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  type ArgumentMetadata,
  type PipeTransform,
} from "@nestjs/common";
import { z } from "zod";
export function createZodDto<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  class ContractDto {
    static readonly schema = schema.strict();
  }
  return ContractDto;
}
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const contract = metadata.metatype as unknown as { schema?: z.ZodType } | undefined;
    if (!contract?.schema) {
      if (["body", "query"].includes(metadata.type))
        throw new InternalServerErrorException("Missing endpoint contract");
      return value;
    }
    const parsed = contract.schema.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: "Invalid field",
        })),
      });
    return parsed.data;
  }
}
