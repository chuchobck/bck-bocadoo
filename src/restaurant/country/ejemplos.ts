import { rucValido } from './ec';

/** Dígito verificador módulo 10 de los 9 primeros. */
const verificador10 = (nueve: string) => {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const p = Number(nueve[i]) * (i % 2 === 0 ? 2 : 1);
    sum += p > 9 ? p - 9 : p;
  }
  return (10 - (sum % 10)) % 10;
};

/**
 * RUC de persona natural generado (no es de nadie real): provincia 17, cuerpo inventado, verificador calculado y
 * establecimiento 001. Se usa en los ejemplos del OpenAPI y se comprueba con el mismo validador que la API.
 */
export function ejemploCedulaRuc(): string {
  const nueve = '170000099';
  const ruc = `${nueve}${verificador10(nueve)}001`;
  if (!rucValido(ruc)) throw new Error('El ejemplo de cedulaRuc no pasa el validador');
  return ruc;
}
