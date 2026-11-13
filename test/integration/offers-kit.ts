/** Cuerpo de una oferta válida para las pruebas; `extra` pisa los campos. */
export const offer = (extra: object = {}) => ({
  titulo: 'Churrasco a mitad de tarde',
  descripcion: 'Últimos churrascos del día',
  precioCentavos: 450,
  precioOriginalCentavos: 650,
  stock: 5,
  duracionMinutos: 60,
  ...extra,
});
