import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
/** Excepción explícita al guard JWT global: el endpoint no exige token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
