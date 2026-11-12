import { Transform } from 'class-transformer';

/** Texto libre: normaliza Unicode a NFC y recorta espacios. No usar en contraseñas ni tokens. */
export const Text = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.normalize('NFC').trim() : value));

/** Correo: igual que Text, y en minúsculas. */
export const Email = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase() : value,
  );
