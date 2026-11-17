import { applyDecorators } from '@nestjs/common';
import { Matches } from 'class-validator';

/** Money, quantities and percentages travel as strings so no precision is lost: up to 14 digits, 4 decimals. */
export const IsDecimal = () => applyDecorators(Matches(/^\d{1,14}(\.\d{1,4})?$/, { message: '$property must be a non-negative decimal with at most 4 decimal places' }));
