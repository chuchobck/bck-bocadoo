import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiHeader } from '@nestjs/swagger';

export type Rol = 'DUENO' | 'CAJERO';
export const ROLES_KEY = 'roles';

/**
 * Endpoint de un restaurante: exige el encabezado x-restaurant-id (public_id), que el usuario
 * trabaje ahí y que su rol esté en la lista. Fija el tenant del request para RLS.
 */
export const Roles = (...roles: Rol[]) =>
  applyDecorators(
    SetMetadata(ROLES_KEY, roles),
    ApiBearerAuth(),
    ApiHeader({ name: 'x-restaurant-id', required: true, description: 'public_id (UUID) del restaurante activo' }),
    ApiForbiddenResponse({ description: 'No trabajas en ese restaurante o tu rol no alcanza' }),
  );
