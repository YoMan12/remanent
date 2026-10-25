// Odbiera z aplikacji Remanent pliki (CSV, XLSX) i wysyła je mailem z Twojego konta Google.
// Prowadzi też kolejkę remanentów w arkuszu, z której co minutę pobiera je kontener art-repricer.
// Instrukcja w README.md obok.

// Klucze NIE są w kodzie — Ustawienia projektu → Właściwości skryptu:
//   KLUCZ_TELEFON  — ten sam co w aplikacji (⚙ → Klucz wysyłki)
//   KLUCZ_KONTENER — ten sam co REMANENT_GAS_KEY w .env kontenera
const P = PropertiesService.getScriptProperties();

const ALARM_DO = 'jacek@lim-czestochowa.com.pl';
const ALARM_PO_MIN = 30;

const TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
// rewizja: licznik podmian z telefonu — kontener odsyła ją w „zakoncz”, żeby nie zamknąć nowszej wersji starymi danymi
const KOLUMNY = ['id', 'zakonczono', 'tryb', 'pozycje', 'to', 'status', 'przyjeto', 'zmieniono', 'podsumowanie', 'blad', 'alarm', 'rewizja'];
const K = Object.fromEntries(KOLUMNY.map((k, i) => [k, i]));
const STATUSY_KONCOWE = ['test', 'zapisany', 'blad', 'recznie'];

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    return d.akcja ? kontener(d) : telefon(d);
  } catch (err) {
    return out(false, String(err.message || err));
  }
}

// Wejście na adres skryptu w przeglądarce — szybki test, że wdrożenie działa
function doGet() {
  return out(false, 'Dozwolony tylko POST');
}

/* ---------- Aplikacja na telefonie ---------- */
function telefon(d) {
  if (!kluczOk(d.key, 'KLUCZ_TELEFON')) return out(false, 'Zły klucz wysyłki');
  const to = String(d.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return out(false, 'Błędny adres e-mail');
  const files = (d.files || []).slice(0, 4).map(f => {
    const name = String(f.name).replace(/[^A-Za-z0-9_.-]/g, '_');
    const ext = name.split('.').pop().toLowerCase();
    if (!TYPES[ext]) throw new Error('Niedozwolony typ pliku');
    return Utilities.newBlob(Utilities.base64Decode(f.data), TYPES[ext], name);
  });
  if (!files.length) return out(false, 'Brak plików');
  // Najpierw kolejka, potem mail: gdy mail się nie uda, telefon ponowi z tym samym id i nic się nie zdubluje
  if (d.remanent) zapiszRemanent(d.remanent, to);
  MailApp.sendEmail({
    to: to,
    subject: String(d.subject || 'Remanent').slice(0, 150),
    body: String(d.body || '').slice(0, 4000),
    name: 'Remanent',
    attachments: files
  });
  return out(true);
}

function zapiszRemanent(r, to) {
  if (r.wersja !== 1) throw new Error('Nieobsługiwana wersja danych remanentu');
  const id = String(r.id || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error('Błędny identyfikator remanentu');
  if (r.tryb !== 'pelny' && r.tryb !== 'czesciowy') throw new Error('Błędny tryb remanentu');
  const poz = (r.pozycje || []).map(p => {
    const ean = String(p.ean || '');
    const ilosc = Number(p.ilosc);
    if (!/^\d{8,14}$/.test(ean) || !Number.isInteger(ilosc) || ilosc < 0) throw new Error('Błędna pozycja: ' + ean);
    return ean + ':' + ilosc;
  });
  if (!poz.length) throw new Error('Remanent bez pozycji');
  const wiersz = [id, String(r.zakonczono || ''), r.tryb, poz.join(';'), to, 'nowy', teraz(), teraz(), '', '', '', '1'];

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = arkusz();
    const n = znajdz(sh, id);
    if (!n) { sh.appendRow(wiersz); return; }
    // Ponowienie tego samego remanentu: podmieniamy dane, dopóki kontener go nie przetworzył
    const stary = sh.getRange(n, 1, 1, KOLUMNY.length).getValues()[0];
    if (stary[K.status] !== 'nowy') throw new Error('Ten remanent został już przetworzony (' + stary[K.status] + ') — zresetuj listę');
    wiersz[K.rewizja] = String((Number(stary[K.rewizja]) || 1) + 1);
    sh.getRange(n, 1, 1, wiersz.length).setValues([wiersz]);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Kontener art-repricer ---------- */
function kontener(d) {
  if (!kluczOk(d.key, 'KLUCZ_KONTENER')) return out(false, 'Zły klucz kontenera');
  if (d.akcja === 'pobierz') return out(true, '', {remanenty: nowe()});
  if (d.akcja === 'zakoncz') return zakoncz(d);
  return out(false, 'Nieznana akcja');
}

function nowe() {
  const sh = arkusz();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, KOLUMNY.length).getValues()
    .filter(w => w[K.status] === 'nowy')
    .sort((a, b) => String(a[K.przyjeto]).localeCompare(String(b[K.przyjeto])))
    .map(w => ({
      wersja: 1,
      id: String(w[K.id]),
      tryb: w[K.tryb],
      zakonczono: String(w[K.zakonczono]),
      przyjeto: String(w[K.przyjeto]),   // zegar GAS — kontener porównuje z zegarem telefonu
      rewizja: Number(w[K.rewizja]),
      to: w[K.to],
      pozycje: String(w[K.pozycje]).split(';').map(p => {
        const [ean, ilosc] = p.split(':');
        return {ean: ean, ilosc: Number(ilosc)};
      })
    }));
}

function zakoncz(d) {
  if (!STATUSY_KONCOWE.includes(d.status)) return out(false, 'Błędny status');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = arkusz();
    const n = znajdz(sh, String(d.id || ''));
    if (!n) return out(false, 'Nie ma remanentu o tym id');
    // Telefon podmienił pozycje w trakcie przetwarzania — status zostaje „nowy”, kontener weźmie nową wersję
    if (String(sh.getRange(n, K.rewizja + 1).getValue()) !== String(d.rewizja)) return out(false, 'Zmieniona rewizja');
    sh.getRange(n, K.status + 1).setValue(d.status);
    sh.getRange(n, K.zmieniono + 1, 1, 3).setValues([[
      teraz(), d.podsumowanie ? JSON.stringify(d.podsumowanie) : '', String(d.blad || '')
    ]]);
    return out(true);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Alarm: kontener nie odebrał remanentu ---------- */
// Wyzwalacz czasowy co 15 min, zakładany funkcją ustaw()
function alarm() {
  if (wOknie(new Date())) return;   // kontener celowo czeka do końca okna zamówień InnPro
  const sh = arkusz();
  if (sh.getLastRow() < 2) return;
  const w = sh.getRange(2, 1, sh.getLastRow() - 1, KOLUMNY.length).getValues();
  const limit = Date.now() - ALARM_PO_MIN * 60000;
  w.forEach((r, i) => {
    if (r[K.status] !== 'nowy' || r[K.alarm] || new Date(r[K.przyjeto]).getTime() > limit) return;
    MailApp.sendEmail(ALARM_DO, 'Remanent nie został odebrany przez kontener',
      `Remanent ${r[K.id]} (przyjęty ${r[K.przyjeto]}) czeka w kolejce dłużej niż ${ALARM_PO_MIN} min.\n` +
      `Sprawdź, czy kontener art-repricer działa. Arkusz kolejki: ${sh.getParent().getUrl()}`);
    sh.getRange(i + 2, K.alarm + 1).setValue(teraz());
  });
}

// Dni robocze 13:45–14:45: okno zamówień InnPro (13:45–14:30) plus kwadrans na odebranie po nim
function wOknie(d) {
  const dz = d.getDay(), m = d.getHours() * 60 + d.getMinutes();
  return dz >= 1 && dz <= 5 && m >= 13 * 60 + 45 && m < 14 * 60 + 45;
}

/* ---------- Jednorazowa konfiguracja: uruchom ręcznie w edytorze ---------- */
function ustaw() {
  const brak = ['KLUCZ_TELEFON', 'KLUCZ_KONTENER'].filter(k => !P.getProperty(k));
  if (brak.length) throw new Error('Brak właściwości skryptu: ' + brak.join(', '));
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'alarm')) {
    ScriptApp.newTrigger('alarm').timeBased().everyMinutes(15).create();
  }
  Logger.log('Arkusz kolejki: ' + arkusz().getParent().getUrl());
}

/* ---------- Pomocnicze ---------- */
function arkusz() {
  let id = P.getProperty('ARKUSZ_ID');
  if (id) return SpreadsheetApp.openById(id).getSheets()[0];
  const ss = SpreadsheetApp.create('Remanent — kolejka');
  const sh = ss.getSheets()[0];
  sh.setName('kolejka');
  sh.getRange('A:L').setNumberFormat('@');   // wszystko tekstem: EAN-y i daty bez autokonwersji
  sh.appendRow(KOLUMNY);
  sh.setFrozenRows(1);
  P.setProperty('ARKUSZ_ID', ss.getId());
  return sh;
}

function znajdz(sh, id) {
  if (sh.getLastRow() < 2) return 0;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  const i = ids.findIndex(r => String(r[0]) === id);
  return i < 0 ? 0 : i + 2;
}

function kluczOk(podany, nazwa) {
  const k = P.getProperty(nazwa);
  return !!k && podany === k;
}

function teraz() {
  return Utilities.formatDate(new Date(), 'Europe/Warsaw', "yyyy-MM-dd'T'HH:mm:ssXXX");   // ISO ze strefą
}

function out(ok, error, dane) {
  return ContentService
    .createTextOutput(JSON.stringify(ok ? Object.assign({ok: true}, dane) : {ok: false, error: error}))
    .setMimeType(ContentService.MimeType.JSON);
}
