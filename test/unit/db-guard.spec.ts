import { describe, expect, it } from 'vitest';
import { describeTarget, hostsOf, isLocalHost, nonLocalDbTargets } from '../../scripts/db-guard.mjs';

const NEON = 'postgresql://neondb_owner:secreto@ep-falso-123456.us-east-2.aws.neon.tech/neondb?sslmode=require';
const LOCAL = 'postgresql://postgres:postgres@localhost:55432/bocadoo?sslmode=disable';

describe('isLocalHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.10.0.254',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '/var/run/postgresql',
  ])('acepta %s', (h) => expect(isLocalHost(h)).toBe(true));

  it.each([
    '',
    '   ',
    'ep-falso-123456.us-east-2.aws.neon.tech',
    'localhost.neon.tech',
    'mi-localhost',
    'localhost.',
    '127.0.0.256',
    '127.1',
    '0.0.0.0',
    '10.0.0.5',
    '::',
    '2600:1f18::1',
    '[2600:1f18::1]',
    '::ffff:10.0.0.1',
  ])('rechaza %j', (h) => expect(isLocalHost(h)).toBe(false));

  it('rechaza lo que no es texto', () => {
    expect(isLocalHost(undefined)).toBe(false);
    expect(isLocalHost(null)).toBe(false);
  });
});

describe('hostsOf: host parseado, nunca búsqueda de texto', () => {
  it('URL de Neon con "localhost:55432" en la query: el host sigue siendo Neon', () => {
    const url = `${NEON}&x=localhost:55432`;
    expect(url).toContain('localhost:55432');
    expect(hostsOf(url)).toEqual(['ep-falso-123456.us-east-2.aws.neon.tech']);
    expect(nonLocalDbTargets({ DATABASE_URL: url })).toEqual([
      { key: 'DATABASE_URL', motivo: 'host ep-falso-123456.us-east-2.aws.neon.tech' },
    ]);
  });

  it('"localhost" como usuario, contraseña, base o fragmento no cuenta', () => {
    for (const url of [
      'postgresql://localhost@ep-falso.neon.tech/db',
      'postgresql://u:localhost@ep-falso.neon.tech/db',
      'postgresql://u@ep-falso.neon.tech/localhost',
      'postgresql://u@ep-falso.neon.tech/db#@localhost:55432',
    ]) {
      expect(hostsOf(url)).toEqual(['ep-falso.neon.tech']);
    }
  });

  it('?host= pisa al host de la URL en pg: se revisan los dos', () => {
    expect(hostsOf('postgresql://u@localhost:55432/db?host=ep-falso.neon.tech')).toEqual(['localhost', 'ep-falso.neon.tech']);
    expect(nonLocalDbTargets({ PROBE_DATABASE_URL: 'postgresql://u@localhost:55432/db?host=ep-falso.neon.tech' })).toHaveLength(1);
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u@localhost/db?hostaddr=3.3.3.3' })).toHaveLength(1);
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u@localhost/db?host=/var/run/postgresql' })).toEqual([]);
  });

  it('IPv6: [::1] es local y una IPv6 pública no', () => {
    expect(hostsOf('postgresql://u@[::1]:55432/db')).toEqual(['[::1]']);
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u@[::1]:55432/db' })).toEqual([]);
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u@[0:0:0:0:0:0:0:1]:55432/db' })).toEqual([]);
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u@[::ffff:127.0.0.1]/db' })).toEqual([]);
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u@[2600:1f18::1]:5432/db' })).toEqual([
      { key: 'DATABASE_URL', motivo: 'host [2600:1f18::1]' },
    ]);
  });

  it('socket Unix (codificado en la URL o en la forma corta de pg) es local', () => {
    expect(hostsOf('postgresql://u@%2Fvar%2Frun%2Fpostgresql/db')).toEqual(['/var/run/postgresql']);
    expect(hostsOf('/var/run/postgresql bocadoo')).toEqual(['/var/run/postgresql']);
  });

  it('varios hosts: basta uno remoto para rechazar; con puertos ni se parsea (también rechaza)', () => {
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u@localhost,ep-falso.neon.tech/db' })).toHaveLength(1);
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u@localhost:5432,ep-falso.neon.tech:5432/db' })).toEqual([
      { key: 'DATABASE_URL', motivo: 'no es una URL de conexión válida' },
    ]);
  });

  it('sin host, ilegible o con otro protocolo: rechaza (falla cerrado)', () => {
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u:p@/db' })).toHaveLength(1);
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql:///db' })).toEqual([{ key: 'DATABASE_URL', motivo: 'sin host explícito' }]);
    expect(nonLocalDbTargets({ DATABASE_URL: 'postgresql://u@[zz]/db' })).toHaveLength(1);
  });
});

describe('nonLocalDbTargets: qué variables mira', () => {
  it('todo local: nada que reportar', () => {
    expect(
      nonLocalDbTargets({
        DATABASE_URL: LOCAL,
        DATABASE_SERVICE_URL: 'postgresql://bck_servicio:svcpw@127.0.0.1:55432/bocadoo',
        DATABASE_MIGRATE_URL: LOCAL,
        PROBE_DATABASE_URL: LOCAL,
        PGHOST: 'localhost',
      }),
    ).toEqual([]);
  });

  it('cualquier DATABASE_* o PROBE_* con URL, no solo las conocidas', () => {
    const bad = nonLocalDbTargets({ DATABASE_URL: LOCAL, DATABASE_MIGRATE_URL: NEON, PROBE_OTRA_URL: NEON, OTRA_URL: NEON });
    expect(bad.map((b) => b.key)).toEqual(['DATABASE_MIGRATE_URL', 'PROBE_OTRA_URL']);
  });

  it('PGHOST y PGHOSTADDR (también listas separadas por coma)', () => {
    expect(nonLocalDbTargets({ PGHOST: 'ep-falso.neon.tech' })).toEqual([{ key: 'PGHOST', motivo: 'host ep-falso.neon.tech' }]);
    expect(nonLocalDbTargets({ PGHOST: 'localhost,ep-falso.neon.tech' })).toEqual([{ key: 'PGHOST', motivo: 'host ep-falso.neon.tech' }]);
    expect(nonLocalDbTargets({ PGHOST: '/var/run/postgresql' })).toEqual([]);
    expect(nonLocalDbTargets({ PGHOST: '::1' })).toEqual([]);
    expect(nonLocalDbTargets({ PGHOSTADDR: '3.3.3.3' })).toHaveLength(1);
  });

  it('variables vacías o que no son URLs no deciden el destino', () => {
    expect(nonLocalDbTargets({ DATABASE_URL: '', PROBE_DATABASE_URL: undefined, DATABASE_POOL_MAX: '10', PGHOST: '' })).toEqual([]);
  });

  it('nunca incluye la contraseña en el motivo', () => {
    expect(JSON.stringify(nonLocalDbTargets({ DATABASE_URL: NEON }))).not.toContain('secreto');
  });
});

describe('describeTarget', () => {
  it('muestra host, puerto y base, sin credenciales', () => {
    expect(describeTarget(LOCAL)).toBe('localhost:55432/bocadoo');
    expect(describeTarget(NEON)).toBe('ep-falso-123456.us-east-2.aws.neon.tech/neondb');
    expect(describeTarget('postgresql://u:p@localhost/db?host=ep-falso.neon.tech')).toBe('localhost/db (host=ep-falso.neon.tech)');
  });
});
